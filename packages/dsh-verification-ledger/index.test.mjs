import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.mjs';

test('plugin registers check and efficiency and closes owned domains', async () => {
  const definitions = new Map();
  const hooks = new Set();
  const guards = new Set();
  const domains = new Map();
  let closed = 0;
  const storage = {
    get: (name) => domains.get(name),
    async open(spec) {
      const tables = new Map(Object.keys(spec.tables).map((name) => [name, new Map()]));
      const domain = { table: (name) => tables.get(name), close: () => { closed++; } };
      domains.set(spec.name, domain);
      return domain;
    },
  };
  const tools = {
    register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); },
    guard(fn) { guards.add(fn); return () => guards.delete(fn); },
  };
  const ctx = {
    get: (key) => ({ tools, storageDomain: storage, fs: {} })[key],
    on(_event, fn) { hooks.add(fn); return () => hooks.delete(fn); },
  };
  const dispose = await apply(ctx);
  assert.deepEqual([...definitions.keys()], ['check', 'efficiency_override']);
  assert.equal(guards.size, 1);
  await dispose();
  assert.equal(definitions.size, 0);
  assert.equal(guards.size, 0);
  assert.equal(hooks.size, 0);
  assert.equal(closed, 1);
});
