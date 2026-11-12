import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandEditProjection, commitEdit, collectEdits, revisionOf,
  replaceText, EditError } from './journal.mjs'

// The original extracted desktop runtime is the implementation under test.
// Resolve its missing peer dependencies from the build toolchain only;
// do not substitute the modified source Session implementation.
const peerResolvers = [createRequire(import.meta.url)]
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error
    for (const resolvePeer of peerResolvers) {
      try { return nextResolve(pathToFileURL(resolvePeer.resolve(specifier)).href, context) }
      catch (peerError) { if (peerError.code !== 'MODULE_NOT_FOUND') throw peerError }
    }
    throw error
  }
} })
const runtime = await import('@deepseek-ai/dsh-session')
hooks.deregister()
const { Session, SessionId } = runtime
const message = (id, role, text) => ({ id, role, content: [{ type: 'text', text }],
  source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'test', model: 'test', replayState: { signature: 'original' } } })
function fixture() {
  const session = Session.create(SessionId('plugin-edit-test'), [], undefined, undefined, [commandEditProjection])
  const user = session.append('user/message', message('user-1', 'user', 'Original question'), { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', { turn: 1, step: 1,
    message: message('assistant-1', 'assistant', 'Original answer'),
    stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['Original answer'] }],
    usage: { inputTokens: 1, outputTokens: 1 } }, { surfaceOp: 'append' })
  return { session, user, assistant }
}
const request = (event, text, revision = event.seq) => ({ version: 3, targetSeq: event.seq,
  messageId: event.type === 'user/message' ? event.data.id : event.data.message.id,
  role: event.type === 'user/message' ? 'user' : 'assistant', revision, text })

test('tests the original runtime rather than the modified core', async () => {
  const { Context } = await import(pathToFileURL(peerResolvers[0].resolve('@deepseek-ai/cordis')).href)
  const ctx = new Context()
  try {
    await ctx.plugin(runtime.default)
    assert.equal(ctx.sessions.messageProjections.some(item => item.type === 'message/edited'), false)
  } finally { await ctx.fiber.dispose() }
})
test('edits both actual message texts without rewriting original records or streams', () => {
  const { session, user, assistant } = fixture()
  const originalUser = structuredClone(user)
  const originalAssistant = structuredClone(assistant)
  commitEdit(session, request(user, 'Edited question'), 'edit-user')
  commitEdit(session, request(assistant, 'Edited answer'), 'edit-assistant')
  assert.equal(session.deriveMessages()[0].content[0].text, 'Edited question')
  assert.equal(session.deriveMessages()[1].content[0].text, 'Edited answer')
  assert.deepEqual(user, originalUser)
  assert.deepEqual(assistant, originalAssistant)
  assert.equal(session.deriveMessages()[1].source.replayState, undefined)
  assert.deepEqual(session.surface.nodes, [user.seq, assistant.seq])
  assert.equal(Object.keys(collectEdits(session.snapshotEvents())).length, 2)
})
test('repeat edits compare revisions and preserve exact whitespace', () => {
  const { session, assistant } = fixture()
  const first = commitEdit(session, request(assistant, 'First'), 'edit-1')
  const before = session.seq
  assert.throws(() => commitEdit(session, request(assistant, 'Stale'), 'edit-stale'),
    error => error instanceof EditError && error.code === 'conflict')
  assert.equal(session.seq, before)
  const second = commitEdit(session, request(assistant, '  Second\nline  \n', first.revision), 'edit-2')
  assert.equal(session.deriveMessages()[1].content[0].text, '  Second\nline  \n')
  assert.equal(revisionOf(session.snapshotEvents(), assistant.seq), second.revision)
})
test('restart-like replay retains edits; missing plugin degrades to originals', () => {
  const { session, assistant } = fixture()
  commitEdit(session, request(assistant, 'Edited on disk'), 'edit')
  const events = session.snapshotEvents()
  const replayed = Session.create(SessionId('reopened'), events, undefined, undefined, [commandEditProjection])
  assert.equal(replayed.deriveMessages()[1].content[0].text, 'Edited on disk')
  const withoutPlugin = Session.create(SessionId('without-plugin'), events)
  assert.equal(withoutPlugin.deriveMessages()[1].content[0].text, 'Original answer')
  assert.deepEqual(withoutPlugin.snapshotEvents().slice(0, events.length), events)
})
test('ordinary successful and failed commands cannot become edits', () => {
  const { session } = fixture()
  session.append('command/run', { commandId: 'ordinary', name: 'ordinary', source: { kind: 'user' } })
  session.append('command/done', { commandId: 'ordinary', kind: 'success', text: 'ordinary result' })
  session.append('command/run', { commandId: 'failure', name: 'message-edit-commit', source: { kind: 'user' } })
  session.append('command/done', { commandId: 'failure', kind: 'error', text: 'failed' })
  assert.equal(session.deriveMessages()[1].content[0].text, 'Original answer')
  assert.deepEqual(Object.keys(collectEdits(session.snapshotEvents())), [])
})
test('invalid targets, compacted targets, and empty text reject before journaling', () => {
  const { session, user } = fixture()
  for (const invalid of [{ ...request(user, 'x'), messageId: 'wrong' },
    { ...request(user, 'x'), text: '' }, { ...request(user, 'x'), targetSeq: 999 }]) {
    const before = session.seq
    assert.throws(() => commitEdit(session, invalid, 'invalid'), EditError)
    assert.equal(session.seq, before)
  }
  session.append('user/message', message('summary', 'user', 'Compacted'), {
    surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq }, sourceEventSeqs: [user.seq] })
  assert.throws(() => commitEdit(session, request(user, 'x'), 'compacted'),
    error => error.code === 'compacted')
})
test('text edits preserve images, files, reasoning, and tool calls in order', () => {
  const original = message('mixed', 'assistant', 'before')
  const blocks = [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'before' },
    { type: 'image', attachment: { attachmentId: 'test-image' } },
    { type: 'file', attachment: { attachmentId: 'test-file' } },
    { type: 'tool-call', id: 'tool-1', name: 'read', arguments: '{}' }, { type: 'text', text: 'after' }]
  original.content = blocks
  const result = replaceText(original, 'new')
  assert.deepEqual(result.content, [blocks[0], { type: 'text', text: 'new' }, ...blocks.slice(2, 5)])
  assert.deepEqual(original.content, blocks)
})
