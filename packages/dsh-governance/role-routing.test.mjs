import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { selectionFor, applyBindings, PRIMARY_ROLES, switchSessionRole } from './bindings.mjs';
import { createGovernanceFacade } from './facade-core.mjs';
import { QUESTIONS } from './judge.mjs';
import { resolvePromptAdditions } from './system-hooks.mjs';
import { resolvePolicy } from './policy.mjs';
import { createReviewStore } from './review-store.mjs';
import { LEGACY_ROLE_EVENT, LEGACY_ROLE_PROJECTION_KEY } from './legacy.mjs';
const require = createRequire(import.meta.url);
const sdk = packageName => new URL('../', pathToFileURL(require.resolve(packageName)));
const subagent = sdk('@deepseek-ai/dsh-subagent');
const typertPath = new URL('lib/typert.host.js', subagent);
const { TYPERT } = await import(typertPath.href);
const { Session, appendPluginRecord } = await import('@deepseek-ai/dsh-session');
const { snapshotSubagentDescriptor, foldSubagentDescriptor } = await import(new URL('lib/types/descriptor.js', subagent));
const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog');

test('picker shows only clean primary roles while worker resolution stays available', async () => {
  const ids = ['dsh-coordinator-simple', 'dsh-coder', 'dsh-researcher', 'dsh-reviewer', 'dsh-auditor', 'dsh-teacher', 'dsh-advisor', 'dsh-video-editor'];
  assert.deepEqual(PRIMARY_ROLES.map(role => role.id), ids);
  assert.deepEqual(PRIMARY_ROLES.map(role => role.label), ['Coordinator', 'Coder', 'Deep Researcher', 'Reviewer', 'Auditor', 'Teacher', 'Advisor', 'Video Editor']);
  assert.ok(PRIMARY_ROLES.every(role => role.target === null));
  const visible = [ids[0], 'dsh-worker', 'dsh-coordinator-off-extra', ...ids.slice(1), 'external-worker'];
  const all = [visible[0], 'dsh-worker-researcher', visible[1], 'dsh-coordinator-off', visible[2],
    'dsh-coordinator-free', ...visible.slice(3), 'dsh-worker-new', 'dsh-coordinator-advanced'].map(id => ({ id }));
  const data = JSON.parse(await readFile(new URL('../dsh-role-presets/presets-data.json', import.meta.url), 'utf8'));
  all.push(...data.map(preset => ({ id: `kilo-${preset.id.slice(4)}` })));
  const allIds = all.map(p => p.id);
  const presets = { list: () => all, resolve: async id => all.find(p => p.id === id), presetForSession: () => 'dsh-coder' };
  const services = { agents: {}, agentPresets: presets, llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'xhigh' }] } }) }, sessionProjections: { register: async () => ({}) } };
  const ctx = { get: name => services[name], on() {} };
  applyBindings(ctx);
  const pickerList = presets.list;
  assert.deepEqual(presets.list().map(p => p.id), visible);
  assert.deepEqual(presets.listAll().map(p => p.id), allIds);
  assert.equal((await presets.resolve('dsh-worker-researcher')).id, 'dsh-worker-researcher');
  applyBindings(ctx);
  assert.equal(presets.list, pickerList);
  assert.deepEqual(presets.listAll().map(p => p.id), allIds);
  assert.deepEqual(all.map(p => p.id), allIds);
  let selected;
  const agent = { session: Session.create('clean-roles'), model: { current: () => selected, select: value => { selected = value; } } };
  for (const id of ids) await switchSessionRole(ctx, agent, id);
  assert.ok(agent.model.current());
});

test('legacy roles select canonical routes and append canonical role events only', async () => {
  const handlers = new Map(), definitions = [];
  const services = { agents: { get: () => null }, agentPresets: { presetForSession: () => 'kilo-coder' },
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'xhigh' }] } }) },
    sessionProjections: { register: async def => { definitions.push(def); return { stateOf: session => session.snapshotEvents(0, session.seq).reduce(def.apply, def.init()) }; } } };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const fresh = await import(`./bindings.mjs?legacy-switch=${Date.now()}`);
  fresh.applyBindings(ctx);
  const session = Session.create('legacy-switch');
  const selections = [];
  const agent = { session, model: { select: value => selections.push(value), current: () => selections.at(-1) } };
  for (const canonical of PRIMARY_ROLES.map(role => role.id)) {
    await fresh.switchSessionRole(ctx, agent, canonical);
    const expected = selections.at(-1);
    const result = await fresh.switchSessionRole(ctx, agent, `kilo-${canonical.slice(4)}`);
    assert.equal(result.roleId, canonical);
    assert.deepEqual(selections.at(-1), expected);
  }
  const events = session.snapshotEvents(0, session.seq).filter(event => event.type.includes('/role'));
  assert.ok(events.length > 0);
  assert.ok(events.every(event => event.type === 'plugin:dsh-governance/role' && event.data.roleId.startsWith('dsh-')));
  assert.deepEqual(definitions.map(def => def.key), ['dshActiveRole', LEGACY_ROLE_PROJECTION_KEY]);
});

test('legacy events and caches restore canonical roles in event order', async () => {
  const handlers = new Map(), definitions = new Map();
  let cachedLegacy, cachedCanonical = null;
  const services = { agents: {}, agentPresets: { presetForSession: () => 'dsh-coder' }, llm: {},
    sessionProjections: { register: async def => { definitions.set(def.key, def); return { stateOf: session =>
      session.id === 'legacy-cache' ? (def.key === LEGACY_ROLE_PROJECTION_KEY ? cachedLegacy : cachedCanonical)
        : session.snapshotEvents(0, session.seq).reduce(def.apply, def.init()) }; } } };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const fresh = await import(`./bindings.mjs?legacy-replay=${Date.now()}`);
  fresh.applyBindings(ctx);
  const restore = async session => { await handlers.get('agent/created')({ agent: { session }, source: 'resume' }); return fresh.getSessionRole(session.id); };
  const session = Session.create('legacy-replay');
  appendPluginRecord(session, LEGACY_ROLE_EVENT, { roleId: 'kilo-coder' });
  assert.equal(await restore(session), 'dsh-coder');
  appendPluginRecord(session, 'plugin:dsh-governance/role', { roleId: 'dsh-reviewer' });
  assert.equal(await restore(session), 'dsh-reviewer');
  appendPluginRecord(session, LEGACY_ROLE_EVENT, { roleId: 'kilo-advisor' });
  assert.equal(await restore(session), 'dsh-advisor');
  appendPluginRecord(session, 'plugin:dsh-governance/role', { roleId: null });
  assert.equal(await restore(session), null);
  cachedLegacy = 'kilo-teacher';
  assert.equal(await restore(Session.create('legacy-cache')), 'dsh-teacher');
  assert.equal(cachedLegacy, 'kilo-teacher');
  cachedCanonical = 'dsh-auditor';
  assert.equal(await restore(Session.create('legacy-cache')), 'dsh-auditor');
  assert.equal(definitions.get('dshActiveRole').stateSchema.parse('kilo-reviewer'), 'dsh-reviewer');
  assert.equal(definitions.get(LEGACY_ROLE_PROJECTION_KEY).stateSchema.parse(null), null);
});

test('source executor xhigh is the exact governed effort', async () => {
  const roster = JSON.parse(await readFile(new URL('./test-fixtures/role-roster.synthetic.json', import.meta.url), 'utf8'));
  const executor = roster.agents.find(agent => agent.seat === 'executor');
  assert.equal(executor.configured_target, 'openrouter/openai/gpt-6.1-terra');
  assert.equal(executor.source_variant, 'xhigh');
  assert.equal(executor.configured_effort, 'xhigh');
  assert.deepEqual(await selectionFor({ target: executor.configured_target, variant: executor.source_variant },
    async () => ({ reasoning: { efforts: [{ id: 'xhigh' }] } })),
  { provider: 'openrouter', model: 'openai/gpt-6.1-terra', reasoningEffort: 'xhigh' });
  await assert.rejects(selectionFor({ target: executor.configured_target, variant: executor.source_variant },
    async () => ({ reasoning: { efforts: [{ id: 'high' }] } })), /no verified native effort/);
});

test('native plugin record rehydrates the role before resume', async () => {
  const handlers = new Map();
  const services = {
    agents: { get: () => null }, agentPresets: { presetForSession: () => 'dsh-coder' },
    llm: { resolveModelInfo: async () => ({}) },
    sessionProjections: { register: async def => ({ stateOf: session => session.snapshotEvents(0, session.seq).reduce(def.apply, def.init()) }) },
  };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const session = Session.create('role-fixture');
  appendPluginRecord(session, 'plugin:dsh-governance/role', { roleId: 'dsh-coordinator-simple' });
  const fresh = await import(`./bindings.mjs?rehydrate=${Date.now()}`);
  fresh.applyBindings(ctx);
  const agent = { session, model: { current: () => ({ provider: 'openrouter', model: 'example', reasoningEffort: 'high' }) } };
  await handlers.get('agent/created')({ agent, source: 'resume' });
  assert.equal(fresh.getSessionRole(session.id, 'dsh-coder'), 'dsh-coordinator-simple');
});

test('cordis preset locks role switches while standard permits them', async () => {
  const handlers = new Map(), selections = [];
  let preset = 'cordis';
  const services = {
    agents: { get: () => null }, agentPresets: { presetForSession: () => preset },
    llm: { resolveModelInfo: async () => ({}) },
    sessionProjections: { register: async def => ({ stateOf: session => session.snapshotEvents(0, session.seq).reduce(def.apply, def.init()) }) },
  };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const fresh = await import(`./bindings.mjs?native-lock=${Date.now()}`);
  fresh.applyBindings(ctx);
  const session = Session.create('native-lock', undefined, { version: 4, id: 'native-lock', createdAt: 0, isSeeded: false, delegationDepth: 0, agentPreset: 'cordis' });
  const agent = { session, model: { select: value => selections.push(value), current: () => selections.at(-1) } };
  const message = 'Cannot switch DSH role on non-DSH session preset "cordis"; select a DSH preset first';
  const before = session.snapshotEvents(0, session.seq);
  await assert.rejects(fresh.switchSessionRole(ctx, agent, 'dsh-coder'), { message });
  await assert.rejects(fresh.switchSessionRole({ agentPresets: {}, llm: services.llm }, agent, 'dsh-coder'), { message });
  assert.deepEqual(selections, []);
  assert.deepEqual(session.snapshotEvents(0, session.seq), before);
  assert.equal(fresh.getSessionRole(session.id, 'cordis'), 'cordis');
  preset = 'standard';
  await fresh.switchSessionRole(ctx, agent, 'dsh-coder');
  assert.equal(fresh.getSessionRole(session.id), 'dsh-coder');
  assert.equal(selections.length, 1);
});

test('preset selection clears role overrides before assignment and across cold replay', async () => {
  const handlers = new Map(), selections = [];
  let preset = 'dsh-coder';
  const session = Session.create('preset-clears-role');
  const agent = { session, model: { select: value => {
    selections.push({ value, role: session.snapshotEvents(0, session.seq).filter(event => event.type === 'plugin:dsh-governance/role').at(-1)?.data.roleId });
  }, current: () => selections.at(-1)?.value } };
  let activeAgent = agent;
  const services = {
    agents: { get: () => activeAgent }, agentPresets: { presetForSession: () => preset },
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'xhigh' }] } }) },
    sessionProjections: { register: async def => ({ stateOf: value => value.snapshotEvents(0, value.seq).reduce(def.apply, def.init()) }) },
  };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const fresh = await import(`./bindings.mjs?preset-clear=${Date.now()}`);
  fresh.applyBindings(ctx);
  await fresh.switchSessionRole(ctx, agent, 'dsh-coordinator-simple');
  assert.equal(fresh.getSessionRole(session.id), 'dsh-coordinator-simple');
  preset = 'standard';
  await handlers.get('agent-preset/selected')(session.id, preset);
  assert.equal(fresh.getSessionRole(session.id, preset), 'standard');
  assert.equal(session.snapshotEvents(0, session.seq).filter(event => event.type === 'plugin:dsh-governance/role').at(-1).data.roleId, null);
  const reloaded = await import(`./bindings.mjs?preset-cold=${Date.now()}`);
  reloaded.applyBindings(ctx);
  await handlers.get('agent/created')({ agent, source: 'resume' });
  assert.equal(reloaded.getSessionRole(session.id, preset), 'standard');
  preset = 'dsh-coder';
  await reloaded.switchSessionRole(ctx, agent, 'dsh-coordinator-simple');
  preset = 'dsh-reviewer';
  const count = selections.length;
  await handlers.get('agent-preset/selected')(session.id, preset);
  assert.equal(selections.length, count + 1);
  assert.equal(selections.at(-1).role, null);
  assert.equal(reloaded.getSessionRole(session.id, preset), preset);
  await reloaded.switchSessionRole(ctx, agent, 'dsh-coordinator-simple');
  activeAgent = null;
  const eventsBefore = session.seq;
  await handlers.get('agent-preset/selected')(session.id, 'standard');
  assert.equal(reloaded.getSessionRole(session.id, 'standard'), 'standard');
  assert.equal(session.seq, eventsBefore);
});

test('role switch survives native JSONL format persistence and cold service replay', async () => {
  const handlers = new Map();
  const services = { agents: { get: () => null }, agentPresets: { presetForSession: () => 'dsh-coder' },
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'xhigh' }] } }) },
    sessionProjections: { register: async def => ({ stateOf: session => session.snapshotEvents(0, session.seq).reduce(def.apply, def.init()) }) } };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  const fresh = await import(`./bindings.mjs?switch=${Date.now()}`);
  fresh.applyBindings(ctx);
  const session = Session.create('switch-fixture', undefined, {
    version: 4, id: 'switch-fixture', createdAt: 0, isSeeded: false, delegationDepth: 0,
  });
  const model = { select: selection => session.append('model/selection', selection),
    current: () => session.snapshotEvents(0, session.seq).findLast(event => event.type === 'model/selection')?.data };
  const agent = { session, model };
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-session'], '0.2.2-rc.1');
  assert.equal(pkg.exports['./bindings'], './bindings.mjs');
  await fresh.switchSessionRole(ctx, agent, 'dsh-agent-executor');
  assert.deepEqual(agent.model.current(), { provider: 'openrouter', model: 'openai/gpt-6.1-terra', reasoningEffort: 'xhigh' });
  const path = join(tmpdir(), `dsh-d3-role-${randomUUID()}.jsonl`);
  const rows = [sessionFormatCatalog.encodeCurrentHeader(session.header, session.inheritedEventCount), ...session.snapshotEvents(0, session.seq).map(event => sessionFormatCatalog.encodeCurrentEvent(event))];
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  let persisted;
  try {
    const [header, ...events] = (await readFile(path, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
    const decoder = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' });
    for (const event of events) decoder.decodeRow(event);
    persisted = decoder.finish();
  } finally { await unlink(path); }
  const restored = Session.create(session.id, persisted.events, persisted.header, persisted.inheritedEventCount);
  const restoredModel = { current: () => restored.snapshotEvents(0, restored.seq).findLast(event => event.type === 'model/selection')?.data };
  const reloaded = await import(`./bindings.mjs?cold=${Date.now()}`);
  reloaded.applyBindings(ctx);
  await handlers.get('agent/created')({ agent: { session: restored, model: restoredModel }, source: 'resume' });
  assert.equal(reloaded.getSessionRole(restored.id), 'dsh-agent-executor');
  assert.deepEqual(restoredModel.current(), { provider: 'openrouter', model: 'openai/gpt-6.1-terra', reasoningEffort: 'xhigh' });
});

test('replayed role controls prompt assembly and coordinator visibility without changing model or track', async () => {
  const handlers = new Map(), definitions = new Map();
  const services = { agents: { get: () => null }, agentPresets: { presetForSession: () => 'dsh-coder' },
    llm: { resolveModelInfo: async () => ({}) },
    sessionProjections: { register: async def => ({ stateOf: session => session.snapshotEvents(0, session.seq).reduce(def.apply, def.init()) }) },
    tools: { register: (def, options) => { definitions.set(def.name, options); return () => {}; }, guard: () => () => {} } };
  const ctx = { get: name => services[name], on: (name, handler) => handlers.set(name, handler) };
  applyBindings(ctx);
  const session = Session.create('prompt-fixture');
  const selected = { provider: 'openrouter', model: 'openai/gpt-6.1-terra', reasoningEffort: 'xhigh' };
  const agent = { id: session.id, session, model: { current: () => selected } };
  const readSession = id => ({ id, metadata: { 'dsh-workbench.agent-access': { v: 1, mode: 'simple', rev: 'r1' } } });
  const track = resolvePolicy(session.id, readSession);
  appendPluginRecord(session, 'plugin:dsh-governance/role', { roleId: 'dsh-coordinator-simple' });
  await handlers.get('agent/created')({ agent, source: 'resume' });
  const dispose = await createGovernanceFacade({ readSession }).apply(ctx);
  assert.deepEqual([...definitions.keys()].sort(), ['dsh_dispatch', 'dsh_resume', 'dsh_review']);
  const legacyCoordinator = { session: { id: 'legacy-coordinator', header: { agentPreset: 'kilo-coordinator-simple' } } };
  services.agentPresets.presetForSession = value => value.id === 'legacy-coordinator' ? value.header.agentPreset : 'dsh-coder';
  assert.equal(definitions.get('dsh_dispatch').when({ agent: legacyCoordinator }), true);
  const legacyWriter = { session: { id: 'legacy-writer' } };
  const styles = new Map();
  resolvePromptAdditions({ agent: legacyWriter }, { getPreset: () => 'kilo-agent-brilliant-writer', sessionStyles: styles });
  assert.equal(styles.get('legacy-writer'), '');
  assert.match(resolvePromptAdditions({ agent }, { getPreset: () => 'dsh-coder', sessionStyles: new Map() }), /Active Role \(Coordinator/);
  assert.equal(definitions.get('dsh_dispatch').when({ agent }), true);
  assert.deepEqual(agent.model.current(), selected); assert.deepEqual(resolvePolicy(session.id, readSession), track);
  appendPluginRecord(session, 'plugin:dsh-governance/role', { roleId: 'dsh-coder' });
  await handlers.get('agent/created')({ agent, source: 'compact' });
  assert.equal(definitions.get('dsh_dispatch').when({ agent }), false);
  assert.deepEqual(agent.model.current(), selected); assert.deepEqual(resolvePolicy(session.id, readSession), track);
  await dispose();
});

test('fresh spawn and repeated native continuation preserve the admitted identity and route', async () => {
  const definitions = new Map(), records = new Map(), calls = [];
  const table = { entries: () => [...records], get: key => records.get(key), put: async (key, value) => records.set(key, value),
    update: async (key, transform) => { const value = transform(records.get(key)); records.set(key, value); return value; } };
  const domain = { table: () => table, close: async () => {} };
  let binding, spec, child, selected, mode = 'simple', driftOnReserve = false, driftOnObserve = false, spawnCount = 0;
  const guard = { setSnapshot() {}, async reserve(value) { binding = { ...value, parentPolicy: JSON.stringify(value.policy), status: 'pending' }; if (driftOnReserve) mode = 'off'; },
    async settle(id, status) { assert.equal(id, binding.childId); binding.status = status; }, bindingFor: id => binding?.childId === id ? structuredClone(binding) : null };
  const promptDescriptor = TYPERT.invocations.find(entry => entry.namespace === 'subagents' && entry.method === 'prompt');
  const schema = promptDescriptor.parameters[0].strictCodec.create();
  const installed = await readFile(typertPath, 'utf8');
  const strictLine = installed.split("'subagents/prompt':")[1].split('strictCodec:')[1].split('\n').find(line => line.includes('jsonSchema:'));
  const installedSchema = JSON.parse(strictLine.trim().slice('jsonSchema: '.length, -1));
  assert.deepEqual(promptDescriptor.parameters[0].strictCodec.jsonSchema, installedSchema);
  const signal = new AbortController().signal;
  const agent = { id: 'S-1', session: { id: 'S-1' } };
  const services = {
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: () => ({ profile: 'read-only' }) },
    tools: { register: def => { definitions.set(def.name, def); return () => {}; }, guard: () => () => {} },
    agentPresets: { presetForSession: () => 'dsh-coordinator-simple', resolve: async id => ({ id }) },
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'xhigh' }] } }) },
    storageDomain: { open: async () => domain, get: () => domain },
    subagents: { getProvider: name => name === 'spawn' ? { prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentPreset: true, agentOptions: true } } : null,
      startActivation: async value => { spec = value; selected = value.request.agentOptions; spawnCount++;
        const session = Session.create(value.childId);
        session.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: value.provider, label: value.label,
          agentProvider: selected.provider, agentModel: selected.model, agentReasoningEffort: selected.reasoningEffort }));
        child = Session.create(session.id, session.snapshotEvents(0, session.seq), session.header, session.inheritedEventCount);
        return { childId: value.childId }; },
      prompt: async (request, actualSignal) => { schema.parse(request); assert.equal(actualSignal, signal); calls.push(request); return { messageId: 'msg' }; } },
    sessionQuery: { observeSession: async id => { if (driftOnObserve) binding.status = 'failed'; return ({ header: { origin: 'subagent', parentSession: 'S-1' }, inheritedEventCount: 0,
      events: child.snapshotEvents(0, child.seq),
      projections: { values: { agentPreset: spec.request.agentPreset, modelSelection: { next: selected } } }, [Symbol.dispose]() {} }); } },
  };
  const roster = { schema: 'dsh-role-roster-whitelist/v1', source_sha256: 'aa'.repeat(32), auth_prompt_mcp_values_excluded: true,
    providers: { openrouter: { baseURL: null, auth_values_excluded: true } }, agents: [{ seat: 'executor-s-cheap', enabled: true,
      configured_target: 'openrouter/openai/gpt-6.1-terra', configured_effort: 'xhigh', mode: 'subagent' }] };
  const facade = createGovernanceFacade({ roster, workerGuard: guard, readSession: id => ({ id, metadata: { 'dsh-workbench.agent-access': { v: 1, mode, rev: 'policy-1' } } }),
    authorizeOperation: () => true, judgeTransport: async ({ body }) => {
      const answers = Object.fromEntries(Object.keys(QUESTIONS).map(key => [key, { type: 'noul', noul: 0.05 }]));
      answers.risk_read_only.noul = 0.95; answers.tier_quick.noul = 0.95; return { model: body.model, answers };
    } });
  const dispose = await facade.apply({ get: name => services[name] });
  const brief = JSON.stringify({ unit: 'U-1', objective: 'Read fixture', scope: ['fixture.md'], acceptance: ['correct evidence'], risk: 'low', changes: 'No source changes' });
  const dispatched = await definitions.get('dsh_dispatch').execute({ seat: 'executor-s-cheap', brief }, { agent, signal });
  assert.equal(dispatched.status, 'dispatched', JSON.stringify(dispatched));
  assert.equal(spec.provider, 'spawn'); assert.equal(spec.signal, signal); assert.equal(spec.request.parent, agent);
  assert.equal(spec.request.agentPreset, 'dsh-worker-executor'); assert.deepEqual(spec.request.prompt[0].type, 'text');
  assert.equal(spec.request.agentOptions.provider, 'openrouter'); assert.equal(spec.request.agentOptions.model, 'openai/gpt-6.1-terra');
  assert.equal(spec.request.agentOptions.reasoningEffort, 'xhigh');
  const descriptor = foldSubagentDescriptor(child.snapshotEvents(0, child.seq));
  assert.equal(descriptor.agentProvider, 'openrouter'); assert.equal(descriptor.agentModel, 'openai/gpt-6.1-terra');
  assert.equal(descriptor.agentReasoningEffort, 'xhigh');
  assert.equal(binding.reviewAttempt, 1);
  const args = { child_id: dispatched.childId, seat: 'executor-s-cheap', unit: 'U-1', followup: 'continue' };
  selected = null;
  const first = await definitions.get('dsh_resume').execute(args, { agent, signal });
  selected = spec.request.agentOptions;
  const second = await definitions.get('dsh_resume').execute(args, { agent, signal });
  assert.equal(first.status, 'continued', JSON.stringify(first)); assert.equal(second.status, 'continued', JSON.stringify(second));
  assert.notEqual(first.requestId, second.requestId); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].content, [{ type: 'text', text: 'continue' }]);
  assert.equal(first.attempt, 1); assert.equal(second.attempt, 1);
  driftOnObserve = true;
  assert.equal((await definitions.get('dsh_resume').execute(args, { agent, signal })).reason, 'resume-binding-changed');
  driftOnObserve = false; binding.status = 'active';
  const other = { id: 'other', session: { id: 'other' } };
  assert.equal((await definitions.get('dsh_resume').execute(args, { agent: other, signal })).reason, 'resume-binding-refused');
  assert.equal((await definitions.get('dsh_resume').execute({ ...args, child_id: 'unadmitted' }, { agent, signal })).reason, 'resume-binding-refused');
  assert.equal((await definitions.get('dsh_resume').execute({ ...args, seat: 'reviewer-s' }, { agent, signal })).reason, 'resume-binding-refused');
  assert.equal((await definitions.get('dsh_resume').execute({ ...args, unit: 'U-2' }, { agent, signal })).reason, 'resume-binding-refused');
  selected = { ...selected, model: 'different' };
  assert.equal((await definitions.get('dsh_resume').execute(args, { agent, signal })).reason, 'resume-restored-route-refused');
  selected = spec.request.agentOptions;
  const store = createReviewStore(domain);
  const review = attempt => ({ id: `review-${attempt}`, unit: 'U-1', owner: 'S-1', family: 'simple', role: 'executor', tier: 'cheap', attempt,
    raw: 'REVIEW: {"unit":"U-1","verdict":"revise","evidence":"fixture"}' });
  assert.equal((await store.applyReview(review(1))).applied, true);
  assert.equal((await definitions.get('dsh_resume').execute(args, { agent, signal })).reason, 'resume-review-floor-refused');
  const previousBinding = binding;
  const next = await definitions.get('dsh_dispatch').execute({ seat: 'executor-s-cheap', brief }, { agent, signal });
  assert.equal(next.status, 'dispatched');
  const currentBinding = binding;
  binding = previousBinding;
  assert.equal((await definitions.get('dsh_resume').execute(args, { agent, signal })).reason, 'resume-binding-refused');
  binding = currentBinding;
  assert.equal((await store.applyReview(review(2))).applied, true);
  assert.equal((await definitions.get('dsh_resume').execute({ ...args, child_id: next.childId }, { agent, signal })).reason, 'resume-review-floor-refused');
  assert.equal(store.requiredReviewTier(store.readState(), 'U-1'), 'default');
  driftOnReserve = true;
  const race = await definitions.get('dsh_dispatch').execute({ seat: 'executor-s-cheap', brief: brief.replace('U-1', 'U-2') }, { agent, signal });
  assert.equal(race.reason, 'binding-changed-during-admission'); assert.equal(binding.status, 'failed'); assert.equal(spawnCount, 2);
  assert.equal(calls.length, 2);
  await dispose();
});
