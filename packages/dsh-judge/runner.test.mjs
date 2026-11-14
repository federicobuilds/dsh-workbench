import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@dsh-workbench/dsh-governance/judge-registry') return { url: new URL('../dsh-governance/judge-config.mjs', import.meta.url).href, shortCircuit: true };
  const harness = { '@dsh-workbench/dsh-governance/policy': 'policy.mjs', '@dsh-workbench/dsh-governance/tracks': 'tracks.mjs', '@dsh-workbench/dsh-governance/events': 'event-store.mjs', '@dsh-workbench/dsh-governance/redaction': 'redaction.mjs' };
  if (harness[specifier]) return { url: new URL(`../dsh-governance/${harness[specifier]}`, import.meta.url).href, shortCircuit: true };
  if (specifier === '@deepseek-ai/cordis') return { url: 'data:text/javascript,export class Service { constructor() {} }', shortCircuit: true };
  if (specifier === '@deepseek-ai/dsh-llm') return { url: 'data:text/javascript,export const createUserMessage = value => value', shortCircuit: true };
  return next(specifier, context);
} });
const { createOriginalJudge, OPERATIONS } = await import('./runner.mjs');
import { routerInput, routerNote } from './router.mjs';

function fakeLaunch(capture) {
  return (exe, args, opts) => {
    capture.calls++; capture.opts = opts;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => queueMicrotask(() => {
      capture.input = JSON.parse(input);
      child.stdout.write(Buffer.from('{"decision":"frontend","why":"fixt')); child.stdout.write(Buffer.from('ure café"}'));
      child.emit('close', 0);
    }));
    return child;
  };
}
test('authorization refusal and cancellation launch no interpreter or decision request', async () => {
  const capture = { calls: 0 };
  const runner = createOriginalJudge({ launch: fakeLaunch(capture) });
  const denied = await runner.decide({ operation: 'skill', family: 'simple', state: 'task' });
  assert.equal(denied.decision, 'UNSURE'); assert.equal(capture.calls, 0);
  const controller = new AbortController(); controller.abort();
  await runner.decide({ operation: 'skill', family: 'simple', state: 'task' }, { signal: controller.signal });
  assert.equal(capture.calls, 0); assert.ok(OPERATIONS.includes('task-organization'));
});
test('authorized wrapper sends bounded data on stdin and preserves Unicode response', async () => {
  const capture = { calls: 0 };
  const runner = createOriginalJudge({ authorizeOperation: () => true, launch: fakeLaunch(capture) });
  const result = await runner.decide({ operation: 'skill', family: 'simple', state: { message: 'Inspect repository and build accessible web interface' }, skills: {} });
  assert.equal(capture.calls, 1); assert.equal(capture.input.operation, 'skill');
  assert.equal(capture.opts.env.JUDGE_BASE_URL, 'http://127.0.0.1:8043');
  assert.equal(result.why, 'fixture café'); assert.equal(result.permissionGranted, false);
});
test('router skips short/nonhuman/worker input and appends only validated positive advice', () => {
  const agent = { session: { header: {}, deriveMessages: () => [] } };
  const human = { id: 'msg', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build an accessible web interface for this application' }] };
  assert.ok(routerInput({ agent, messages: [human] }));
  assert.equal(routerInput({ agent, messages: [{ ...human, source: { kind: 'dsh-judge-router' } }] }), null);
  assert.equal(routerInput({ agent: { session: { header: { origin: 'subagent' } } }, messages: [human] }), null);
  assert.equal(routerNote({ decision: 'none' }, { frontend: {} }), null);
  const note = routerNote({ decision: 'frontend', mcp: 'github' }, { frontend: {} });
  assert.match(note, /skill\(name="frontend"\)/); assert.match(note, /mcp2cli @github --list/);
  assert.ok(!note.includes('~/.kilocode')); assert.match(note, /grants no permission/);
});

test('cancellation waits for observed close and escalates an unresponsive owned child', async () => {
  const signals = [];
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal)); return true; };
  const runner = createOriginalJudge({ authorizeOperation: () => true, launch: () => child });
  const controller = new AbortController();
  const pending = runner.decide({ operation: 'skill', family: 'simple', state: 'fixture' }, { signal: controller.signal });
  await Promise.resolve(); controller.abort();
  const result = await pending;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.terminationObserved, true);
});

test('router reports unavailable without overriding an existing denial or locking an allowed turn', async () => {
  const { apply } = await import('./index.mjs');
  let hook;
  const ctx = { effect() {}, on: (name, fn) => { if (name === 'agent/pre-step') hook = fn; },
    get(name) { if (name === 'tools') return { register() {} }; if (name === 'skills') return { snapshot: async () => { throw new Error('offline'); } }; } };
  apply(ctx, { allowLocalInference: true });
  const agent = { session: { id: 's', header: {}, deriveMessages: () => [] } };
  const message = { id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build a useful interface for this local application' }] };
  assert.equal((await hook({ agent, messages: [message] }, () => ({ kind: 'reject' }))).kind, 'reject');
  const result = await hook({ agent, messages: [message] }, () => ({ kind: 'enter', messages: [] }));
  assert.equal(result.kind, 'enter'); assert.match(result.messages[0].content[0].text, /status: unavailable/);
});

test('cancellation reports an unobserved termination when even kill receives no close', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  const runner = createOriginalJudge({ authorizeOperation: () => true, launch: () => child });
  const controller = new AbortController();
  const pending = runner.decide({ operation: 'skill', family: 'simple', state: 'fixture' }, { signal: controller.signal });
  await Promise.resolve(); controller.abort();
  assert.equal((await pending).terminationObserved, false);
});
