import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { holdQueued, releaseQueued, applyQueueRecord } from '@dsh-workbench/dsh-message-edit'
const peers = [createRequire(import.meta.url)]
const hook = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error
    for (const peer of peers) {
      try { return next(pathToFileURL(peer.resolve(specifier)).href, context) }
      catch (missing) { if (missing.code !== 'MODULE_NOT_FOUND') throw missing }
    }
    throw error
  }
} })
const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
hook.deregister()
const inboxSource = await readFile(peers[0].resolve('@deepseek-ai/dsh-agent-loop'), 'utf8')
const code = inboxSource.slice(inboxSource.indexOf('const inboxProjectionSchema ='), inboxSource.indexOf('//#endregion'))
const { z } = await import('zod')
const { ReactLoopInbox, inboxProjectionDefinition } = new Function('z$1', code + '\nreturn { ReactLoopInbox, inboxProjectionDefinition }')(z)
const message = (id, text) => ({ id, role: 'user', source: { kind: 'user', rpcId: 'rpc-' + id },
  content: [{ type: 'text', text }] })
const projection = session => session.snapshotEvents().reduce(applyQueueRecord, { held: {}, intents: {}, released: {} })
function setup() {
  const session = Session.create(SessionId('queue-tests'))
  const inbox = new ReactLoopInbox(() => session.snapshotEvents().reduce(inboxProjectionDefinition.apply, inboxProjectionDefinition.init()), session, { emit() {} })
  const agent = { id: session.id, session, inbox, status: 'running', followup: input => inbox.append('next-turn', input),
    runMaintenance: () => { throw new Error('Must not reserve maintenance while generation runs') } }
  const ctx = { sessions: { flush: async () => true } }
  return { session, inbox, agent, ctx }
}

test('holding queued input prevents the driver from claiming it while editing', async () => {
  const t = setup()
  t.inbox.append('next-turn', message('a', 'Original A'))
  t.inbox.append('next-turn', message('b', 'Original B'))
  const held = await holdQueued(t.ctx, t.agent, 'a')
  assert.deepEqual(t.inbox.nextTurn.map(item => item.id), ['b'])
  assert.deepEqual(t.inbox.claim('next-turn', 1).map(item => item.id), ['b'])
  assert.equal(t.inbox.nextTurn.length, 0)
  assert.equal(projection(t.session).held[held.token].message.content[0].text, 'Original A')
  await releaseQueued(t.ctx, t.agent, held.token, 'requeue', 'Edited A')
  assert.deepEqual(t.inbox.nextTurn.map(item => [item.id, item.content[0].text]), [['a', 'Edited A']])
  assert.deepEqual(Object.keys(projection(t.session).held), [])
})
test('claimed messages cannot be reserved or resurrected by a late edit click', async () => {
  const t = setup()
  t.inbox.append('next-turn', message('a', 'Original'))
  t.inbox.claim('next-turn', 1)
  const before = t.session.seq
  await assert.rejects(holdQueued(t.ctx, t.agent, 'a'), error => error.code === 'already-claimed')
  assert.equal(t.session.seq, before)
  assert.deepEqual(Object.keys(projection(t.session).held), [])
})
test('cancellation restores exact original content and attachments, not the local draft', async () => {
  const t = setup()
  const input = message('a', '  Original\ntext  ')
  input.content.push({ type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } })
  input.content.push({ type: 'file', attachment: { attachmentId: 'file', name: 'notes.txt', bytes: 4 } })
  t.inbox.append('next-turn', input)
  const held = await holdQueued(t.ctx, t.agent, 'a')
  await releaseQueued(t.ctx, t.agent, held.token, 'restore', 'Must not be used')
  assert.deepEqual(t.inbox.nextTurn[0], input)
})
test('Enter edits text only and repeated release cannot duplicate an already sent message', async () => {
  const t = setup()
  const input = message('a', 'Old')
  input.content.push({ type: 'file', attachment: { attachmentId: 'file', name: 'data.csv', bytes: 12 } })
  t.inbox.append('next-turn', input)
  const held = await holdQueued(t.ctx, t.agent, 'a')
  await releaseQueued(t.ctx, t.agent, held.token, 'requeue', '  New\ntext  ')
  assert.deepEqual(t.inbox.nextTurn[0].content, [{ type: 'text', text: '  New\ntext  ' }, input.content[1]])
  t.inbox.claim('next-turn', 2)
  const result = await releaseQueued(t.ctx, t.agent, held.token, 'requeue', 'Duplicate')
  assert.equal(result.alreadyReleased, true)
  assert.equal(t.inbox.nextTurn.length, 0)
})
test('empty save leaves the message held, and a duplicate hold reuses its reservation', async () => {
  const t = setup()
  t.inbox.append('next-turn', message('a', 'Old'))
  const held = await holdQueued(t.ctx, t.agent, 'a')
  assert.equal((await holdQueued(t.ctx, t.agent, 'a')).token, held.token)
  await assert.rejects(releaseQueued(t.ctx, t.agent, held.token, 'requeue', ' '), error => error.code === 'invalid')
  assert.ok(projection(t.session).held[held.token])
})
test('a storage failure retains the held original and permits recovery after replay', async () => {
  const t = setup()
  t.inbox.append('next-turn', message('a', 'Original'))
  t.ctx.sessions.flush = async () => { throw new Error('storage') }
  await assert.rejects(holdQueued(t.ctx, t.agent, 'a'), error => error.details.held === true)
  assert.equal(t.inbox.nextTurn.length, 0)
  const replay = Session.create(SessionId('replay'), t.session.snapshotEvents())
  const holds = Object.values(projection(replay).held)
  assert.equal(holds.length, 1)
  assert.equal(holds[0].message.content[0].text, 'Original')
})
test('an interrupted hold is recoverable from its intent plus canceled splice', () => {
  const t = setup()
  const input = message('a', 'Original')
  t.inbox.append('next-turn', input)
  t.session.append('command/run', { commandId: 'interrupted', name: 'message-queue-edit-commit', source: { kind: 'user' },
    args: JSON.stringify({ version: 1, action: 'hold', token: 'held-token', id: input.id, message: input, target: 'next-turn', index: 0 }) })
  t.inbox.remove('a')
  assert.equal(projection(t.session).held['held-token'].message.id, 'a')
})

test('interleaved queued text cannot be requeued as an edit but can be restored', async () => {
  const t = setup(), input = message('a', 'first')
  input.content.push({ type: 'file', attachment: { attachmentId: 'f' } }, { type: 'text', text: 'last' })
  t.inbox.append('next-turn', input)
  const held = await holdQueued(t.ctx, t.agent, input.id)
  await assert.rejects(releaseQueued(t.ctx, t.agent, held.token, 'requeue', 'new'), error => error.code === 'ambiguous-text')
  assert.equal(t.inbox.nextTurn.length, 0)
  await releaseQueued(t.ctx, t.agent, held.token, 'restore')
  assert.deepEqual(t.inbox.nextTurn[0], input)
})
