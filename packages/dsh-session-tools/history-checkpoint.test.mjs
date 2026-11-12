import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildAuthoredCheckpoint } from './history-checkpoint.mjs';

const sdk = process.env.DSH_SDK_ROOT ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const req = createRequire(`${sdk}/package.json`);
const catalog = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href);
const session = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session')).href);
const messages = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);

/** Replay the full physical history with the actual current-format validator. */
function validate(artifact) {
  const reader = catalog.sessionFormatCatalog.createRestore(artifact.header, { validation: 'current' });
  for (const event of artifact.events) reader.decodeRow(event);
  return reader.finish();
}

/** Create a closed native history with old context and a current unanswered request. */
function fixture() {
  const events = [];
  const add = (type, data, extra = {}) => events.push({ seq: events.length, time: 1, type, data, ...extra });
  add('turn/start', { turn: 1 });
  add('step/start', { turn: 1, step: 1 });
  add('system/message', { turn: 1, step: 1, message: messages.createSystemMessage('Preserve the protected system instructions.') }, { surfaceOp: 'append' });
  add('user/message', messages.createUserMessage({ content: [{ type: 'text', text: 'Historical context that must remain archived. '.repeat(500) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  add('step/end', { turn: 1, step: 1 });
  add('turn/end', { turn: 1, reason: 'completed' });
  add('user/message', messages.createUserMessage({ content: [{ type: 'text', text: 'Continue the unfinished task.' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  return { header: { type: 'session', version: 4, id: 'checkpoint-fixture', createdAt: 1, cwd: '/tmp', delegationDepth: 0, isSeeded: false }, events, inheritedEventCount: 0 };
}

/** Prepare a checkpoint using native message construction and surface folding. */
function checkpoint(artifact, summary) {
  return buildAuthoredCheckpoint(artifact, { summary, foldSurface: session.foldSurface, createUserMessage: messages.createUserMessage, validate });
}

test('checkpoint shortens model context without deleting original events or the protected head', () => {
  const original = fixture();
  validate(original);
  const result = checkpoint(original, 'The earlier task is unfinished. Verify current files before continuing.');
  assert.deepEqual(result.artifact.events.slice(0, original.events.length), original.events);
  assert.equal(result.addedEvents, 4);
  const surface = session.foldSurface(result.artifact.events);
  const nodes = surface.nodes.map(seq => ({ message: surface.projectedMessages.get(seq) ?? result.artifact.events[seq].data.message ?? result.artifact.events[seq].data }));
  assert.equal(nodes[0].message.role, 'system');
  assert.equal(nodes.at(-1).message.content[0].text, 'Continue the unfinished task.');
  assert.equal(nodes[1].message.source.kind, 'compact-checkpoint');
  assert.ok(result.afterCharacters < result.beforeCharacters / 10);
  validate(result.artifact);
});

test('empty and oversized summaries are refused before any event is added', () => {
  const original = fixture();
  const before = JSON.stringify(original);
  assert.throws(() => checkpoint(original, '   '), /empty/);
  assert.throws(() => checkpoint(original, 'x'.repeat(20001)), /20000/);
  assert.equal(JSON.stringify(original), before);
});

test('repeating the same authored checkpoint does not create another compaction', () => {
  const first = checkpoint(fixture(), 'Keep the current task and verify the next action.');
  const again = checkpoint(first.artifact, 'Keep the current task and verify the next action.');
  assert.equal(again.addedEvents, 0);
  assert.deepEqual(again.artifact, first.artifact);
});

test('an open turn is never silently discarded to perform compaction', () => {
  const original = fixture();
  original.events.push({ seq: original.events.length, time: 2, type: 'turn/start', data: { turn: 2 } });
  assert.throws(() => checkpoint(original, 'Keep all history.'), /idle/);
});

test('imported status notifications cannot displace the last genuine human request', () => {
  const original = fixture();
  original.events.push({ seq: original.events.length, time: 2, type: 'user/message', surfaceOp: 'append', data: messages.createUserMessage({ content: [{ type: 'text', text: '<kilo-part type="metadata">{"state":"complete"}</kilo-part>' }], source: { kind: 'user' } }) });
  const result = checkpoint(original, 'Continue the current task without redoing historical work.');
  const visible = session.foldSurface(result.artifact.events).nodes.map(seq => result.artifact.events[seq]);
  assert.ok(visible.some(event => event.data?.content?.[0]?.text === 'Continue the unfinished task.'));
  assert.ok(visible.some(event => event.seq === original.events.length - 1));
});
