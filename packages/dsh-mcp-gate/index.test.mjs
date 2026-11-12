import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.mjs';
import { emptySeen, mcpGateDecision } from './gates.mjs';
import { completedDiscovery } from './tool-result-policy.mjs';
import { applyGates } from './gates-core.mjs';
import { apply as applyHarness } from '../dsh-governance/index.mjs';

test('chained and commented commands cannot establish discovery receipts', () => {
  const seen = emptySeen();
  seen.skill = true;
  const chain = '~/.local/bin/mcp2cli @alpha --list && ~/.local/bin/mcp2cli @alpha search --help';
  const result = { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: 'complete', truncated: false }, stderr: { truncated: false } } };
  assert.equal(mcpGateDecision(chain, seen).ok, false);
  assert.deepEqual(completedDiscovery({ arguments: { command: chain } }, result, seen), []);
  seen.servers.add('alpha');
  assert.deepEqual(completedDiscovery({ arguments: { command: 'mcp2cli @alpha search --help # && mcp2cli @alpha other --help' } }, result, seen), []);
});

test('reused event domain restores session discovery without closing the shared domain', async () => {
  const rows = new Map(), hooks = new Map();
  let guard, opened = 0, closed = 0;
  const table = { entries: () => rows.entries(), put: async (key, value) => rows.set(key, value) };
  const domain = { table: () => table, close: async () => { closed++; } };
  const storage = { get: () => domain, open: async () => { opened++; return domain; } };
  const tools = { guard: fn => { guard = fn; return () => {}; }, register: () => () => {} };
  const ctx = { get: key => ({ tools, storageDomain: storage })[key], on: (key, fn) => { hooks.set(key, fn); return () => hooks.delete(key); } };
  const agent = { session: { id: 'persisted' } };
  const result = { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: 'complete', truncated: false }, stderr: { truncated: false } } };
  const first = await applyGates(ctx);
  hooks.get('tools/result')({ name: 'skill', arguments: { name: 'mcp-router' }, agent }, { isError: false });
  for (const command of ['mcp2cli @alpha --list', 'mcp2cli @alpha search --help']) {
    hooks.get('tools/result')({ name: 'bash', arguments: { command }, agent }, result);
  }
  await first();
  const second = await applyGates(ctx);
  assert.equal(guard({ name: 'bash', arguments: { command: 'mcp2cli @alpha search' }, agent }), undefined);
  assert.match(guard({ name: 'bash', arguments: { command: 'mcp2cli @alpha search' }, agent: { session: { id: 'other' } } }), /MCP gate/);
  await second();
  assert.equal(opened, 0);
  assert.equal(closed, 0);
  assert.equal(rows.size, 4);
});

test('plugin installs the gate and removes its hooks on disposal', async () => {
  const hooks = new Map();
  let guard;
  let definition;
  const tools = {
    guard(fn) { guard = fn; return () => { guard = null; }; },
    register(def) { definition = def; return () => { definition = null; }; },
  };
  const ctx = {
    get: (key) => key === 'tools' ? tools : undefined,
    on(event, fn) { hooks.set(event, fn); return () => hooks.delete(event); },
  };
  const dispose = await apply(ctx);
  assert.equal(definition.name, 'dsh_governance_events');
  assert.match(guard({ name: 'bash', arguments: { command: 'mcp2cli @server tool' }, agent: { session: { id: 's' } } }), /MCP gate/);
  await dispose();
  assert.equal(guard, null);
  assert.equal(definition, null);
  assert.equal(hooks.size, 0);
});

test('maintenance grants require an affirmative exact session, server and tool request', async () => {
  const hooks = new Map();
  let guard;
  const ctx = {
    get: key => key === 'tools' ? { guard(fn) { guard = fn; }, register() {} } : undefined,
    on(event, fn) { hooks.set(event, fn); },
  };
  await apply(ctx);
  const agent = id => ({ session: { id } });
  const result = { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: 'complete', truncated: false }, stderr: { truncated: false } } };
  const discover = (id, server, tool) => {
    hooks.get('tools/result')({ name: 'skill', arguments: { name: 'mcp-router' }, agent: agent(id) }, { isError: false });
    for (const command of [`mcp2cli @${server} --list`, `mcp2cli @${server} ${tool} --help`]) {
      hooks.get('tools/result')({ name: 'bash', arguments: { command }, agent: agent(id) }, result);
    }
  };
  const ask = (id, text, role = 'user', kind = 'user') => hooks.get('agent/pre-step')({ agent: agent(id), messages: [{ role, source: { kind }, content: [{ type: 'text', text }] }] }, () => null);
  const invoke = (id, server = 'alpha', tool = 'rebuild-index') => guard({ name: 'bash', arguments: { command: `mcp2cli @${server} ${tool}` }, agent: agent(id) });
  for (const id of ['a', 'b']) for (const [server, tool] of [['alpha', 'rebuild-index'], ['alpha', 'rebuild-index-extra'], ['alpha', 'delete-records'], ['beta', 'rebuild-index']]) discover(id, server, tool);
  for (const text of ['run mcp2cli @alpha rebuild-index-extra', 'do not run @alpha rebuild-index', 'do not run mcp2cli @alpha rebuild-index', 'Please don\'t run mcp2cli @alpha rebuild-index', '"run mcp2cli @alpha rebuild-index"', 'The example is "run mcp2cli @alpha rebuild-index"']) {
    await ask('a', text);
    assert.match(invoke('a'), /did not request/, text);
  }
  for (const [role, kind] of [['assistant', 'user'], ['tool', 'user'], ['user', 'tool']]) {
    await ask('b', 'run mcp2cli @alpha rebuild-index', role, kind);
    assert.match(invoke('b'), /did not request/, `${role}/${kind}`);
  }
  await ask('a', 'run mcp2cli @alpha rebuild-index');
  assert.equal(invoke('a'), undefined);
  assert.match(invoke('b'), /did not request/);
  assert.match(invoke('a', 'beta'), /did not request/);
  assert.match(invoke('a', 'alpha', 'rebuild-index-extra'), /did not request/);
  assert.match(invoke('a', 'alpha', 'delete-records'), /did not request/);
  await ask('a', 'do not run mcp2cli @alpha rebuild-index');
  assert.match(invoke('a'), /did not request/);
});

test('quoted inert dollar is permitted without weakening ambiguous invocation denials', () => {
  const seen = emptySeen();
  seen.skill = true;
  seen.servers.add('alpha');
  seen.tools.add('alpha/search');
  for (const value of ["'$'", '"$"']) assert.equal(mcpGateDecision(`mcp2cli @alpha search --query ${value}`, seen).ok, true, value);
  for (const value of ['$value', '$(id)', '`id`', '\\x', '"$value"', '"$(id)"', '"$[1+2]"', '"`id`"']) {
    const decision = mcpGateDecision(`mcp2cli @alpha search --query ${value}`, seen);
    assert.equal(decision.ok, false, value);
    assert.match(decision.problems[0], /ambiguous mcp2cli invocation/);
  }
  for (const command of ["'mcp2cli' @alpha search", 'env mcp2cli @alpha search', 'command mcp2cli @alpha search']) {
    assert.equal(mcpGateDecision(command, seen).ok, false, command);
  }
});

test('exact refresh aliases still require discovery', () => {
  for (const server of ['chat-search-mcp', 'dsh-chat-search-mcp']) {
    const command = `mcp2cli @${server} update-index`;
    const seen = emptySeen();
    assert.equal(mcpGateDecision(command, seen).ok, false);
    seen.skill = true;
    assert.equal(mcpGateDecision(command, seen).ok, false);
    seen.servers.add(server);
    assert.equal(mcpGateDecision(command, seen).ok, false);
    seen.tools.add(`${server}/update-index`);
    assert.equal(mcpGateDecision(command, seen).ok, true);
  }
});

test('bundled disable flags act independently', async () => {
  const flags = ['disableBundledMcpGate', 'disableBundledSearchGuard', 'disableBundledVerificationLedger', 'disableBundledMemoryViewer'];
  for (const config of [{}, ...flags.map(flag => ({ [flag]: true })), Object.fromEntries(flags.map(flag => [flag, true]))]) {
    const guards = [], hooks = [], registered = [];
    const tools = {
      guard(fn) { guards.push(fn); return () => {}; },
      register(def) { registered.push(def.name); return () => {}; },
    };
    const ctx = {
      effect() {},
      on(event, fn) { if (event === 'tools/pre-execute') hooks.push(fn); return () => {}; },
      get(name) {
        if (name === 'tools') return tools;
        if (name === 'agents') return { get: () => undefined };
        if (name === 'agentPresets') return { presetForSession: () => null };
        if (name === 'llm') return { resolveModelInfo: async () => null };
      },
    };
    const dispose = await applyHarness(ctx, config);
    const agent = { session: { id: 'switches', header: { cwd: '/' } } };
    const mcp = { name: 'bash', arguments: { command: 'mcp2cli @alpha search' }, agent };
    assert.equal(guards.some(guard => /MCP gate/.test(guard(mcp) ?? '')), !config.disableBundledMcpGate);
    assert.equal(registered.includes('dsh_governance_events'), !config.disableBundledMcpGate);
    const outcomes = await Promise.all(hooks.map(hook => hook({ name: 'grep', arguments: { path: '/' }, agent }, () => 'allowed')));
    assert.equal(outcomes.some(result => result?.kind === 'deny' && /searches must be scoped/.test(result.reason)), !config.disableBundledSearchGuard);
    for (const name of ['check', 'resource', 'efficiency_override']) assert.equal(registered.includes(name), !config.disableBundledVerificationLedger, name);
    assert.equal(registered.includes('memory_preview'), !config.disableBundledMemoryViewer);
    await dispose();
  }
});
