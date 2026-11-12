import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replaceUserHistory } from './history-cut.mjs'
import { assertEditableText, replaceText } from './journal.mjs'

function setup(action = 'save') {
  const original = { id: 'original', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }] }
  const makeAgent = id => {
    const events = []
    const session = { id, header: {}, surface: { nodes: [0] }, eventAt: () => ({ type: 'user/message', data: original }),
      snapshotEvents: () => events, append: (type, data) => { const event = { type, data, seq: events.length + 1 }; events.push(event); return event } }
    const inbox = { nextTurn: [{ id: 'pending', content: [{ type: 'file', attachment: { attachmentId: 'x' } }] }],
      nextStep: [{ id: 'step' }], clear() { this.nextTurn.splice(0); this.nextStep.splice(0) } }
    return { id, session, inbox, model: { value: { provider: 'old', model: 'old' }, current() { return this.value }, select(v) { this.value = v } },
      followups: [], followup(message) { this.followups.push(message) } }
  }
  const source = makeAgent('source'), child = makeAgent('child')
  const ctx = { agents: { turnBoundaryOf: () => ({ openTurnStartSeq: null }) },
    llm: { listProviders: () => [{ id: 'new' }], listModels: async () => [{ id: 'new' }] },
    sessionController: { create: async () => ({ sessionId: child.id }), resolveAgent: async () => ({ agent: child }) } }
  const request = { action, targetSeq: 0, messageId: 'original', text: 'new text', modelSelection: { provider: 'new', model: 'new' } }
  const progress = {}, controller = new AbortController()
  const run = flush => replaceUserHistory(ctx, source, request, progress, async (agent, fn) => fn(new AbortController().signal), flush, controller.signal)
  return { source, child, progress, controller, run }
}

for (const action of ['save', 'fork']) {
  test(`${action} first flush failure retains inbox and model`, async () => {
    const t = setup(action), target = action === 'save' ? t.source : t.child
    const before = structuredClone(target.inbox.nextTurn)
    await assert.rejects(t.run(async () => { throw new Error('disk') }))
    assert.deepEqual(target.inbox.nextTurn, before)
    assert.equal(target.inbox.nextStep.length, 1)
    assert.deepEqual(target.model.value, { provider: 'old', model: 'old' })
    assert.equal(target.followups.length, 0)
    assert.equal(t.progress.durability, 'unconfirmed')
  })
  test(`${action} cancellation after checkpoint retains inbox and model`, async () => {
    const t = setup(action), target = action === 'save' ? t.source : t.child
    await assert.rejects(t.run(async () => { t.controller.abort() }), error => error.code === 'cancelled')
    assert.equal(target.inbox.nextTurn.length, 1)
    assert.equal(target.inbox.nextStep.length, 1)
    assert.deepEqual(target.model.value, { provider: 'old', model: 'old' })
    assert.equal(target.followups.length, 0)
    assert.equal(t.progress.checkpointDurability, 'confirmed')
  })
  test(`${action} second flush failure reports accepted followup and confirmed checkpoint`, async () => {
    const t = setup(action), target = action === 'save' ? t.source : t.child
    let flushes = 0
    await assert.rejects(t.run(async () => { if (++flushes === 2) throw new Error('disk') }))
    assert.equal(target.inbox.nextTurn.length, 0)
    assert.deepEqual(target.model.value, { provider: 'new', model: 'new' })
    assert.equal(target.followups.length, 1)
    assert.equal(t.progress.followupAccepted, true)
    assert.equal(t.progress.checkpointDurability, 'confirmed')
    assert.equal(t.progress.durability, 'unconfirmed')
  })
}

test('append failure leaves pending input and model untouched', async () => {
  const t = setup()
  t.source.session.append = () => { throw new Error('append') }
  await assert.rejects(t.run(async () => {}), /append/)
  assert.equal(t.source.inbox.nextTurn.length, 1)
  assert.equal(t.source.inbox.nextStep.length, 1)
  assert.deepEqual(t.source.model.value, { provider: 'old', model: 'old' })
  assert.equal(t.source.followups.length, 0)
})

test('failure after surface replacement reports partial in-memory cut without durable commit', async () => {
  const t = setup(), append = t.source.session.append; let n = 0
  t.source.session.append = (...args) => { if (++n === 3) throw new Error('append'); return append(...args) }
  await assert.rejects(t.run(async () => {}), /append/)
  assert.equal(t.progress.journalAppended, true)
  assert.equal(t.progress.surfaceCutApplied, true)
  assert.equal(t.progress.committed, false)
  assert.equal(t.progress.durability, 'unconfirmed')
  assert.equal(t.source.inbox.nextTurn.length, 1)
  assert.equal(t.source.inbox.nextStep.length, 1)
  assert.deepEqual(t.source.model.value, { provider: 'old', model: 'old' })
  assert.equal(t.source.followups.length, 0)
})

for (const action of ['save', 'fork']) test(`${action} selection append failure preserves checkpoint and reports cleared inbox`, async () => {
  const t = setup(action), target = action === 'save' ? t.source : t.child
  target.model.select = () => { throw new Error('select append') }
  await assert.rejects(t.run(async () => {}), /select append/)
  assert.equal(t.progress.checkpointDurability, 'confirmed')
  assert.equal(t.progress.durability, 'unconfirmed')
  assert.equal(t.progress.inboxCleared, true)
  assert.equal(t.progress.modelSelectionStarted, true)
  assert.equal(t.progress.followupAccepted, false)
  assert.equal(target.inbox.nextTurn.length, 0)
  assert.equal(target.followups.length, 0)
})

test('an enqueue that throws after appending is still reported as accepted', async () => {
  const t = setup()
  t.source.followup = message => { t.source.inbox.nextTurn.push(message); throw new Error('wake') }
  await assert.rejects(t.run(async () => {}), /wake/)
  assert.equal(t.progress.checkpointDurability, 'confirmed')
  assert.equal(t.progress.followupAccepted, true)
  assert.equal(t.progress.durability, 'unconfirmed')
})

for (const action of ['save', 'fork']) test(`${action} enqueue outcome is unknown when followup throws without visible message`, async () => {
  const t = setup(action), target = action === 'save' ? t.source : t.child
  target.followup = () => { throw new Error('uncertain enqueue') }
  await assert.rejects(t.run(async () => {}), /uncertain enqueue/)
  assert.equal(t.progress.checkpointDurability, 'confirmed')
  assert.equal(t.progress.durability, 'unconfirmed')
  assert.equal(t.progress.followupAccepted, 'unknown')
  assert.equal(t.progress.committed, action === 'fork' ? 'unknown' : true)
})

test('fork reports a visible enqueue as committed when followup throws', async () => {
  const t = setup('fork')
  t.child.followup = message => { t.child.inbox.nextTurn.push(message); throw new Error('wake') }
  await assert.rejects(t.run(async () => {}), /wake/)
  assert.equal(t.progress.followupAccepted, true)
  assert.equal(t.progress.committed, true)
  assert.equal(t.progress.durability, 'unconfirmed')
})

test('new writes reject interleaved text but legacy replacement remains available', () => {
  const image = { type: 'image', attachment: { attachmentId: 'x' } }
  const adjacent = { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, image] }
  const interleaved = { role: 'user', content: [adjacent.content[0], image, adjacent.content[1]] }
  assert.doesNotThrow(() => assertEditableText(adjacent))
  assert.deepEqual(replaceText(adjacent, 'new').content, [{ type: 'text', text: 'new' }, image])
  assert.throws(() => assertEditableText(interleaved), error => error.code === 'ambiguous-text')
  assert.deepEqual(replaceText(interleaved, 'legacy').content, [{ type: 'text', text: 'legacy' }, image])
})
