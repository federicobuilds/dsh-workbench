import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.mjs';

test('registers only resource and releases its owned domain and hooks', async () => {
  const definitions = new Map(), hooks = new Set(), guards = new Set();
  let closed = 0;
  const storage = {
    get: () => null,
    async open(spec) {
      const tables = new Map(Object.keys(spec.tables).map(name => [name, new Map()]));
      return { table: name => tables.get(name), close: () => { closed++; } };
    },
  };
  const tools = {
    register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); },
    guard(fn) { guards.add(fn); return () => guards.delete(fn); },
  };
  const ctx = {
    get: key => ({ tools, storageDomain: storage, fs: {} })[key],
    on(_event, fn) { hooks.add(fn); return () => hooks.delete(fn); },
  };
  const dispose = await apply(ctx);
  assert.deepEqual([...definitions.keys()], ['resource']);
  assert.equal(guards.size, 1);
  await dispose();
  assert.equal(definitions.size, 0);
  assert.equal(guards.size, 0);
  assert.equal(hooks.size, 0);
  assert.equal(closed, 1);
});
