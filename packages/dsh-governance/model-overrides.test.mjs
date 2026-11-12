import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyModelOverrides, configuredAssignment, modelRevision } from './model-overrides.mjs';
import { applyBindings, publishRoleModelOverrides, roleModelOverrides } from './bindings.mjs';
import * as policyApi from './policy.mjs';
import { createWorkerGuard } from './worker-guard.mjs';
import { trackPolicyReader } from './tracks.mjs';
import { createGovernanceFacade, resolveWorkerSelection } from './facade-core.mjs';
import { QUESTIONS } from './judge.mjs';

test('primary and worker reviewers retain independent configured routes', () => {
  const roster = { providers: { openrouter: {} }, agents: [{ seat: 'reviewer', configured_target: 'openrouter/old', configured_effort: null }] };
  const assignments = { 'dsh-agent-reviewer': { sourceRole: 'reviewer', target: 'openrouter/old', variant: null } };
  const config = { reviewerModel: 'openrouter/primary', reviewerWorkerModel: 'openrouter/worker' };
  const updated = applyModelOverrides(roster, assignments, config);
  assert.equal(updated.roster.agents[0].primary_target, 'openrouter/primary');
  assert.equal(updated.roster.agents[0].configured_target, 'openrouter/worker');
  assert.equal(updated.assignments['dsh-reviewer'].target, 'openrouter/primary');
  assert.equal(updated.assignments['dsh-agent-reviewer'].target, 'openrouter/worker');
  assert.equal(configuredAssignment('dsh-reviewer', assignments, config).target, 'openrouter/primary');
  assert.deepEqual(configuredAssignment('kilo-reviewer', assignments, config), configuredAssignment('dsh-reviewer', assignments, config));
  assert.deepEqual(configuredAssignment('kilo-agent-reviewer', assignments, config), configuredAssignment('dsh-agent-reviewer', assignments, config));
  assert.equal(roster.agents[0].configured_target, 'openrouter/old');
});

test('invalid providers are refused and route revisions change with worker routes', () => {
  const roster = { providers: { openrouter: {} }, agents: [{ seat: 'executor', configured_target: 'openrouter/old', configured_effort: 'high' }] };
  const assignments = { 'dsh-agent-executor': { target: 'openrouter/old', variant: 'high' } };
  assert.throws(() => applyModelOverrides(roster, assignments, { executorDefaultModel: 'unknown/model' }), /Unknown model provider/);
  const updated = applyModelOverrides(roster, assignments, { executorDefaultModel: 'openrouter/new', executorDefaultEffort: 'xhigh' });
  assert.equal(updated.roster.agents[0].configured_effort, 'xhigh');
  assert.equal(updated.assignments['dsh-agent-executor'].variant, 'xhigh');
  assert.notEqual(modelRevision(roster.agents), modelRevision(updated.roster.agents));
});

test('a changed primary model setting is applied before the next step', async () => {
  const handlers = new Map();
  const selected = [];
  const agent = { session: { id: 's' }, model: { async select(value) { selected.push(value); } } };
  const services = {
    agents: { get: () => agent },
    agentPresets: { presetForSession: () => 'dsh-coder' },
    llm: { resolveModelInfo: async () => ({}) },
  };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const publish = model => publishRoleModelOverrides(ctx, { coderModel: `openrouter/${model}` }, { 'dsh-coder': { target: `openrouter/${model}`, variant: null } }, model);
  let dispose;
  try {
    dispose = publish('first');
    applyBindings(ctx);
    await handlers.get('agent/created')({ agent, source: 'new' });
    assert.equal(selected[0].model, 'first');
    const oldDispose = dispose;
    dispose = publish('second');
    oldDispose();
    const result = await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter' }));
    assert.equal(result.kind, 'reject');
    assert.equal(selected[1].model, 'second');
    dispose();
    assert.equal((await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter' }))).kind, 'enter');
    assert.equal(selected.length, 2);
    const fresh = { session: { id: 'fresh-after-unload' }, model: { async select(value) { selected.push(value); } } };
    await handlers.get('agent/created')({ agent: fresh, source: 'new' });
    assert.equal(selected.length, 3);
    const base = JSON.parse(await readFile(new URL('./assignments.json', import.meta.url), 'utf8'))['dsh-coder'];
    assert.equal(`${selected[2].provider}/${selected[2].model}`, base.target);
  } finally { dispose?.(); }
});

test('legacy preset selection and pre-step use the canonical assignment key', async () => {
  const handlers = new Map(), selected = [];
  const agent = { session: { id: 'legacy-assignment' }, model: { async select(value) { selected.push(value); } } };
  let preset = 'kilo-coder';
  const services = { agents: { get: () => agent }, agentPresets: { presetForSession: () => preset }, llm: { resolveModelInfo: async () => ({}) } };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const dispose = publishRoleModelOverrides(ctx, {}, { 'dsh-coder': { target: 'openrouter/fixture', variant: null } }, 'legacy');
  try {
    applyBindings(ctx);
    await handlers.get('agent/created')({ agent, source: 'new' });
    assert.equal(selected[0].model, 'fixture');
    preset = 'dsh-coder';
    assert.equal((await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter' }))).kind, 'enter');
    assert.equal(selected.length, 1);
    await handlers.get('agent-preset/selected')(agent.session.id, 'kilo-coder');
    assert.equal(selected.length, 1);
  } finally { dispose(); }
});

test('primary selection retries only unknown OpenRouter models in alias order', async () => {
  const handlers = new Map(), attempted = [];
  const agent = { session: { id: 'alias-selection' }, model: { async select(selection) {
    attempted.push(selection.model);
    if (attempted.length < 3) throw Object.assign(new Error('has no configured model'), { code: 'UNKNOWN_MODEL' });
  } } };
  const services = { agents: {}, agentPresets: { presetForSession: () => 'dsh-coder' }, llm: { resolveModelInfo: async () => ({}) } };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const dispose = publishRoleModelOverrides(ctx, {}, { 'dsh-coder': { target: 'openrouter/deepseek/deepseek-v4.1-flash-1017', variant: null } }, 'alias');
  try {
    applyBindings(ctx);
    await handlers.get('agent/created')({ agent, source: 'new' });
    assert.deepEqual(attempted, ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v3.2']);
  } finally { dispose(); }
});

test('primary metadata falls back for unknown models but not other errors', async () => {
  const handlers = new Map(), lookedUp = [];
  let failure = 'UNKNOWN_MODEL';
  const agent = { session: { id: 'alias-metadata' }, model: { async select() {} } };
  const services = { agents: {}, agentPresets: { presetForSession: () => 'dsh-coder' }, llm: { async resolveModelInfo(_provider, model) {
    lookedUp.push(model);
    if (lookedUp.length === 1) throw Object.assign(new Error(failure), { code: failure });
    return {};
  } } };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const dispose = publishRoleModelOverrides(ctx, {}, { 'dsh-coder': { target: 'openrouter/moonshotai/kimi-k3.1-pro', variant: null } }, 'alias');
  try {
    applyBindings(ctx);
    await handlers.get('agent/created')({ agent, source: 'new' });
    assert.deepEqual(lookedUp, ['moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3']);
    lookedUp.length = 0;
    failure = 'AUTH_FAILED';
    const other = { ...agent, session: { id: 'alias-auth' } };
    await assert.rejects(handlers.get('agent/created')({ agent: other, source: 'new' }), /AUTH_FAILED/);
    assert.deepEqual(lookedUp, ['moonshotai/kimi-k3.1-pro']);
  } finally { dispose(); }
});

test('profile publication invalidates facade snapshot and unload denies stale workers', async () => {
  const roster = JSON.parse(await readFile(new URL('./test-fixtures/role-roster.synthetic.json', import.meta.url), 'utf8'));
  const records = new Map(), tracks = new Map();
  const table = rows => ({ get: id => rows.get(id), entries: () => [...rows], put: async (id, value) => rows.set(id, value), update: async (id, fn) => rows.set(id, fn(rows.get(id))) });
  const domain = { table: () => table(records), close: async () => {} };
  const trackDomain = { table: () => table(tracks) };
  const sessions = new Map([['parent', { id: 'parent', header: { id: 'parent' } }], ['child', { id: 'child', header: { id: 'child', origin: 'subagent', parentSession: 'parent', agentPreset: 'dsh-worker-executor' } }]]);
  const services = {
    sessions: { get: id => sessions.get(id) },
    agentPresets: { presetForSession: session => session.id === 'parent' ? 'dsh-coordinator-simple' : session.header.agentPreset },
    storageDomain: { open: async () => domain, get: name => name === 'dsh_worker_tracks' ? trackDomain : undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
  };
  const ctx = { get: name => services[name], on: () => () => {} };
  const guard = createWorkerGuard(ctx, domain);
  let currentSnapshot;
  const workerGuard = { ...guard, setSnapshotProvider(fn) { currentSnapshot = fn; guard.setSnapshotProvider(fn); } };
  const facade = createGovernanceFacade({ roster, workerGuard });
  const disposeFacade = await facade.apply(ctx);
  const base = currentSnapshot();
  const config = { simpleExecutorCheapModel: 'openrouter/synthetic-new', coderModel: 'openrouter/synthetic-coder' };
  const dispose = publishRoleModelOverrides(ctx, config, { 'dsh-coder': { target: config.coderModel, variant: null } }, 'settings-synthetic');
  const changed = currentSnapshot();
  assert.equal(changed.revision, roleModelOverrides(ctx).revision);
  assert.equal(changed.seats['executor-s-cheap'].route.model, 'synthetic-new');
  const route = changed.seats['executor-s-cheap'].route;
  await guard.reserve({ childId: 'child', parentId: 'parent', unit: 'U-SCOPED', seat: 'executor-s-cheap', family: 'simple', preset: 'dsh-worker-executor', route, policy: policyApi.resolvePolicy('parent', trackPolicyReader(ctx)), configRevision: changed.revision });
  await guard.settle('child', 'active');
  assert.equal(guard.check('child', route).allowed, true);
  dispose();
  assert.equal(currentSnapshot().revision, base.revision);
  assert.equal(guard.check('child', route).denied, 'worker-config-or-track-changed');
  guard.dispose();
  await disposeFacade();
});

test('worker alias routes are family-specific and keep exact provider and effort', () => {
  const canonical = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', effort: null };
  const snapshot = policyApi.normalizeConfig({ revision: 'alias-cfg', providers: { openrouter: { baseURL: null } }, seats: {
    'executor-f-cheap': { enabled: true, route: canonical }, 'executor-f': { enabled: true, route: canonical },
    'executor-s-cheap': { enabled: true, route: canonical },
  } });
  const policy = mode => policyApi.resolvePolicy('parent', id => ({ id, metadata: { [policyApi.NS]: { v: 1, mode, rev: 'r1' } } }));
  const free = policy('free'), simple = policy('simple');
  const aliases = policyApi.workerAliasRoutes({ snapshot, policy: free, seat: 'executor-f-cheap' });
  assert.deepEqual(aliases.map(route => route.model), ['z-ai/glm-5.3-flash', 'google/gemma-4-31b-it:free']);
  assert.deepEqual(policyApi.workerAliasRoutes({ snapshot, policy: free, seat: 'executor-f' }), []);
  assert.deepEqual(policyApi.workerAliasRoutes({ snapshot, policy: simple, seat: 'executor-s-cheap' }).map(route => route.model),
    ['deepseek/deepseek-v4.1-flash', 'google/gemini-3.6-flash']);
  assert.equal(policyApi.admitResolvedWorker({ snapshot, policy: free, seat: 'executor-f-cheap', actual: aliases[0] }).route.model, aliases[0].model);
  assert.throws(() => policyApi.admitResolvedWorker({ snapshot, policy: free, seat: 'executor-f-cheap', actual: { ...aliases[0], model: 'deepseek/deepseek-v4.1-flash' } }));
  assert.throws(() => policyApi.admitResolvedWorker({ snapshot, policy: free, seat: 'executor-f-cheap', actual: { ...aliases[0], effort: 'high' } }));
  assert.throws(() => policyApi.admitWorker({ snapshot, policy: free, seat: 'executor-f-cheap', explicit: aliases[0] }));
});

test('worker guard admits a recorded authorized alias but rejects any other actual route', async () => {
  const canonical = { provider: 'openrouter', model: 'openai/gpt-6.1-terra', effort: null };
  const alias = { ...canonical, model: 'openai/gpt-6.1-sol' };
  const workers = new Map(), tracks = new Map();
  const table = records => ({ get: id => records.get(id), entries: () => [...records], put: async (id, value) => records.set(id, value), update: async (id, fn) => records.set(id, fn(records.get(id))) });
  const workerDomain = { table: () => table(workers) }, trackDomain = { table: () => table(tracks) };
  const sessions = new Map([['parent', { id: 'parent', header: { id: 'parent' } }], ['child', { id: 'child', header: { id: 'child', origin: 'subagent', parentSession: 'parent', agentPreset: 'dsh-worker-executor' } }]]);
  const ctx = { get: name => ({ sessions: { get: id => sessions.get(id) }, agentPresets: { presetForSession: session => session.id === 'parent' ? 'dsh-coordinator-simple' : session.header.agentPreset }, storageDomain: { get: name => name === 'dsh_worker_tracks' ? trackDomain : undefined } })[name], on: () => () => {} };
  const guard = createWorkerGuard(ctx, workerDomain);
  sessions.get('child').header.agentPreset = 'kilo-worker-executor';
  for (const mode of ['off', 'free', 'simple', 'advanced']) {
    const legacyTrack = trackPolicyReader({ get: name => name === 'sessions' ? { get: () => ({ id: 'legacy-track', header: { agentPreset: `kilo-coordinator-${mode}` } }) } : undefined });
    assert.equal(legacyTrack('legacy-track').metadata[policyApi.NS].mode, mode);
  }
  const snapshot = policyApi.normalizeConfig({ revision: 'cfg-1', providers: { openrouter: { baseURL: null } }, seats: { 'executor-s-cheap': { enabled: true, route: canonical } } });
  guard.setSnapshot(snapshot);
  await guard.reserve({ childId: 'child', parentId: 'parent', unit: 'U-1', seat: 'executor-s-cheap', family: 'simple', preset: 'dsh-worker-executor', route: canonical, policy: policyApi.resolvePolicy('parent', trackPolicyReader(ctx)), configRevision: 'cfg-1' });
  await assert.rejects(guard.updatePendingRoute('child', { ...alias, model: 'other/model' }));
  await guard.updatePendingRoute('child', alias);
  assert.equal(guard.check('child', alias).allowed, true);
  workers.get('child').preset = 'kilo-worker-executor';
  assert.equal(guard.check('child', alias).allowed, true);
  await guard.settle('child', 'active');
  assert.equal(guard.check('child', alias).allowed, true);
  await assert.rejects(guard.updatePendingRoute('child', canonical));
  assert.equal(guard.check('child', { ...alias, model: 'other/model' }).denied, 'worker-actual-route-mismatch');
  guard.dispose();
});

test('worker metadata retries unknown models only and preserves the selected route', async () => {
  const routes = [
    { provider: 'openrouter', model: 'openai/gpt-6.1-terra', effort: 'xhigh' },
    { provider: 'openrouter', model: 'openai/gpt-6.1-sol', effort: 'xhigh' },
  ];
  const attempted = [];
  const resolved = await resolveWorkerSelection(routes, 0, async (_provider, model) => {
    attempted.push(model);
    if (model.endsWith('terra')) throw Object.assign(new Error('has no configured model'), { code: 'UNKNOWN_MODEL' });
    return { reasoning: { efforts: [{ id: 'xhigh' }] } };
  });
  assert.deepEqual(attempted, routes.map(route => route.model));
  assert.equal(resolved.route.model, 'openai/gpt-6.1-sol');
  assert.equal(resolved.selection.reasoningEffort, 'xhigh');
  attempted.length = 0;
  await assert.rejects(resolveWorkerSelection(routes, 0, async (_provider, model) => {
    attempted.push(model);
    throw Object.assign(new Error('AUTH_FAILED'), { code: 'AUTH_FAILED' });
  }), /AUTH_FAILED/);
  assert.deepEqual(attempted, ['openai/gpt-6.1-terra']);
});

test('worker activation retries an unknown alias and records the successful route', async () => {
  const definitions = new Map(), rows = new Map(), activated = [];
  const table = { entries: () => [...rows], get: id => rows.get(id), put: async (id, value) => rows.set(id, value), update: async (id, fn) => rows.set(id, fn(rows.get(id))) };
  const domain = { table: () => table, close: async () => {} };
  let binding;
  const guard = { setSnapshot() {}, async reserve(value) { binding = { ...value, status: 'pending' }; },
    async updatePendingRoute(id, route) { assert.equal(id, binding.childId); binding.route = route; },
    async settle(id, status) { assert.equal(id, binding.childId); binding.status = status; } };
  const agent = { id: 'parent', session: { id: 'parent' } };
  const services = {
    workingDirectory: { ensure: async () => process.cwd() },
    tools: { register: def => { definitions.set(def.name, def); return () => {}; }, guard: () => () => {} },
    agentPresets: { presetForSession: () => 'dsh-coordinator-simple', resolve: async id => ({ id }) },
    llm: { resolveModelInfo: async (_provider, model) => {
      if (model === 'openai/gpt-6.1-terra') throw Object.assign(new Error('has no configured model'), { code: 'UNKNOWN_MODEL' });
      return { reasoning: { efforts: [{ id: 'xhigh' }] } };
    } },
    storageDomain: { open: async () => domain, get: () => domain },
    subagents: { getProvider: () => ({ prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentPreset: true, agentOptions: true } }),
      async startActivation(spec) {
        activated.push(spec.request.agentOptions.model);
        if (activated.length === 1) throw Object.assign(new Error('has no configured model'), { code: 'UNKNOWN_MODEL' });
        return { childId: spec.childId };
      } },
  };
  const roster = { schema: 'dsh-role-roster-whitelist/v1', source_sha256: 'aa'.repeat(32), auth_prompt_mcp_values_excluded: true,
    providers: { openrouter: { baseURL: null, auth_values_excluded: true } }, agents: [{ seat: 'executor-s-cheap', enabled: true,
      configured_target: 'openrouter/openai/gpt-6.1-terra', configured_effort: 'xhigh', mode: 'subagent' }] };
  const facade = createGovernanceFacade({ roster, workerGuard: guard, readSession: id => ({ id, metadata: { [policyApi.NS]: { v: 1, mode: 'simple', rev: 'r1' } } }),
    authorizeOperation: () => true, judgeTransport: async ({ body }) => {
      const answers = Object.fromEntries(Object.keys(QUESTIONS).map(key => [key, { type: 'noul', noul: 0.05 }]));
      answers.risk_read_only.noul = 0.95; answers.tier_quick.noul = 0.95; return { model: body.model, answers };
    } });
  const dispose = await facade.apply({ get: name => services[name] });
  try {
    const brief = JSON.stringify({ unit: 'U-ALIAS', objective: 'Read fixture', scope: ['fixture.md'], acceptance: ['correct evidence'], risk: 'low', changes: 'No source changes' });
    const result = await definitions.get('dsh_dispatch').execute({ seat: 'executor-s-cheap', brief }, { agent, signal: new AbortController().signal });
    assert.equal(result.status, 'dispatched', JSON.stringify(result));
    assert.deepEqual(activated, ['openai/gpt-6.1-sol', 'qwen/qwen3.8-2.4t-a95b']);
    assert.equal(binding.route.model, 'qwen/qwen3.8-2.4t-a95b');
    assert.equal(binding.status, 'active');
    assert.equal(result.route.model, binding.route.model);
  } finally { await dispose(); }
});
