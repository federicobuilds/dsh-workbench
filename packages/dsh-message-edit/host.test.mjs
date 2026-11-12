import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandEditProjection, commitEdit } from './journal.mjs'
import { apply, executeEdit, messageEditJournal } from '@dsh-workbench/dsh-message-edit'
import { commandEdit } from './bridge.mjs'
const resolvers = [createRequire(import.meta.url)]
const hook = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error
    for (const resolver of resolvers) {
      try { return next(pathToFileURL(resolver.resolve(specifier)).href, context) }
      catch (peer) { if (peer.code !== 'MODULE_NOT_FOUND') throw peer }
    }
    throw error
  }
} })
const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
hook.deregister()
function setup(userContent = [{ type: 'text', text: 'Original question' }]) {
  const source = Session.create(SessionId('source'), undefined, undefined, undefined, [commandEditProjection])
  source.append('user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: userContent }, { surfaceOp: 'append' })
  source.append('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Original answer' }] }, stream: [] }, { surfaceOp: 'append' })
  const agents = new Map()
  const followups = []
  const forks = []
  const archived = []
  const titles = new Map([['source', 'Original chat']])
  const selectedModels = new Map()
  let flushes = 0
  const makeAgent = session => ({ id: session.id, session, inbox: { nextTurn: [], nextStep: [], clear() { this.nextTurn.splice(0); this.nextStep.splice(0) } },
    model: { current: () => selectedModels.get(session.id) ?? { provider: 'test', model: 'test' },
      select: sel => { selectedModels.set(session.id, sel); session.append('model/selection', sel) } },
    runMaintenance: async operation => operation(new AbortController().signal),
    followup: input => { followups.push(input); session.append('user/message', input, { surfaceOp: 'append' }) },
  })
  const agent = makeAgent(source)
  agents.set(source.id, agent)
  const ctx = { agents: { get: id => agents.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: null }) },
    sessions: { get: id => agents.get(id)?.session, flush: async () => { flushes++; return true } },
    llm: { listProviders: () => [{ id: 'test', name: 'Test' }, { id: 'alt', name: 'Alt' }],
      listModels: async provider => [{ provider, id: 'test', name: 'Test' }, { provider, id: 'alt-model', name: 'Alt Model' }] },
    workspaceRegistry: { list: () => [], archiveSession: async id => { archived.push(id) } },
    sessionTitle: { get: session => titles.has(session.id) ? { title: titles.get(session.id) } : undefined,
      rename: (session, title) => { titles.set(session.id, title) } },
    sessionController: {
      create: async () => {
        const session = Session.create(SessionId('child-' + forks.length), undefined, undefined, undefined, [commandEditProjection])
        agents.set(session.id, makeAgent(session))
        forks.push(session)
        return { sessionId: session.id }
      },
      fork: async ({ sessionId, atSeq }) => {
        const parent = agents.get(sessionId).session
        const session = Session.create(SessionId('child-' + forks.length), parent.snapshotEvents().slice(0, atSeq + 1), undefined, undefined, [commandEditProjection])
        agents.set(session.id, makeAgent(session))
        forks.push(session)
        return { sessionId: session.id }
      },
      resolveAgent: async id => ({ agent: agents.get(id) }),
    } }
  const invoke = async data => {
    const result = await executeEdit(ctx, { agent: { id: source.id }, signal: new AbortController().signal,
      rawInput: JSON.stringify(data) })
    return { result, carried: JSON.parse(result.text) }
  }
  return { source, agent, ctx, invoke, agents, followups, forks, archived, titles, selectedModels, flushes: () => flushes }
}
const edit = (role, overrides = {}) => ({ version: 3, role, messageId: role === 'user' ? 'u' : 'a',
  targetSeq: role === 'user' ? 0 : 1, revision: role === 'user' ? 0 : 1, text: 'Edited text', action: 'save', ...overrides })
test('assistant save edits its own text, flushes, and does not regenerate or fork', async () => {
  const t = setup()
  const response = await t.invoke(edit('assistant'))
  assert.equal(response.carried.ok, true)
  assert.equal(t.source.deriveMessages()[1].content[0].text, 'Edited text')
  assert.equal(t.source.eventAt(1).data.message.content[0].text, 'Original answer')
  assert.equal(t.flushes(), 1)
  assert.equal(t.forks.length, 0)
  assert.equal(t.followups.length, 0)
})
test('user replacement cuts the old tail in the same session without forking or archiving, and submits only revised text', async () => {
  const t = setup()
  t.source.append('user/message', { id: 'later-user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Later user message to discard' }] }, { surfaceOp: 'append' })
  const response = await t.invoke(edit('user', { text: 'Same-chat corrected question', modelSelection: { provider: 'alt', model: 'alt-model' } }))
  assert.equal(response.carried.ok, true)
  assert.equal(t.forks.length, 0)
  assert.deepEqual(t.archived, [])
  assert.deepEqual(t.source.deriveMessages().map(message => message.content[0].text), ['Same-chat corrected question'])
  assert.equal(t.source.eventAt(0).data.content[0].text, 'Original question')
  assert.deepEqual(t.selectedModels.get('source'), { provider: 'alt', model: 'alt-model' })
  assert.equal(t.followups.length, 1)
  assert.equal(t.followups[0].content[0].text, 'Same-chat corrected question')
  assert.equal(response.carried.value.childSessionId, undefined)
  assert.equal(response.carried.value.replaced, true)
  assert.equal(response.carried.value.followupAccepted, true)
  assert.equal(t.flushes(), 2)
})
test('user edit commits exact text to a child and regenerates, leaving source untouched', async () => {
  const t = setup()
  const response = await t.invoke(edit('user', { action: 'fork', text: '  corrected\nquestion  ', modelSelection: { provider: 'alt', model: 'alt-model' } }))
  assert.equal(response.carried.ok, true)
  assert.equal(t.source.deriveMessages()[0].content[0].text, 'Original question')
  assert.equal(t.forks[0].deriveMessages()[0].content[0].text, '  corrected\nquestion  ')
  assert.deepEqual(t.selectedModels.get(t.forks[0].id), { provider: 'alt', model: 'alt-model' })
  assert.equal(response.carried.value.childSessionId, t.forks[0].id)
  assert.equal(t.followups.length, 1)
  assert.equal(t.flushes(), 2)
})
test('busy, conflicts, and bad targets are explicit, never successful no-ops', async () => {
  const t = setup()
  t.agent.runMaintenance = () => { throw new Error('busy') }
  assert.equal((await t.invoke(edit('assistant'))).carried.error.code, 'busy')
  t.agent.runMaintenance = async operation => operation(new AbortController().signal)
  commitEdit(t.source, edit('assistant'), 'other-editor')
  assert.equal((await t.invoke(edit('assistant'))).carried.error.code, 'conflict')
  assert.equal((await t.invoke(edit('assistant', { messageId: 'wrong' }))).carried.error.code, 'invalid-target')
})
test('flush failure reports already committed edits and does not claim durability', async () => {
  const t = setup()
  t.ctx.sessions.flush = async () => { throw new Error('disk') }
  const response = await t.invoke(edit('assistant'))
  assert.equal(response.carried.ok, false)
  assert.equal(response.carried.error.code, 'flush-failed')
  assert.equal(response.carried.error.details.committed, true)
  assert.equal(response.carried.error.details.durability, 'unconfirmed')
  assert.equal(t.source.deriveMessages()[1].content[0].text, 'Edited text')
})

test('normal apply registers settings without touching registry or cache', async () => {
  const calls = [], fiber = {}
  const ctx = { fiber, inject: (_names, fn) => fn(ctx), effect: fn => fn(),
    settings: { configure: (options, owner) => { calls.push(['settings', options, owner]); return () => {} } },
    sessions: { registerMessageProjection: () => () => {} },
    sessionProjections: { register: async () => ({ dispose() {} }) },
    commands: { register: () => () => {} },
    workspaceRegistry: new Proxy({}, { get() { calls.push(['registry']); return () => { calls.push(['destructive']) } } }),
    get: () => { calls.push(['cache']) } }
  await apply(ctx)
  assert.deepEqual(calls, [['settings', { auto: false }, fiber]])
})

test('user first flush failure leaves pending attachments and model untouched', async () => {
  const t = setup()
  const pending = { id: 'pending', content: [{ type: 'file', attachment: { attachmentId: 'file' } }] }
  t.agent.inbox.nextTurn.push(pending)
  t.agent.inbox.nextStep.push({ id: 'steering' })
  t.ctx.sessions.flush = async () => { throw new Error('disk') }
  const response = await t.invoke(edit('user', { modelSelection: { provider: 'alt', model: 'alt-model' } }))
  assert.equal(response.carried.error.details.committed, true)
  assert.equal(response.carried.error.details.durability, 'unconfirmed')
  assert.equal(response.carried.error.details.followupAccepted, false)
  assert.deepEqual(t.agent.inbox.nextTurn, [pending])
  assert.equal(t.agent.inbox.nextStep.length, 1)
  assert.equal(t.selectedModels.size, 0)
  assert.equal(t.followups.length, 0)
})

test('user second flush failure reports the confirmed cut and accepted followup', async () => {
  const t = setup(); let n = 0
  t.agent.inbox.nextTurn.push({ id: 'pending' })
  t.ctx.sessions.flush = async () => { if (++n === 2) throw new Error('disk'); return true }
  const response = await t.invoke(edit('user', { modelSelection: { provider: 'alt', model: 'alt-model' } }))
  const d = response.carried.error.details
  assert.equal(d.checkpointDurability, 'confirmed')
  assert.equal(d.durability, 'unconfirmed')
  assert.equal(d.inboxCleared, true)
  assert.equal(d.modelSelected, true)
  assert.equal(d.followupAccepted, true)
  assert.equal(t.followups.length, 1)
})

test('fork checkpoint failure identifies child without accepting a followup', async () => {
  const t = setup()
  t.ctx.sessions.flush = async () => { throw new Error('disk') }
  const response = await t.invoke(edit('user', { action: 'fork', modelSelection: { provider: 'alt', model: 'alt-model' } }))
  const d = response.carried.error.details
  assert.equal(response.carried.error.code, 'partial')
  assert.equal(d.childSessionId, t.forks[0].id)
  assert.equal(d.committed, false)
  assert.equal(d.durability, 'unconfirmed')
  assert.equal(d.followupAccepted, false)
  assert.equal(t.selectedModels.size, 0)
  assert.equal(t.followups.length, 0)
})

test('fork second checkpoint failure reports child and accepted followup', async () => {
  const t = setup(); let n = 0
  t.ctx.sessions.flush = async () => { if (++n === 2) throw new Error('disk'); return true }
  const response = await t.invoke(edit('user', { action: 'fork', modelSelection: { provider: 'alt', model: 'alt-model' } }))
  const d = response.carried.error.details
  assert.equal(d.childSessionId, t.forks[0].id)
  assert.equal(d.checkpointDurability, 'confirmed')
  assert.equal(d.durability, 'unconfirmed')
  assert.equal(d.followupAccepted, true)
  assert.equal(t.followups.length, 1)
})

test('interleaved new edits are rejected but prior interleaved edits replay and carry', async () => {
  const blocks = [{ type: 'text', text: 'before' }, { type: 'file', attachment: { attachmentId: 'file' } }, { type: 'text', text: 'after' }]
  const t = setup(blocks)
  assert.equal((await t.invoke(edit('user'))).carried.error.code, 'ambiguous-text')
  commitEdit(t.source, edit('user', { text: 'legacy' }), 'legacy')
  const replay = Session.create(SessionId('legacy-replay'), t.source.snapshotEvents(), undefined, undefined, [commandEditProjection])
  assert.equal(replay.deriveMessages()[0].content[0].text, 'legacy')
  const fork = await t.invoke(edit('assistant', { action: 'fork' }))
  assert.equal(fork.carried.ok, true)
  assert.equal(t.forks[0].deriveMessages()[0].content[0].text, 'legacy')
})

test('bridge reports unconfirmed child as an error, not a saved fork', async () => {
  const payload = { ok: false, error: { code: 'partial', message: 'unfinished', details: { childSessionId: 'child', durability: 'unconfirmed' } } }
  const ctx = { remote: { commands: { execute: async () => ({ ok: true, value: { result: { text: JSON.stringify(payload) } } }) } } }
  const result = await commandEdit(ctx, 's', 'user', 'u', 0, 'text', 0, 'fork')
  assert.equal(result.ok, false)
  assert.equal(result.error.details.childSessionId, 'child')
  assert.equal(result.error.details.durability, 'unconfirmed')
})
test('post-fork failure names the child and prevents false success', async () => {
  const t = setup()
  t.ctx.sessions.flush = async () => false
  const response = await t.invoke(edit('user', { action: 'fork' }))
  assert.equal(response.carried.ok, false)
  assert.equal(response.carried.error.code, 'partial')
  assert.equal(response.carried.error.details.childSessionId, t.forks[0].id)
  assert.equal(t.followups.length, 0)
})
test('forks explicitly carry current edits of earlier messages', async () => {
  const t = setup()
  commitEdit(t.source, edit('user', { text: 'Earlier corrected question' }), 'prior-edit')
  const response = await t.invoke(edit('assistant', { action: 'fork', text: 'Corrected answer' }))
  assert.equal(response.carried.ok, true)
  assert.equal(t.forks[0].deriveMessages()[0].content[0].text, 'Earlier corrected question')
  assert.equal(t.forks[0].deriveMessages()[1].content[0].text, 'Corrected answer')
  assert.equal(t.source.deriveMessages()[1].content[0].text, 'Original answer')
  assert.equal(t.followups.length, 0)
})
test('incremental wire projection and full replay agree', async () => {
  const t = setup()
  await t.invoke(edit('assistant'))
  let state = messageEditJournal.init()
  for (const event of t.source.snapshotEvents()) state = messageEditJournal.apply(state, event)
  const view = messageEditJournal.wire.view(state)
  assert.equal(view.edits.a.text, 'Edited text')
  assert.equal(view.journalCount, 1)
  const same = messageEditJournal.apply(state, { type: 'step/end', data: {} })
  assert.equal(same, state)
  assert.equal(messageEditJournal.wire.view(same), view)
})
