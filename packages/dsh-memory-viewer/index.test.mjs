import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.mjs';

test('plugin registers memory_preview and removes its hooks on disposal', async () => {
  const hooks = new Set();
  let definition;
  const tools = { register(def) { definition = def; return () => { definition = null; }; } };
  const ctx = {
    get: (key) => key === 'tools' ? tools : undefined,
    on(_event, fn) { hooks.add(fn); return () => hooks.delete(fn); },
  };
  const dispose = apply(ctx);
  assert.equal(definition.name, 'memory_preview');
  assert.equal(hooks.size, 2);
  await dispose();
  assert.equal(definition, null);
  assert.equal(hooks.size, 0);
});
