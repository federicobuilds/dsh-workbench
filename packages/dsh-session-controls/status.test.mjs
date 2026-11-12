import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  const map = {
    '@dsh-workbench/dsh-governance/redaction': '../dsh-governance/redaction.mjs',
    '@dsh-workbench/dsh-governance/bindings': '../dsh-governance/bindings.mjs',
    '@dsh-workbench/dsh-governance/policy': '../dsh-governance/policy.mjs',
    '@dsh-workbench/dsh-governance/tracks': '../dsh-governance/tracks.mjs',
  };
  if (map[specifier]) return { url: new URL(map[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { readHarnessStatus, readWorkspaceIndexStatus } = await import('./status.mjs');
const { switchSessionRole, applyBindings } = await import('../dsh-governance/bindings.mjs');
const nativeSession = new URL(import.meta.resolve('@deepseek-ai/dsh-session'));
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-session' && context.parentURL?.includes('/dsh-governance/bindings.mjs')) return { url: nativeSession.href, shortCircuit: true };
  return next(specifier, context);
} });
const { Session } = await import(nativeSession.href);

const caller = { session: { id: 'owned-session' }, model: { current: () => ({ provider: 'openrouter', model: 'qwen/qwen3.8-2.4t-a95b' }) } };
const record = { v: 1, id: 'event-1', session: 'owned-session', ts: 1, kind: 'judge', decision: 'refused', reason: 'Tier mismatch', tier: 'default', requestedTier: 'cheap', brief: 'NEVER RETURN THIS' };

function ctx(records, open = true) {
  return {
    get(name) {
      if (name === 'agentPresets') return { presetForSession: () => 'dsh-coordinator-simple' };
      if (name === 'storageDomain') return { get: domain => domain === 'dsh_governance_events' && open ? { table: () => ({ entries: () => records.map((r, i) => [String(i), r]) }) } : undefined };
    },
  };
}

test('status is strictly caller-session scoped and excludes prompts/wire details', () => {
  const value = readHarnessStatus(ctx([record, { ...record, id: 'private', session: 'other-session' }]), caller);
  assert.equal(value.decisions.length, 1);
  assert.equal(value.decisions[0].requestedTier, 'cheap');
  assert.equal(value.counts.total, 1);
  assert.equal(value.counts.blocked, 1);
  assert.equal(value.counts.judge, 1);
  assert.ok(!JSON.stringify(value).includes('NEVER RETURN THIS'));
  assert.ok(!JSON.stringify(value).includes('private'));
  assert.equal(value.logReady, true);
  assert.equal(value.partial, false);
  assert.equal(value.controls.roleSwitch, true);
  assert.equal(value.track, 'simple');
});

test('partial indicates whether caller decisions exceed the 60 item limit', () => {
  const records = Array.from({ length: 61 }, (_, i) => ({ ...record, id: `event-${i}`, ts: i }));
  const exact = readHarnessStatus(ctx(records.slice(0, 60)), caller);
  assert.equal(exact.partial, false);
  assert.equal(exact.decisions.length, 60);
  const truncated = readHarnessStatus(ctx(records), caller);
  assert.equal(truncated.partial, true);
  assert.equal(truncated.decisions.length, 60);
  assert.equal(truncated.counts.total, 61);
  assert.equal(truncated.decisions[0].ts, 60);
});

test('confirmed track/revision override the preset without changing the displayed model', () => {
  const c = ctx([]);
  const baseGet = c.get;
  c.get = name => name === 'storageDomain' ? { get: domain => domain === 'dsh_worker_tracks' ? { table: () => ({ get: () => ({ sessionId: 'owned-session', mode: 'advanced', revision: 3 }) }) } : undefined } : baseGet(name);
  const value = readHarnessStatus(c, caller);
  assert.equal(value.track, 'advanced');
  assert.equal(value.trackRevision, 3);
  assert.equal(value.controls.trackSwitch, true);
  assert.equal(value.model.model, 'qwen/qwen3.8-2.4t-a95b');
});

test('mid-session role switch updates role and displays assigned model', async () => {
  let selectedModel = { provider: 'openrouter', model: 'qwen/qwen3.8-2.4t-a95b' };
  const services = { agents: {}, agentPresets: { presetForSession: () => 'dsh-coordinator-simple' }, llm: { resolveModelInfo: async () => ({}) },
    sessionProjections: { register: async () => ({}) } };
  const roleCtx = { get: name => services[name] ?? ctx([]).get(name), on() {} };
  applyBindings(roleCtx);
  const agent = {
    session: Session.create('role-switch-session'),
    model: {
      current: () => selectedModel,
      select: async sel => { selectedModel = sel; },
    },
  };
  await switchSessionRole(roleCtx, agent, 'dsh-coder');
  const status = readHarnessStatus(ctx([]), agent);
  assert.equal(status.preset, 'dsh-coder');
  assert.equal(status.model.model, 'moonshotai/kimi-k3.1-pro');
});

test('workspace readiness preserves missing, stale, corrupt and ready native states', async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await readWorkspaceIndexStatus(ctx([]), caller, signal), { status: 'unavailable' });
  for (const native of [
    { status: 'ok', indexed: false, stale: true, dirty: false, fingerprintMismatch: false, lastIndexedAt: null },
    { status: 'ok', indexed: true, stale: true, dirty: false, fingerprintMismatch: true, lastIndexedAt: 12 },
    { status: 'error', reason: 'corrupt-index', action: 'rebuild', root: '/workspace' },
    { status: 'corrupt', reason: 'corrupt-index' },
    { status: 'ok', indexed: true, stale: false, dirty: false, fingerprintMismatch: false, lastIndexedAt: 13 },
  ]) {
    const c = { get: name => name === 'dshWorkspaceIndex' ? { status: async (agent, actualSignal) => {
      assert.equal(agent, caller); assert.equal(actualSignal, signal); return native;
    } } : undefined };
    const expected = native.status === 'ok' && !native.indexed
      ? { ...native, state: 'ok', label: 'Index: not indexed' } : native;
    assert.deepEqual(await readWorkspaceIndexStatus(c, caller, signal), expected);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readWorkspaceIndexStatus(ctx([]), caller, controller.signal), { name: 'AbortError' });
});

test('direct UI status scrubs BSA, AWS and private-key canaries with the shared redactor', () => {
  const pem = ['-----BEGIN ', 'PRIVATE KEY-----\nSYNTHETIC\n-----END ', 'PRIVATE KEY-----'].join('');
  const canaries = ['BSA'+'A'.repeat(25), 'AKIA'+'A'.repeat(16), pem];
  for (const secret of canaries) {
    const value = readHarnessStatus(ctx([{ ...record, reason: 'gate '+secret }]), caller);
    assert.ok(!JSON.stringify(value).includes(secret));
    assert.match(value.decisions[0].reason, /REDACTED/);
  }
});

test('missing store is unavailable, not fabricated empty/ready state; no caller is refused', () => {
  const value = readHarnessStatus(ctx([], false), caller, { isOwner: false });
  assert.equal(value.logReady, false);
  assert.equal(value.controls.roleSwitch, false);
  assert.equal(value.controls.trackSwitch, false);
  assert.deepEqual(value.decisions, []);
  assert.throws(() => readHarnessStatus(ctx([]), {}), /receiving session/);
});
