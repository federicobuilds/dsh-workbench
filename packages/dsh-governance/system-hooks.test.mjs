import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySystemHooks, checkSearchScope, resolvePromptAdditions, SCOPE_REFUSAL, isCanonicalFable, applyFableKeyHeader } from './system-hooks.mjs';
import { apply as applyCredentialRouter } from '../dsh-credential-router/index.mjs';
import { createJudgeClient, AUDIT_QUESTIONS } from './judge.mjs';
import { apply } from './index.mjs';
import { VERIFICATION_DOMAIN_SPEC } from './verification.mjs';
import { RESOURCE_DOMAIN_SPEC } from './resource.mjs';

const HOME = homedir();

test('resolvePromptAdditions injects rules, caches HUMAN_STYLE vs AGENT_WIRE per session, and adds model notes', () => {
  const sessionStyles = new Map();
  const topAgent = { session: { id: 's-top', header: {} } };
  const subAgent = { session: { id: 's-sub', header: { origin: 'subagent', parentSession: 's-top' } } };
  const writerAgent = { session: { id: 's-writer', header: { agentPreset: 'dsh-agent-brilliant-writer' } } };

  const topText = resolvePromptAdditions({ agent: topAgent, modelSelection: { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' } }, { sessionStyles });
  assert.match(topText, /Bash Discipline/);
  assert.match(topText, /Karpathy behavioral guidelines/);
  assert.match(topText, /Answer first, in one sentence/);
  assert.match(topText, /Opus 5\.5/i);

  const subText = resolvePromptAdditions({ agent: subAgent, modelSelection: { provider: 'openrouter', model: 'anthropic/claude-fable-5.1' } }, { sessionStyles });
  assert.match(subText, /<agent_messages>|reporting to another agent/i);
  assert.match(subText, /Fable/i);

  const writerText = resolvePromptAdditions({ agent: writerAgent, modelSelection: { provider: 'openrouter', model: 'moonshotai/kimi-k3.1-pro' } }, { sessionStyles });
  assert.equal(sessionStyles.get('s-writer'), '');
  assert.match(writerText, /Bash Discipline/);
});

test('checkSearchScope refuses broad roots and traversal globs, and allows bounded workspace paths', async () => {
  assert.equal(await checkSearchScope('read', { file_path: HOME }, HOME), SCOPE_REFUSAL);
  assert.equal(await checkSearchScope('grep', { path: '/' }, HOME), SCOPE_REFUSAL);
  assert.equal(await checkSearchScope('glob', { path: `${HOME}/Library`, pattern: '*.ts' }, HOME), SCOPE_REFUSAL);
  assert.equal(await checkSearchScope('glob', { path: `${HOME}/project`, pattern: '../**/*.ts' }, HOME), SCOPE_REFUSAL);
  assert.equal(await checkSearchScope('glob', { path: `${HOME}/project`, pattern: '/etc/*' }, HOME), SCOPE_REFUSAL);
  assert.equal(await checkSearchScope('dsh_search_workspace', { root: '' }, `${HOME}/Library/Mobile Documents/workspace-project`), SCOPE_REFUSAL);

  assert.equal(await checkSearchScope('grep', { path: `${HOME}/project/src` }, HOME), null);
  assert.equal(await checkSearchScope('glob', { path: `${HOME}/project/src`, pattern: '**/*.ts' }, HOME, {
    judge: { decide: async () => ({ decision: 'allow' }) },
  }), null);
  assert.equal(await checkSearchScope('glob', { path: `${HOME}/project/src`, pattern: '**/*.ts' }, HOME, {
    judge: { decide: async () => ({ decision: 'deny' }) },
  }), SCOPE_REFUSAL);
});

test('auditor-tier seats evaluate AUDIT_QUESTIONS and enforce easy vs hard match', async () => {
  const brief = JSON.stringify({
    unit: 'U-AUD-1',
    objective: 'Inspect service logs and report status',
    scope: ['logs/app.log'],
    acceptance: ['status reported'],
    changes: 'read-only',
    risk: 'low',
  });
  const easyClient = createJudgeClient({
    authorizeOperation: () => true,
    transport: async ({ body }) => {
      assert.deepEqual(Object.keys(body.questions), Object.keys(AUDIT_QUESTIONS));
      return {
        model: body.model,
        answers: {
          scope_clear: { type: 'noul', noul: 0.9 },
          causal_diagnosis: { type: 'noul', noul: 0.1 },
          conflicting_evidence: { type: 'noul', noul: 0.1 },
          unknown_interaction: { type: 'noul', noul: 0.1 },
        },
      };
    },
  });
  const ok = await easyClient.decide({ family: 'simple', brief, seat: 'auditor-s' });
  assert.equal(ok.status, 'decision');
  assert.equal(ok.tier, 'easy');
  assert.equal(ok.requiredDecisionSatisfied, true);

  const mismatch = await easyClient.decide({ family: 'simple', brief, seat: 'auditor-s-max' });
  assert.equal(mismatch.status, 'refused');
  assert.equal(mismatch.reason, 'required-tier-or-risk-mismatch');
  assert.equal(mismatch.tier, 'easy');
  assert.equal(mismatch.requestedTier, 'hard');
});

test('full dsh-governance apply never registers a Promise-returning guard on synchronous tools.guard', async () => {
  const guards = [];
  const preExecute = [];
  const registered = new Map();
  const ctx = {
    effect: () => {},
    on: (name, fn) => { if (name === 'tools/pre-execute') preExecute.push(fn); return () => {}; },
    get: (name) => {
      if (name === 'tools') return {
        register: (def) => { registered.set(def.name, def); return () => {}; },
        guard: (fn) => { guards.push(fn); return () => {}; },
      };
      if (name === 'agents') return { get: () => undefined };
      if (name === 'agentPresets') return { presetForSession: () => null };
      if (name === 'llm') return { resolveModelInfo: async () => null };
      if (name === 'systemPrompt') return { section: () => () => {} };
      return undefined;
    },
  };
  const dispose = await apply(ctx, {});
  assert.ok(guards.length >= 2, 'synchronous guards registered');
  assert.ok(preExecute.length >= 3, 'async checks registered on tools/pre-execute');
  for (const g of guards) assert.notEqual(g.constructor.name, 'AsyncFunction', 'no async guard reaches tools.guard');
  for (const g of guards) {
    const out = g({ name: 'working_directory', arguments: {}, agent: { session: { id: 's-1', header: { cwd: HOME } } } });
    assert.equal(out, undefined, 'every synchronous guard returns undefined on allowed calls, never a Promise');
  }
  assert.match(guards[0]({ get name() { throw new Error('fixture'); } }), /guard.*fail/i);
  await dispose();
});

test('modular switches disable bundled tools, domains, and hooks', async () => {
  async function start(config) {
    const registered = [];
    const domains = [];
    const guards = [];
    const hooks = [];
    const tools = {
      register: (def) => { registered.push(def.name); return () => {}; },
      guard: (fn) => { guards.push(fn); return () => {}; },
    };
    const ctx = {
      effect: () => {},
      on: (name) => { hooks.push(name); return () => {}; },
      get: (name) => {
        if (name === 'tools') return tools;
        if (name === 'storageDomain') return { get: () => undefined, open: async (spec) => { domains.push(spec.name); return null; } };
        if (name === 'agents') return { get: () => undefined };
        if (name === 'agentPresets') return { presetForSession: () => null };
        if (name === 'llm') return { resolveModelInfo: async () => null };
        if (name === 'systemPrompt') return { section: () => () => {} };
        return undefined;
      },
    };
    const dispose = await apply(ctx, config);
    return { registered, domains, guards, hooks, dispose };
  }
  const bundled = await start({});
  const modular = await start({ disableBundledMcpGate: true, disableBundledVerificationLedger: true, disableBundledMemoryViewer: true });
  for (const name of ['check', 'resource', 'efficiency_override', 'memory_preview']) {
    assert.ok(bundled.registered.includes(name), `${name} registered by default`);
    assert.ok(!modular.registered.includes(name), `${name} not registered when disabled`);
  }
  for (const name of [VERIFICATION_DOMAIN_SPEC.name, RESOURCE_DOMAIN_SPEC.name]) {
    assert.ok(bundled.domains.includes(name), `${name} opened by default`);
    assert.ok(!modular.domains.includes(name), `${name} not opened when disabled`);
  }
  assert.ok(bundled.guards.length > modular.guards.length);
  assert.ok(bundled.hooks.length > modular.hooks.length);
  await bundled.dispose();
  await modular.dispose();
});

test('scope context rejection refuses without invoking the next handler', async () => {
  let hook, calls = 0;
  const ctx = { get: name => name === 'workingDirectory' ? { ensure: async () => { throw new Error('fixture'); } } : undefined,
    on: (name, fn) => { if (name === 'tools/pre-execute') hook = fn; return () => {}; } };
  applySystemHooks(ctx);
  const result = await hook({ name: 'grep', arguments: {}, agent: { session: { id: 's' } } }, () => { calls++; });
  assert.equal(result.kind, 'deny');
  assert.equal(calls, 0);
  assert.equal(await hook({ name: 'bash' }, () => 'allowed'), 'allowed');
});

test('isCanonicalFable and applyFableKeyHeader only route no-ZDR key for OpenRouter Fable 5.1', () => {
  assert.equal(isCanonicalFable('anthropic/claude-fable-5.1', true), true);
  assert.equal(isCanonicalFable('anthropic/claude-fable-5.1', false), false);
  assert.equal(isCanonicalFable('openrouter/anthropic/claude-fable-5.1', false), true);
  assert.equal(isCanonicalFable('google/gemini-4-argon', true), false);

  const missingPath = join(fileURLToPath(new URL('../dsh-credential-router/', import.meta.url)), 'missing-fixture-key');
  const nonFableHeaders = new Headers();
  applyFableKeyHeader({ provider: 'openrouter', model: 'google/gemini-4-argon' }, nonFableHeaders, missingPath);
  assert.equal(nonFableHeaders.get('Authorization'), null);

  assert.throws(
    () => applyFableKeyHeader({ provider: 'openrouter', model: 'anthropic/claude-fable-5.1' }, new Headers(), missingPath),
    /Fable requires its dedicated OpenRouter key/,
  );
});

test('disabled bundled router leaves requests alone and standalone routing runs once', () => {
  const dir = mkdtempSync(join(fileURLToPath(new URL('../dsh-credential-router/', import.meta.url)), '.hooks-test-'));
  try {
    const keyFile = join(dir, 'route');
    writeFileSync(keyFile, 'route-alpha-token', { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const hooks = [];
    const ctx = { on: (name, fn) => { if (name === 'llm-pi-ai/request-headers') hooks.push(fn); return () => {}; }, get: () => undefined };
    applySystemHooks(ctx, null, { disableBundledCredentialRouter: true });
    const original = { Authorization: 'existing' };
    let calls = 0;
    const run = (request, headers) => {
      const next = index => index < hooks.length ? hooks[index](request, headers, () => next(index + 1)) : (++calls, 'continued');
      return next(0);
    };
    assert.equal(run({ provider: 'openrouter', model: 'claude-fable-5.1' }, original), 'continued');
    assert.deepEqual(original, { Authorization: 'existing' });
    assert.equal(calls, 1);
    assert.equal(hooks.length, 0);

    const config = { destinations: { alpha: { keyFile } }, defaultDestination: 'passthrough', rules: [{ provider: 'openrouter', destination: 'alpha' }] };
    applyCredentialRouter(ctx, config);
    const headers = new Headers();
    assert.equal(run({ provider: 'openrouter', model: 'claude-fable-5.1' }, headers), 'continued');
    assert.equal(hooks.length, 1);
    assert.equal(calls, 2);
    assert.equal(headers.get('authorization'), `Bearer ${'route-alpha-token'}`);

    const bundledHooks = [];
    applySystemHooks({ on: (name, fn) => { if (name === 'llm-pi-ai/request-headers') bundledHooks.push(fn); return () => {}; }, get: () => undefined }, null, { credentialRouter: config });
    const bundledHeaders = new Headers();
    let bundledCalls = 0;
    bundledHooks[0]({ provider: 'openrouter' }, bundledHeaders, () => bundledCalls++);
    assert.equal(bundledCalls, 1);
    assert.equal(bundledHeaders.get('authorization'), `Bearer ${'route-alpha-token'}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
