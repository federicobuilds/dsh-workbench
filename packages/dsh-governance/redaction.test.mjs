import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from './redaction.mjs';
import { makeEvent, createEventStore } from './event-store.mjs';
const CANARIES = ['sk-or-v1-'+'X'.repeat(25), 'sk-'+'Y'.repeat(36), 'ghp_'+'Z'.repeat(32), 'github_pat_'+'Q'.repeat(44), 'BSA'+'A'.repeat(25), 'AKIA'+'A'.repeat(16), '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC ONLY\n-----END RSA PRIVATE KEY-----'];
test('all seven configured secret shapes are redacted consistently', () => {
  for (const canary of CANARIES) {
    const value = redactText('before '+canary+' after');
    assert.equal(value.hits, 1); assert.equal(value.text, 'before [REDACTED] after');
  }
});
test('event insertion scrubs values without mutating borrowed records or native identity', async () => {
  let stored;
  const store = createEventStore({ table: () => ({ put: async (_id, value) => { stored = value; }, entries: () => [] }) });
  const event = { v: 1, id: 'event-id', session: 'session-id', ts: 1, kind: 'mcp-gate', decision: 'denied', reason: CANARIES.join(' ') };
  await store.record(event);
  for (const canary of CANARIES) assert.ok(!stored.reason.includes(canary));
  assert.equal(stored.id, event.id); assert.equal(stored.session, event.session); assert.equal(event.reason, CANARIES.join(' '));
  await assert.rejects(store.record({ ...event, privatePayload: { raw: 'not metadata' } }), /flat metadata/);
});
test('redaction precedes display truncation, including a long PEM at the cutoff', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\n'+'SYNTHETIC'.repeat(60)+'\n-----END PRIVATE KEY-----';
  const event = makeEvent({ kind: 'info', decision: 'test', reason: 'x'.repeat(580)+pem });
  assert.ok(event.reason.endsWith('[REDACTED]')); assert.ok(!event.reason.includes('BEGIN'));
});
