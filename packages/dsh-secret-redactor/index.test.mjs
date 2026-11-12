import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.mjs';
import { redactToolResult } from './tool-result-policy.mjs';

const canary = 'sk-or-v1-' + 'SYNTHETICSECRET'.repeat(3);
test('redaction replaces canonical values, blocks metadata and leaves originals unchanged', () => {
  const original = { value: { stdout: { text: canary } }, content: [{ type: 'text', text: canary }] };
  const redacted = redactToolResult(original);
  assert.equal(redacted.decision.kind, 'accept');
  assert.ok(!JSON.stringify(redacted.decision).includes(canary));
  assert.equal(original.value.stdout.text, canary);
  for (const field of ['error', 'meta', 'additionalContexts']) {
    assert.equal(redactToolResult({ [field]: { text: canary } }).decision.kind, 'block');
  }
});

test('plugin installs one fail-closed post-execution redaction hook', async () => {
  let handler, removed = false;
  const ctx = { get: () => undefined, on(event, fn) { assert.equal(event, 'tools/post-execute'); handler = fn; return () => { removed = true; }; } };
  const dispose = apply(ctx);
  assert.equal((await handler({ name: 'bash' }, { value: canary }, () => null)).kind, 'accept');
  assert.equal(await handler({}, { value: 'clean' }, () => 'next'), 'next');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal((await handler({}, { value: cyclic }, () => null)).kind, 'block');
  dispose();
  assert.equal(removed, true);
});
