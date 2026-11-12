import test from 'node:test';
import assert from 'node:assert/strict';
import { setTrack, selectedTrack, trackPolicyReader } from './tracks.mjs';
import { resolvePolicy } from './policy.mjs';

function fixture(headers = { root: { id: 'root' } }, presets = {}) {
  const records = new Map(); const writes = [];
  const domain = { table: () => ({ get: id => records.get(id), put: async (id, value) => { writes.push(value); records.set(id, value); } }) };
  const sessions = new Map(Object.entries(headers).map(([id, header]) => [id, { id, header }]));
  const services = { storageDomain: { get: () => domain }, sessions: { get: id => sessions.get(id) }, agentPresets: { presetForSession: s => presets[s.id] } };
  return { ctx: { get: name => services[name] }, domain, records, writes };
}
test('first selection is durable, read back and revision-bound; stale save does not overwrite', async () => {
  const f = fixture();
  const chosen = await setTrack(f.ctx, 'root', 'simple', 0);
  assert.equal(chosen.mode, 'simple'); assert.equal(chosen.revision, 1);
  assert.equal(resolvePolicy('root', trackPolicyReader(f.ctx)).mode, 'simple');
  await assert.rejects(setTrack(f.ctx, 'root', 'advanced', 0), /another window/);
  assert.equal(selectedTrack(f.domain, 'root').mode, 'simple'); assert.equal(f.writes.length, 1);
});
test('two simultaneous revision-zero saves cannot both win', async () => {
  const f = fixture();
  const results = await Promise.allSettled([setTrack(f.ctx, 'root', 'simple', 0), setTrack(f.ctx, 'root', 'advanced', 0)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.writes.length, 1);
});
test('real subagent ancestry inherits Off and refuses conflicting family selection', async () => {
  const headers = { root: { id: 'root' }, child: { id: 'child', origin: 'subagent', parentSession: 'root' } };
  const f = fixture(headers);
  await setTrack(f.ctx, 'root', 'simple', 0);
  assert.equal(resolvePolicy('child', trackPolicyReader(f.ctx)).mode, 'simple');
  await assert.rejects(setTrack(f.ctx, 'child', 'advanced', 0), /conflict/);
  assert.equal(selectedTrack(f.domain, 'child'), null);
  await setTrack(f.ctx, 'root', 'off', 1);
  assert.equal(resolvePolicy('child', trackPolicyReader(f.ctx)).mode, 'off');
  await assert.rejects(setTrack(f.ctx, 'child', 'free', 0), /Off/);
  assert.equal((await setTrack(f.ctx, 'child', 'off', 0)).mode, 'off');
});
test('ordinary historical fork is independent; missing subagent ancestor fails closed', () => {
  const f = fixture({ root: { id: 'root' }, fork: { id: 'fork', isSeeded: true, parentSession: 'root' }, orphan: { id: 'orphan', origin: 'subagent', parentSession: 'missing' } }, { root: 'dsh-coordinator-advanced' });
  assert.equal(resolvePolicy('fork', trackPolicyReader(f.ctx)).state, 'absent');
  assert.throws(() => resolvePolicy('orphan', trackPolicyReader(f.ctx)), /unreadable ancestry/);
});
test('track selector does not accept malformed revisions or modes', async () => {
  const f = fixture();
  await assert.rejects(setTrack(f.ctx, 'root', 'premium', 0), /Invalid/);
  await assert.rejects(setTrack(f.ctx, 'root', 'free', -1), /Invalid/);
  assert.equal(f.writes.length, 0);
});
