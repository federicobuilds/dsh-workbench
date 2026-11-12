import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpGateDecision, emptySeen } from './gates.mjs';
import { mcpGateDecision as bundledDecision } from '../dsh-governance/gates.mjs';
import { applyGates as applyBundledGates } from '../dsh-governance/gates-core.mjs';

test('passive inspection is not an MCP invocation or discovery receipt', () => {
  for (const decide of [mcpGateDecision, bundledDecision]) {
    for (const command of ['ls -la ~/.local/bin/mcp2cli', 'file ~/.local/bin/mcp2cli', 'head -n 20 ~/.local/bin/mcp2cli', 'pwd; which bx; which mcp2cli; ls -la ~/.local/bin | head -n 10', 'ls "/a path/mcp2cli"']) {
      assert.deepEqual(decide(command, emptySeen()), { ok: true, discovery: [] }, command);
    }
    for (const command of ['ls ~/.local/bin/mcp2cli; mcp2cli @alpha purge', 'file "$(mcp2cli @alpha purge)"', 'head ~/.local/bin/mcp2cli | sh', 'ls ~/.local/bin/mcp2cli > output.txt']) {
      assert.equal(decide(command, emptySeen()).ok, false, command);
    }
  }
});

test('bundled maintenance authorization requires an affirmative exact request', async () => {
  const hooks = new Map();
  let guard;
  const ctx = { get: name => name === 'tools' ? { register() {}, guard(fn) { guard = fn; } } : undefined, on(name, fn) { hooks.set(name, fn); } };
  await applyBundledGates(ctx);
  const agent = { session: { id: 'bundled-grants' } };
  const ok = { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: 'complete', truncated: false }, stderr: { truncated: false } } };
  hooks.get('tools/result')({ name: 'skill', arguments: { name: 'mcp-router' }, agent }, { isError: false });
  for (const command of ['mcp2cli @alpha --list', 'mcp2cli @alpha rebuild-index --help']) hooks.get('tools/result')({ name: 'bash', arguments: { command }, agent }, ok);
  const ask = text => hooks.get('agent/pre-step')({ agent, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] }, () => null);
  const invoke = () => guard({ name: 'bash', arguments: { command: 'mcp2cli @alpha rebuild-index' }, agent });
  await ask('do not run mcp2cli @alpha rebuild-index');
  assert.match(invoke(), /did not request/);
  await ask('run mcp2cli @alpha rebuild-index');
  assert.equal(invoke(), undefined);
});
