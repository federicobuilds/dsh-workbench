import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { recoverSystemHead } from './history-recovery.mjs';
import { guardSessionSystemHead } from './history-write-guard.mjs';

const sdk = process.env.DSH_SDK_ROOT ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const requireSdk = createRequire(`${sdk}/package.json`);
const native = await import(pathToFileURL(requireSdk.resolve('@deepseek-ai/dsh-session-format-catalog')).href);
const messages = await import(pathToFileURL(requireSdk.resolve('@deepseek-ai/dsh-llm')).href);
const sessions = await import(pathToFileURL(requireSdk.resolve('@deepseek-ai/dsh-session')).href);

/** Validate every event through the installed host's current-format reader. */
function validate(artifact) {
  const reader = native.sessionFormatCatalog.createRestore(artifact.header, { validation: 'current' });
  for (const event of artifact.events) reader.decodeRow(event);
  return reader.finish();
}

/** Build the smallest legacy history that reproduces the late-system-head failure. */
function fixture(withSystem = true) {
  const header = { type: 'session', version: 4, id: 'history-recovery-fixture', createdAt: 1, cwd: '/tmp', delegationDepth: 0, isSeeded: false };
  const events = [];
  const add = (type, data, extra = {}) => events.push({ seq: events.length, time: 1, type, data, ...extra });
  add('user/message', messages.createUserMessage({ content: [{ type: 'text', text: 'Keep the original request and all its numbers: 0, 1, 3.' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  add('session/title', { title: 'Recover me', messageSeqs: [], source: { kind: 'user' } });
  add('turn/start', { turn: 1 });
  add('step/start', { turn: 1, step: 1 });
  if (withSystem) add('system/message', { turn: 1, step: 1, message: messages.createSystemMessage('Current system instructions.') }, { surfaceOp: 'append' });
  add('step/end', { turn: 1, step: 1 });
  add('turn/end', { turn: 1, reason: 'completed' });
  return { header, events, inheritedEventCount: 0 };
}

/** Supply a distinct native system baseline without reinterpreting user text. */
function baseline() {
  return messages.createSystemMessage('Recovered legacy history. Follow the current DSH system configuration and current user request.');
}

test('native reader reproduces the late protected-head error', () => {
  assert.throws(() => validate(fixture()), /requires a protected first surface head/);
});

test('copy-only repair preserves identity, original messages and source bytes while native restore passes', () => {
  const original = fixture();
  const before = JSON.stringify(original);
  const repaired = recoverSystemHead(original, { systemMessage: baseline(), validate });
  assert.equal(JSON.stringify(original), before);
  assert.equal(repaired.artifact.header.id, original.header.id);
  assert.equal(repaired.addedEvents, 5);
  assert.equal(repaired.artifact.events.length, original.events.length + 5);
  for (const event of original.events) {
    const next = repaired.artifact.events[event.seq + 5];
    assert.equal(next.type, event.type);
    if (event.type.endsWith('/message')) assert.deepEqual(next.data.message ?? next.data, event.data.message ?? event.data);
  }
  assert.deepEqual(repaired.artifact.events[9].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 });
  validate(repaired.artifact);
});

test('valid legacy history without any system head gains a baseline before resume', () => {
  const original = fixture(false);
  validate(original);
  const repaired = recoverSystemHead(original, { systemMessage: baseline(), validate });
  assert.equal(repaired.addedEvents, 5);
  validate(repaired.artifact);
});

test('repair is idempotent for an already protected history', () => {
  const repaired = recoverSystemHead(fixture(), { systemMessage: baseline(), validate });
  const twice = recoverSystemHead(repaired.artifact, { systemMessage: baseline(), validate });
  assert.equal(twice.addedEvents, 0);
  assert.deepEqual(twice.artifact, repaired.artifact);
});

test('unrelated structural corruption is refused rather than repaired by truncation', () => {
  const broken = fixture(false);
  broken.events[2].data.turn = 4;
  assert.throws(() => recoverSystemHead(broken, { systemMessage: baseline(), validate }), /expected turn/);
});

test('native source references and message-edit bounds are shifted, not numeric message content', () => {
  const original = fixture();
  original.events.push({ seq: 7, time: 2, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0], data: messages.createUserMessage({ content: [{ type: 'text', text: 'Edited request with literal sequence 0.' }], source: { kind: 'message-edit-cut', targetSeq: 0, endSeq: 0 } }) });
  const repaired = recoverSystemHead(original, { systemMessage: baseline(), validate });
  const edit = repaired.artifact.events[12];
  assert.deepEqual(edit.surfaceOp, { op: 'replace', startSeq: 5, endSeq: 5 });
  assert.deepEqual(edit.sourceEventSeqs, [5]);
  assert.deepEqual(edit.data.source, { kind: 'message-edit-cut', targetSeq: 5, endSeq: 5 });
  assert.equal(edit.data.content[0].text, 'Edited request with literal sequence 0.');
});

test('write guard stops the real native late-system append before it poisons a legacy log', () => {
  const input = fixture(false);
  const restored = validate(input);
  const session = sessions.Session.fromRestore(sessions.SessionId(input.header.id), restored.events, restored.header, sessions.SessionLogOffset(0), 'detached');
  const release = guardSessionSystemHead(session);
  session.append('turn/start', { turn: 2 });
  session.append('step/start', { turn: 2, step: 1 });
  const before = session.seq;
  assert.throws(() => session.append('system/message', { turn: 2, step: 1, message: baseline() }, { surfaceOp: 'append' }), { code: 'HISTORY_SYSTEM_HEAD_REQUIRED' });
  assert.equal(session.seq, before);
  release();
});

test('write guard leaves legitimate first-system writes and unload semantics intact', () => {
  const input = fixture(false);
  const session = sessions.Session.fromRestore(sessions.SessionId('new-history'), [], { ...input.header, id: 'new-history' }, sessions.SessionLogOffset(0), 'detached');
  const original = session.append;
  const release = guardSessionSystemHead(session);
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  assert.doesNotThrow(() => session.append('system/message', { turn: 1, step: 1, message: baseline() }, { surfaceOp: 'append' }));
  release();
  assert.equal(session.append, original);
  release();
});
