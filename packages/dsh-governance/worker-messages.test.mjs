import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerMessages, ownedWorker, publicMessage } from './worker-messages.mjs';

function makeContext() {
  const secretKey = `sk-or-v1-${'a'.repeat(32)}`;
  const sessions = new Map([
    [
      'root-session',
      {
        id: 'root-session',
        header: { origin: 'user', title: 'Coordinator' },
        deriveMessages: () => [{ id: 'r1', role: 'user', content: [{ type: 'text', text: 'root prompt' }] }],
      },
    ],
    [
      'child-1',
      {
        id: 'child-1',
        header: { origin: 'subagent', parentSession: 'root-session', title: 'Executor U1', createdAt: 1000 },
        deriveMessages: () => [
          {
            id: 'm1',
            role: 'user',
            createdAt: 1001,
            content: [{ type: 'text', text: 'Execute unit U1' }],
          },
          {
            id: 'm2',
            role: 'assistant',
            createdAt: 1002,
            content: [
              { type: 'thinking', text: 'private internal reasoning that must never appear' },
              { type: 'reasoning', text: 'another private reasoning block' },
              { type: 'text', text: `Running check with key ${secretKey}` },
              {
                type: 'tool',
                id: 't1',
                tool: 'bash',
                callID: 'c1',
                state: { status: 'completed', input: { command: 'echo ok' }, output: `out:${secretKey}` },
              },
            ],
          },
          {
            id: 'm3',
            role: 'assistant',
            createdAt: 1003,
            content: [{ type: 'text', text: `Final handback: ${'X'.repeat(500)}` }],
          },
        ],
      },
    ],
    [
      'grandchild-1',
      {
        id: 'grandchild-1',
        header: { origin: 'subagent', parentSession: 'child-1', title: 'Nested Auditor', createdAt: 2000 },
        deriveMessages: () => [
          { id: 'gm1', role: 'assistant', createdAt: 2001, content: [{ type: 'text', text: 'Grandchild report' }] },
        ],
      },
    ],
    [
      'seeded-fork',
      {
        id: 'seeded-fork',
        header: { origin: 'fork', parentSession: 'root-session', title: 'Forked Session' },
        deriveMessages: () => [
          { id: 'fm1', role: 'user', content: [{ type: 'text', text: 'fork content' }] },
        ],
      },
    ],
    [
      'unrelated',
      {
        id: 'unrelated',
        header: { origin: 'subagent', parentSession: 'other-root', title: 'Other Worker' },
        deriveMessages: () => [],
      },
    ],
  ]);

  const agents = new Map([
    ['child-1', { id: 'child-1', status: 'running', session: sessions.get('child-1') }],
  ]);

  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => sessions.get(id),
          values: () => sessions.values(),
        };
      }
      if (name === 'agents') {
        return {
          get: (id) => agents.get(id),
          values: () => agents.values(),
        };
      }
      return undefined;
    },
  };

  return { ctx, sessions, secretKey };
}

test('ownedWorker verifies subagent ancestry and refuses self, non-descendants, and non-subagent forks', () => {
  const { ctx } = makeContext();

  assert.equal(ownedWorker(ctx, 'root-session', 'child-1').id, 'child-1');
  assert.equal(ownedWorker(ctx, 'root-session', 'grandchild-1').id, 'grandchild-1');
  assert.equal(ownedWorker(ctx, 'child-1', 'grandchild-1').id, 'grandchild-1');

  // Self is refused
  assert.throws(
    () => ownedWorker(ctx, 'root-session', 'root-session'),
    /not the calling session/,
  );
  // Parent from child is refused
  assert.throws(
    () => ownedWorker(ctx, 'child-1', 'root-session'),
    /not a verified descendant/,
  );
  // Unrelated session is refused
  assert.throws(
    () => ownedWorker(ctx, 'root-session', 'unrelated'),
    /not a verified descendant/,
  );
  // Seeded fork (origin !== 'subagent') is refused even if parentSession points to caller
  assert.throws(
    () => ownedWorker(ctx, 'root-session', 'seeded-fork'),
    /not a verified descendant/,
  );
});

test('worker_messages list and read support pagination, message slicing, reasoning exclusion, and secret redaction', async () => {
  const { ctx, secretKey } = makeContext();
  const wm = createWorkerMessages(ctx);
  const callerExec = { agent: { session: { id: 'root-session' } } };

  // 1) List direct child workers of caller
  const listed = await wm.execute({ action: 'list' }, callerExec);
  assert.equal(listed.parent, 'root-session');
  assert.equal(listed.workers.length, 1);
  assert.equal(listed.workers[0].id, 'child-1');
  assert.equal(listed.workers[0].status.type, 'running');

  // 2) Read latest messages with pagination (limit=2)
  const page1 = await wm.execute({ action: 'read', session_id: 'child-1', limit: 2 }, callerExec);
  assert.equal(page1.session_id, 'child-1');
  assert.deepEqual(page1.messages.map((m) => m.id), ['m2', 'm3']);
  assert.equal(page1.next_cursor, 'm2');

  // Reasoning blocks must be stripped and secrets redacted
  const m2Content = page1.messages[0].content;
  assert.ok(!m2Content.includes('private internal reasoning'));
  assert.ok(!m2Content.includes('another private reasoning block'));
  assert.ok(!m2Content.includes(secretKey));
  assert.match(m2Content, /\[REDACTED\]/);

  // 3) Read older page using before=next_cursor
  const page2 = await wm.execute({ action: 'read', session_id: 'child-1', before: page1.next_cursor, limit: 2 }, callerExec);
  assert.deepEqual(page2.messages.map((m) => m.id), ['m1']);
  assert.equal(page2.next_cursor, null);

  // 4) Read single message with offset and length slicing
  const slice1 = await wm.execute(
    { action: 'read', session_id: 'child-1', message_id: 'm3', offset: 0, length: 200 },
    callerExec,
  );
  assert.equal(slice1.message_id, 'm3');
  assert.equal(slice1.content.length, 200);
  assert.equal(slice1.next_offset, 200);
  assert.ok(slice1.total_chars > 200);

  const slice2 = await wm.execute(
    { action: 'read', session_id: 'child-1', message_id: 'm3', offset: slice1.next_offset, length: 600 },
    callerExec,
  );
  assert.equal(slice1.content + slice2.content, publicMessage(ctx.get('sessions').get('child-1').deriveMessages()[2]));
});
