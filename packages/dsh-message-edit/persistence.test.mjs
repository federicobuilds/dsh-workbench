import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitEdit } from './journal.mjs'
import { installedSessionReader } from './persistence-reader.mjs'
import { zstdCompressSync } from 'node:zlib'

const readSession = installedSessionReader()
const header = { type: 'session', version: 4, id: 'edit-persistence-test', createdAt: 1,
  isSeeded: false, delegationDepth: 0 }
const serialize = events => Buffer.from([header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n')
function fixture() {
  const message = { id: 'user-1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Original question' }] }
  const events = [{ type: 'user/message', seq: 0, time: 1, data: message, surfaceOp: 'append' }]
  const session = { surface: { nodes: [0] }, get seq() { return events.length },
    snapshotEvents: () => [...events], deriveEventMessage: event => event.type === 'user/message' ? event.data : undefined,
    append(type, data) { const event = { type, seq: events.length, time: 1, data }; events.push(event); return event } }
  return { session, events, request: { version: 3, targetSeq: 0, revision: 0,
    messageId: message.id, role: 'user', text: 'Edited question' } }
}

test('message-edit receipts survive the installed durable session reader', () => {
  const { session, events, request } = fixture()
  commitEdit(session, request, 'edit-1')
  const restored = readSession(serialize(events))
  assert.equal(restored.events.length, events.length)
  assert.equal(restored.events.at(-1).data.sourceEventSeq, request.targetSeq)
})

test('compressed session header remains independently readable for session listing', () => {
  const { session, events, request } = fixture()
  commitEdit(session, request, 'edit-1')
  const raw = serialize(events)
  const headerEnd = raw.indexOf(10) + 1
  const compressed = Buffer.concat([zstdCompressSync(raw.subarray(0, headerEnd)),
    zstdCompressSync(raw.subarray(headerEnd))])
  const restored = readSession.compressed(compressed)
  assert.equal(restored.frameCount, 2)
  assert.equal(restored.events.length, events.length)
  assert.throws(() => readSession.compressed(zstdCompressSync(raw)), /first frame is not exactly one header line/)
})

test('the installed reader catches the original command/run reference defect', () => {
  const { session, events, request } = fixture()
  commitEdit(session, request, 'edit-1')
  events.at(-1).data.sourceEventSeq = events.at(-2).seq
  assert.throws(() => readSession(serialize(events)), /invalid sourceEventSeq/)
})

test('in-place user cut events survive the installed durable session reader', () => {
  const { events, request } = fixture()
  const cutPayload = { version: 3, kind: 'cut', targetSeq: 0, endSeq: 0,
    messageId: request.messageId, replacementMessageId: 'user-2', text: request.text }
  events.push({ type: 'command/run', seq: 1, time: 2,
    data: { commandId: 'cut-1', name: 'message-edit-cut', args: JSON.stringify(cutPayload), source: { kind: 'user' } } })
  events.push({ type: 'user/message', seq: 2, time: 3,
    data: { id: 'cut-node', role: 'user', source: { kind: 'message-edit-cut', targetSeq: 0, endSeq: 0 }, content: [{ type: 'text', text: '' }] },
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] })
  events.push({ type: 'command/done', seq: 3, time: 4,
    data: { commandId: 'cut-1', kind: 'success', text: 'dsh-message-edit-cut/v3:' + JSON.stringify({ ...cutPayload, shadowedNodeSeq: 2 }), sourceEventSeq: 0 } })
  const restored = readSession(serialize(events))
  assert.equal(restored.events.length, events.length)
})
