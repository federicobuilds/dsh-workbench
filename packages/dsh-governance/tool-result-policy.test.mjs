import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadedMcpRouter, completedDiscovery, redactToolResult } from './tool-result-policy.mjs';
import { emptySeen } from './gates.mjs';
import { applyGates } from './gates-core.mjs';
const CANARY = 'sk-or-v1-' + 'SYNTHETICSECRET'.repeat(3);
const exec = command => ({ name: 'bash', arguments: { command }, agent: { session: { id: 'test-session' } } });
const completed = (overrides = {}) => ({ isError: false, value: {
  kind: 'foreground', cwd: '/fixture', exitCode: 0, signal: null, timedOut: false, aborted: false,
  stdout: { text: '{"tools":[]}', truncated: false }, stderr: { text: '', truncated: false }, ...overrides,
}, content: [{ type: 'text', text: '{"tools":[]}' }] });

test('native skill(name=mcp-router) success is recognized; failed or unrelated loads are not', () => {
  assert.equal(loadedMcpRouter({ name: 'skill', arguments: { name: 'mcp-router' } }, { isError: false }), true);
  assert.equal(loadedMcpRouter({ name: 'skill', arguments: { name: 'mcp-router' } }, { isError: true }), false);
  assert.equal(loadedMcpRouter({ name: 'skill', arguments: { name: 'other' } }, { isError: false }), false);
  assert.equal(loadedMcpRouter({ name: 'read', arguments: { file_path: '/fixture/skills/mcp-router/SKILL.md' } }, { isError: false }), true);
  assert.equal(loadedMcpRouter({ name: 'read', arguments: { file_path: '/fixture/skills/mcp-router/SKILL.md' } }, {}), false);
});

test('only completed, untruncated, single foreground discovery establishes a receipt', () => {
  const seen = emptySeen();
  assert.deepEqual(completedDiscovery(exec('mcp2cli @github --list'), completed(), seen), [{ kind: 'server', server: 'github' }]);
  for (const value of [{ exitCode: 1 }, { exitCode: null }, { timedOut: true }, { aborted: true },
    { kind: 'promoted', jobId: 'job' }, { signal: 'SIGTERM' }, { stdout: { text: 'partial', truncated: true } }, { stdout: { text: '', truncated: false } }]) {
    assert.deepEqual(completedDiscovery(exec('mcp2cli @github --list'), completed(value), seen), []);
  }
  assert.deepEqual(completedDiscovery(exec('mcp2cli @github --list'), { isError: false }, seen), []);
  assert.deepEqual(completedDiscovery(exec('mcp2cli @github --list || true'), completed(), seen), []);
  assert.deepEqual(completedDiscovery(exec('mcp2cli @github --list | cat'), completed(), seen), []);
  assert.deepEqual(completedDiscovery(exec('mcp2cli @github list-pulls'), completed(), seen), []);
});

test('tool help requires previous server discovery; same command does not count', () => {
  const seen = emptySeen();
  assert.deepEqual(completedDiscovery(exec('mcp2cli @github list-pulls --help'), completed(), seen), []);
  seen.servers.add('github');
  assert.deepEqual(completedDiscovery(exec('mcp2cli @github list-pulls --help'), completed(), seen), [{ kind: 'tool', server: 'github', tool: 'list-pulls' }]);
});

test('redaction replaces hidden canonical values and leaves original borrowed results unchanged', () => {
  const original = completed({ stdout: { text: 'key ' + CANARY, truncated: false } });
  original.content[0].text = 'key ' + CANARY;
  const redacted = redactToolResult(original);
  assert.equal(redacted.decision.kind, 'accept');
  assert.ok('value' in redacted.decision && !('content' in redacted.decision));
  assert.ok(!JSON.stringify(redacted.decision).includes(CANARY));
  assert.match(redacted.decision.value.stdout.text, /REDACTED/);
  assert.ok(original.value.stdout.text.includes(CANARY));
});

test('render-only redaction retains already-clean value; sensitive error/meta/context blocks', () => {
  const original = completed(); original.content[0].text = CANARY;
  const redacted = redactToolResult(original);
  assert.ok('content' in redacted.decision && !('value' in redacted.decision));
  for (const field of ['error', 'meta', 'additionalContexts']) {
    const result = completed(); result[field] = { text: CANARY };
    const decision = redactToolResult(result).decision;
    assert.equal(decision.kind, 'block');
    assert.ok(!JSON.stringify(decision).includes(CANARY));
  }
  assert.equal(redactToolResult(completed()).decision, null);
});

test('real-shaped gate sequence refuses failed list/help and admits after separate successful steps', async () => {
  const handlers = new Map(), guards = [];
  const ctx = { get(name) { return name === 'tools' ? this.tools : undefined; }, tools: { register: () => () => {}, guard: fn => { guards.push(fn); return () => {}; } },
    on: (name, fn) => { handlers.set(name, fn); return () => {}; } };
  const dispose = await applyGates(ctx);
  const observe = handlers.get('tools/result');
  const call = exec('mcp2cli @github list-pulls');
  observe({ name: 'skill', arguments: { name: 'mcp-router' }, agent: call.agent }, { isError: false, value: 'loaded' });
  observe(exec('mcp2cli @github --list'), completed({ exitCode: 1 }));
  assert.match(guards[0](call), /--list/);
  observe(exec('mcp2cli @github --list'), completed());
  assert.match(guards[0](call), /--help/);
  observe(exec('mcp2cli @github list-pulls --help'), completed({ exitCode: 2 }));
  assert.match(guards[0](call), /--help/);
  observe(exec('mcp2cli @github list-pulls --help'), completed());
  assert.equal(guards[0](call), undefined);
  assert.match(guards[0]({ ...call, agent: undefined }), /calling session/);
  const post = handlers.get('tools/post-execute');
  const output = completed({ stdout: { text: CANARY, truncated: false } });
  const decision = await post(call, output, () => { throw new Error('must replace value'); });
  assert.ok('value' in decision && !JSON.stringify(decision).includes(CANARY));
  dispose();
});

test('execution adapter denies ambiguous protected commands before invoking the shell', { skip: !process.env.DSH_SDK_ROOT && 'Set DSH_SDK_ROOT to run the installed SDK integration' }, async t => {
  const require = createRequire(join(process.env.DSH_SDK_ROOT, 'package.json'));
  const { ToolExecutionPipeline } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools/pipeline')).href);
  const guards = [], handlers = new Map();
  let shellCalls = 0;
  const tool = { name: 'bash', output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] }, execute: async () => { shellCalls++; return {}; } };
  const tools = { register: () => () => {}, guard: fn => { guards.push(fn); return () => {}; }, checkGuards: call => guards.map(guard => guard(call)).find(Boolean) };
  const ctx = { tools, get: name => name === 'tools' ? tools : undefined, on: (name, fn) => { handlers.set(name, fn); return () => {}; }, waterfall: async (...args) => args.at(-1)() };
  await applyGates(ctx);
  const pipeline = new ToolExecutionPipeline(ctx, { get: () => tool });
  const execute = async command => {
    const prepared = await pipeline.prepare({ ...exec(command), callId: 'fixture', signal: new AbortController().signal });
    if (prepared.kind === 'dispatch') return pipeline.dispatch(prepared.exec);
    return prepared;
  };
  for (const command of ['mcp2cli "$SERVER" update-index', '"mcp2cli" @github list-pulls', 'env mcp2cli @github list-pulls', 'bash -c "mcp2cli @github list-pulls"', 'MCP=mcp2cli; $MCP @chat-search-mcp rebuild-index']) {
    const result = await execute(command);
    assert.equal(result.result.isError, true);
    assert.match(result.result.error.message, /MCP gate/);
  }
  const observe = handlers.get('tools/result');
  observe({ name: 'skill', arguments: { name: 'mcp-router' }, agent: exec('').agent }, { isError: false });
  for (const [label, executable] of [['split quotes', "mcp''2cli"], ['backslash', 'mcp\\2cli']]) {
    await t.test(label, async () => {
      const result = await execute(`${executable} @github list-pulls`);
      assert.equal(result.result.isError, true);
      assert.match(result.result.error.message, /MCP gate/);
      const discovery = await execute(`${executable} @github --list`);
      assert.equal(discovery.result.isError, true);
      observe(exec(`${executable} @github --list`), discovery.result);
      assert.match(guards[0](exec('mcp2cli @github list-pulls')), /--list/);
    });
  }
  assert.equal(shellCalls, 0);
  assert.equal((await execute('pwd')).result.isError, false);
  assert.equal((await execute("echo 'mcp''2cli is prose'")).result.isError, false);
  assert.equal(shellCalls, 2);
});

test('direct discovery and only the approved refresh exception survive the gate', async () => {
  const guards = [], handlers = new Map();
  const ctx = { get: name => name === 'tools' ? { register: () => () => {}, guard: fn => { guards.push(fn); return () => {}; } } : undefined,
    on: (name, fn) => { handlers.set(name, fn); return () => {}; } };
  await applyGates(ctx);
  const observe = handlers.get('tools/result');
  observe({ name: 'skill', arguments: { name: 'mcp-router' }, agent: exec('').agent }, { isError: false });
  observe(exec('mcp2cli @chat-search-mcp --list'), completed());
  observe(exec('mcp2cli @chat-search-mcp update-index --help'), completed());
  observe(exec('mcp2cli @chat-search-mcp update-embeddings --help'), completed());
  assert.equal(guards[0](exec('mcp2cli @chat-search-mcp update-index')), undefined);
  assert.match(guards[0](exec('mcp2cli @chat-search-mcp update-embeddings')), /maintenance/);
});
