import test from 'node:test';
import assert from 'node:assert/strict';
import { createGovernanceFacade } from './facade-core.mjs';
import { QUESTIONS } from './judge.mjs';
import { decisionEvent, withLogOutcome } from './decision-events.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewStore, REVIEW_DOMAIN_SPEC } from './review-store.mjs';

const SECRET = 'sk-or-v1-' + 'SYNTHETICSECRET'.repeat(3);
const BRIEF = JSON.stringify({ unit: 'U-1', objective: 'Read fixture', scope: ['fixture.md'], acceptance: ['correct evidence'], risk: 'low', changes: 'No source changes' });
const ROSTER = { schema: 'dsh-role-roster-whitelist/v1', source_sha256: 'aa'.repeat(32), auth_prompt_mcp_values_excluded: true,
  providers: { openrouter: { baseURL: null, auth_values_excluded: true } },
  agents: ['executor-s-cheap', 'reviewer-s'].map(seat => ({ seat, enabled: true, configured_target: 'openrouter/xiaomi/mimo-v2.6-flash', configured_effort: null, mode: 'subagent' })) };

async function fixture({ tier = 'cheap', failEvent = () => false, drift = false, workerGuard, cwd = process.cwd() } = {}) {
  const records = new Map(), definitions = new Map(), logged = [];
  workerGuard ??= { setSnapshot() {}, async reserve(value) { this.reservation = value; }, async settle(id, status) { assert.equal(id, this.reservation.childId); this.status = status; } };
  const counts = { judge: 0, spawned: 0 };
  const agent = { id: 'S-1', session: { id: 'S-1' } };
  const sessions = new Map([['S-1', agent.session]]);
  const table = { entries: () => [...records], get: key => records.get(key),
    put: async (key, value) => { records.set(key, value); },
    update: async (key, transform) => { const value = transform(records.get(key)); records.set(key, value); return value; } };
  let open = false, closes = 0;
  const domain = { table: () => table, close: async () => { open = false; closes++; } };
  const services = {
    workingDirectory: { ensure: async () => cwd },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    tools: { register: def => { definitions.set(def.name, def); return () => {}; }, guard: () => () => {} },
    agentPresets: { presetForSession: session => session.header?.agentPreset ?? 'dsh-coordinator-simple', resolve: async id => ({ id }) },
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) },
    sessions: { get: id => sessions.get(id) },
    storageDomain: { open: async () => { if (open) throw new Error('already open'); open = true; return domain; }, get: () => open ? domain : undefined },
    subagents: { getProvider: name => name === 'spawn' ? { prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentPreset: true, agentOptions: true } } : null,
      startActivation: async spec => { assert.equal(workerGuard.reservation.childId, spec.childId); assert.equal(spec.provider, 'spawn');
        assert.equal(spec.delivery, 'parent'); assert.equal(typeof spec.label, 'string'); assert.ok(spec.signal instanceof AbortSignal);
        assert.equal(spec.request.parent, agent); assert.equal(spec.request.prompt[0].type, 'text');
        assert.equal(spec.request.cwd, cwd);
        assert.equal(spec.request.agentOptions.provider, 'openrouter'); assert.equal(spec.request.agentOptions.model, 'xiaomi/mimo-v2.6-flash');
        counts.spawned++; const childId = spec.childId; sessions.set(childId, { id: childId, header: { origin: 'subagent', parentSession: spec.request.parent.session.id, agentPreset: spec.request.agentPreset }, messages: [] }); return { childId }; } },
  };
  class Context { get(name) { return services[name]; } }
  const eventStore = { record: async event => { if (failEvent(event)) throw new Error(SECRET); logged.push(event); } };
  const facade = createGovernanceFacade({ roster: ROSTER, decisionStore: eventStore, requireDecisionLog: true, workerGuard,
    readSession: id => ({ id, metadata: { 'dsh-workbench.agent-access': { v: 1, mode: drift && counts.judge ? 'off' : 'simple', rev: drift && counts.judge ? 'policy-2' : 'policy-1' } } }),
    authorizeOperation: () => true,
    judgeTransport: async ({ body }) => {
      counts.judge++;
      const answers = Object.fromEntries(Object.keys(QUESTIONS).map(key => [key, { type: 'noul', noul: 0.05 }]));
      answers.risk_read_only.noul = 0.95; answers.tier_quick.noul = 0.95;
      if (tier === 'default') answers.tier_open.noul = 0.95;
      return { model: body.model, answers };
    } });
  const ctx = new Context();
  const dispose = await facade.apply(ctx);
  return { logged, counts, dispose, sessions, remount: () => facade.apply(ctx), get closes() { return closes; }, async dispatch(seat = 'executor-s-cheap') { return definitions.get('dsh_dispatch').execute({ seat, brief: BRIEF }, { agent }); },
    async review(args, caller = agent) { return definitions.get('dsh_review').execute(args, { agent: caller }); } };
}

test('judge denial is durably recorded with requested/required tier before any worker starts', async () => {
  const f = await fixture({ tier: 'default' });
  const result = await f.dispatch();
  assert.equal(result.status, 'refused'); assert.equal(f.counts.spawned, 0); assert.equal(f.counts.judge, 1);
  const judge = f.logged.find(event => event.kind === 'judge');
  assert.equal(judge.decision, 'refused'); assert.equal(judge.tier, 'default'); assert.equal(judge.requestedTier, 'cheap');
  assert.equal(judge.reasonCode, 'required-tier-or-risk-mismatch'); assert.equal(judge.unit, 'U-1'); assert.equal(judge.session, 'S-1');
  assert.ok(f.logged.some(event => event.kind === 'dispatch' && event.decision === 'refused'));
  assert.equal(result.decisionLog, 'recorded'); await f.dispose();
});

test('archive cwd is refused before spending a judge call or activating a worker', async () => {
  const f = await fixture({ cwd: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh' });
  const result = await f.dispatch();
  assert.equal(result.reason, 'invalid-working-directory');
  assert.equal(f.counts.judge, 0);
  assert.equal(f.counts.spawned, 0);
  await f.dispose();
});

test('failure to record the judge decision prevents worker activation without leaking log error', async () => {
  const f = await fixture({ failEvent: event => event.kind === 'judge' });
  const result = await f.dispatch();
  assert.equal(result.reason, 'decision-log-write-failed'); assert.equal(f.counts.spawned, 0);
  assert.ok(!JSON.stringify(result).includes(SECRET)); await f.dispose();
});

test('post-action log failure preserves the actual dispatched outcome', async () => {
  const f = await fixture({ failEvent: event => event.kind === 'dispatch' && event.decision === 'dispatched' });
  const result = await f.dispatch();
  assert.equal(f.counts.spawned, 1); assert.equal(result.status, 'dispatched'); assert.equal(result.delegated, true);
  assert.equal(result.decisionLog, 'write-failed'); assert.ok(!JSON.stringify(result).includes(SECRET)); await f.dispose();
});

test('Off selected while judge is running prevents the pending worker activation', async () => {
  const f = await fixture({ drift: true });
  const result = await f.dispatch();
  assert.equal(result.reason, 'track-changed-during-admission'); assert.equal(f.counts.spawned, 0);
  await f.dispose();
});

test('facade writes reserved native worker identity before activation and finalizes it', async () => {
  const guard = { setSnapshot(value) { this.snapshot = value; }, async reserve(value) { this.reservation = value; }, async settle(id, status) { assert.equal(id, this.reservation.childId); this.status = status; } };
  const f = await fixture({ workerGuard: guard }); const result = await f.dispatch();
  assert.equal(result.status, 'dispatched'); assert.equal(result.workerBinding, 'active'); assert.equal(guard.status, 'active');
  assert.equal(guard.reservation.parentId, 'S-1'); assert.equal(guard.reservation.seat, 'executor-s-cheap');
  assert.equal(guard.reservation.childId, result.childId); assert.equal(f.counts.spawned, 1); await f.dispose();
});

test('event metadata omits arbitrary detail/why/prompts and redacts known secret identifiers', () => {
  const event = decisionEvent('judge', { agent: { session: { id: 'session' } } }, {
    status: 'refused', reason: 'timeout-or-canceled', why: SECRET, detail: SECRET, brief: SECRET, probabilities: { prompt: SECRET },
  });
  assert.ok(!JSON.stringify(event).includes(SECRET));
  for (const key of ['why', 'detail', 'brief', 'probabilities']) assert.equal(Object.hasOwn(event, key), false);
  assert.equal(event.reasonCode, 'timeout-or-canceled'); assert.equal(event.permissionGranted, false);
  assert.equal(withLogOutcome({ status: 'dispatched' }, false).status, 'dispatched');
});

test('two review-store wrappers serialize concurrent first admissions on one domain', async () => {
  const records = new Map();
  const table = { entries: () => [...records], get: key => records.get(key),
    put: async (key, value) => { await Promise.resolve(); records.set(key, value); },
    update: async (key, fn) => { if (!records.has(key)) throw new Error('missing'); records.set(key, fn(records.get(key))); } };
  const domain = { table: () => table };
  const a = createReviewStore(domain), b = createReviewStore(domain);
  await Promise.all([a.applyAdmission({ id: 'one', unit: 'U-1', seat: 'executor-s-cheap', owner: 'S-1' }), b.applyAdmission({ id: 'two', unit: 'U-1', seat: 'executor-s-cheap', owner: 'S-1' })]);
  assert.equal(createReviewStore(domain).readState().units['U-1'].attempt, 2);
  await assert.rejects(b.applyAdmission({ id: 'bad', unit: 'U-1', seat: 'executor-s-cheap', owner: 'other' }), /owner/);
  await a.applyAdmission({ id: 'three', unit: 'U-1', seat: 'executor-s-cheap', owner: 'S-1' });
  assert.equal(createReviewStore({ table: () => table }).readState().units['U-1'].attempt, 3);
});

test('facade wrappers share an open review domain until the last disposer', async () => {
  const f = await fixture();
  const disposeSecond = await f.remount();
  await f.dispose();
  assert.equal(f.closes, 0);
  assert.equal((await f.dispatch()).status, 'dispatched');
  await disposeSecond();
  assert.equal(f.closes, 1);
});

test('native JSON domain reopens with concurrent admissions and escalation floor intact', async t => {
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  const directory = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new JsonStorageBackend(directory);
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {} } }, { backend: 'json' });
  const domain = await facility.open(REVIEW_DOMAIN_SPEC);
  const a = createReviewStore(domain), b = createReviewStore(domain);
  const admission = (id, seat = 'executor-s-cheap') => ({ id, unit: 'U-1', seat, owner: 'S-1' });
  await Promise.all([a.applyAdmission(admission('one')), b.applyAdmission(admission('two'))]);
  const review = attempt => ({ id: `review-${attempt}`, unit: 'U-1', owner: 'S-1', family: 'simple', role: 'executor', tier: 'cheap', attempt,
    raw: 'REVIEW: {"unit":"U-1","verdict":"revise","evidence":"fixture"}' });
  assert.equal((await a.applyReview(review(2))).applied, true);
  await b.applyAdmission(admission('three'));
  assert.equal((await b.applyReview(review(3))).applied, true);
  await assert.rejects(a.applyAdmission(admission('four')), /higher tier/);
  await domain.close();
  const reopened = await facility.open(REVIEW_DOMAIN_SPEC);
  const store = createReviewStore(reopened), state = store.readState();
  assert.equal(state.units['U-1'].attempt, 3);
  assert.equal(store.ownerOf('U-1'), 'S-1');
  assert.equal(store.requiredReviewTier(state, 'U-1'), 'default');
  assert.equal((await store.applyAdmission(admission('five', 'executor-s'))).units['U-1'].tier, 'default');
  await reopened.close(); await backend.close();
});

test('review intake requires owned reviewer output bound to the current attempt and applies once', async () => {
  const bindings = new Map();
  const guard = { setSnapshot() {}, async reserve(value) { this.reservation = value; bindings.set(value.childId, { ...value, status: 'pending' }); },
    async settle(id, status) { bindings.get(id).status = status; }, bindingFor: id => bindings.get(id) };
  const f = await fixture({ workerGuard: guard });
  const first = await f.dispatch();
  const stale = await f.dispatch('reviewer-s');
  assert.equal(stale.status, 'dispatched');
  const text = 'REVIEW: {"unit":"U-1","verdict":"revise","evidence":"fixture"}';
  f.sessions.get(stale.childId).messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
  await f.dispatch();
  assert.equal((await f.review({ unit: 'U-1', reviewer_id: stale.childId })).reason, 'reviewer-binding-refused');
  const current = await f.dispatch('reviewer-s');
  assert.equal(bindings.get(current.childId).reviewAttempt, 2);
  assert.equal((await f.review({ unit: 'U-1', reviewer_id: first.childId })).reason, 'reviewer-binding-refused');
  assert.equal((await f.review({ unit: 'U-2', reviewer_id: current.childId })).reason, 'no-admission-for-unit');
  const other = { id: 'other', session: { id: 'other' } };
  assert.equal((await f.review({ unit: 'U-1', reviewer_id: current.childId }, other)).reason, 'unit-owner-refused');
  f.sessions.get(current.childId).messages.push({ role: 'user', content: [{ type: 'text', text }] });
  assert.equal((await f.review({ unit: 'U-1', reviewer_id: current.childId })).reason, 'invalid-review-text');
  f.sessions.get(current.childId).messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
  assert.equal((await f.review({ unit: 'U-1', reviewer_id: current.childId })).status, 'applied');
  assert.equal((await f.review({ unit: 'U-1', reviewer_id: current.childId })).status, 'not-applied');
  await f.dispose();
});
