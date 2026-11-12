/** Recoverable queued-message reservations carried by existing command/splice records. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EditError, replaceText, assertEditableText } from './journal.mjs'

const INTERNAL = 'message-queue-edit-commit'
const PREFIX = 'dsh-message-queue/v1:'
const messageSchema = z.object({ id: z.string(), role: z.literal('user'),
  content: z.array(z.unknown()), source: z.unknown() }).passthrough()
const heldSchema = z.object({ token: z.string(), id: z.string(), message: messageSchema,
  target: z.literal('next-turn'), index: z.number().int().nonnegative(), heldSeq: z.number().int().nonnegative() })
const empty = () => ({ held: {}, intents: {}, released: {} })

function parseIntent(raw) {
  let value
  try { value = JSON.parse(raw) } catch { throw new EditError('invalid-record', 'The queued edit record is malformed.') }
  if (value.version !== 1 || !['hold', 'requeue', 'restore'].includes(value.action)
    || typeof value.token !== 'string' || !value.token || typeof value.id !== 'string'
    || value.message?.id !== value.id || value.message?.role !== 'user'
    || !Array.isArray(value.message.content) || value.target !== 'next-turn'
    || !Number.isSafeInteger(value.index) || value.index < 0) {
    throw new EditError('invalid-record', 'The queued edit record is invalid.')
  }
  return value
}

/** The mutation immediately following an intent proves whether the reservation took effect. */
export function applyQueueRecord(state, event) {
  if (event.type === 'command/run' && event.data.name === INTERNAL) {
    const intent = parseIntent(event.data.args)
    return { ...state, intents: { ...state.intents,
      [event.data.commandId]: { ...intent, mutationSeq: event.seq + 1 } } }
  }
  if (event.type === 'agent/inbox/spliced') {
    let next = state
    for (const intent of Object.values(state.intents)) {
      if (intent.mutationSeq !== event.seq || event.data.target !== intent.target) continue
      if (intent.action === 'hold') {
        if (event.data.start !== intent.index || event.data.removedCount !== 1
          || event.data.inserted.length !== 0 || event.data.outcome !== 'canceled') continue
        next = { ...next, held: { ...next.held, [intent.token]: {
          token: intent.token, id: intent.id, message: intent.message, target: intent.target,
          index: intent.index, heldSeq: event.seq,
        } } }
      } else if (event.data.inserted.some(message => message.id === intent.id)) {
        const held = { ...next.held }
        delete held[intent.token]
        next = { ...next, held, released: { ...next.released,
          [intent.token]: { id: intent.id, action: intent.action, seq: event.seq } } }
      }
    }
    return next
  }
  if (event.type === 'command/done' && Object.hasOwn(state.intents, event.data.commandId)) {
    const intents = { ...state.intents }
    delete intents[event.data.commandId]
    return { ...state, intents }
  }
  return state
}
export const queueEditProjection = {
  key: 'messageQueueEdits', stateVersion: 1,
  stateSchema: z.object({ held: z.record(z.string(), heldSchema), intents: z.record(z.string(), z.unknown()),
    released: z.record(z.string(), z.unknown()) }),
  init: empty, apply: applyQueueRecord,
  wire: { summary: false, viewSchema: z.object({ held: z.record(z.string(), heldSchema) }),
    view: (() => { const cache = new WeakMap(); return state => {
      let result = cache.get(state.held)
      if (!result) { result = { held: state.held }; cache.set(state.held, result) }
      return result
    } })() },
}
function stateOf(session) {
  return session.snapshotEvents().reduce(applyQueueRecord, empty())
}
function textOf(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}
function appendIntent(session, decision) {
  const commandId = randomUUID()
  session.append('command/run', { commandId, name: INTERNAL,
    args: JSON.stringify({ version: 1, ...decision }), source: { kind: 'user' } })
  return commandId
}
function finish(session, commandId, result) {
  session.append('command/done', { commandId, kind: 'success', text: PREFIX + JSON.stringify(result) })
}
async function flush(ctx, session) {
  if (!await ctx.sessions.flush(session)) throw new Error('Durability checkpoint unavailable')
}

/** Reserve pending input synchronously; no maintenance lock prevents editing during generation. */
export async function holdQueued(ctx, agent, itemId) {
  const existing = Object.values(stateOf(agent.session).held).find(item => item.id === itemId)
  if (existing) return existing
  const index = agent.inbox.nextTurn.findIndex(message => message.id === itemId)
  if (index < 0) throw new EditError('already-claimed', 'This message is no longer queued; it may already have been sent.')
  const message = agent.inbox.nextTurn[index]
  if (!textOf(message.content).trim()) throw new EditError('no-text', 'This queued message has no editable text.')
  const token = randomUUID()
  const commandId = appendIntent(agent.session, { action: 'hold', token, id: message.id, message,
    target: 'next-turn', index })
  // No await between durable intent and splice. The driver cannot claim it in between.
  if (!agent.inbox.remove(itemId)) throw new EditError('already-claimed', 'The message was claimed before it could be reserved.')
  const held = stateOf(agent.session).held[token]
  if (!held) throw new EditError('unconfirmed', 'The queue reservation could not be confirmed.')
  finish(agent.session, commandId, { token, id: itemId, held: true })
  try { await flush(ctx, agent.session) }
  catch { throw new EditError('unconfirmed', 'The message is held aside, but storage could not be confirmed.', { token, held: true }) }
  return held
}

/** Enter queues the revised text; Cancel queues the original. Repeated receipts never duplicate input. */
export async function releaseQueued(ctx, agent, token, action, text) {
  const state = stateOf(agent.session)
  const held = state.held[token]
  if (!held) {
    const released = state.released[token]
    if (released) return { id: released.id, queued: true, alreadyReleased: true }
    throw new EditError('not-held', 'This message is no longer held for editing.')
  }
  const message = action === 'restore' ? held.message : (() => {
    if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 1048576) {
      throw new EditError('invalid', 'Enter nonempty text under 1 MiB to re-queue this message.')
    }
    assertEditableText(held.message)
    return replaceText(held.message, text)
  })()
  if (agent.inbox.nextTurn.some(item => item.id === held.id) || agent.inbox.nextStep.some(item => item.id === held.id)) {
    throw new EditError('already-queued', 'This message is already pending. Do not queue a duplicate.')
  }
  const commandId = appendIntent(agent.session, { action, token, id: held.id, message,
    target: 'next-turn', index: agent.inbox.nextTurn.length })
  // followup inserts at the queue tail and wakes an idle driver, exactly as normal queued input.
  agent.followup(message)
  finish(agent.session, commandId, { token, id: held.id, queued: true, restored: action === 'restore' })
  try { await flush(ctx, agent.session) }
  catch { throw new EditError('unconfirmed', 'The message was re-queued, but storage could not be confirmed.', { token, queued: true }) }
  return { id: held.id, queued: true }
}

export async function executeQueueEdit(ctx, invocation) {
  try {
    const request = JSON.parse(invocation.rawInput)
    if (invocation.signal?.aborted) throw new EditError('cancelled', 'Queue editing was cancelled.')
    const agent = ctx.agents.get(invocation.agent.id)
    if (!agent) throw new EditError('not-found', 'This session is not active.')
    let value
    if (request.action === 'hold' && typeof request.itemId === 'string') {
      value = await holdQueued(ctx, agent, request.itemId)
    } else if (['requeue', 'restore'].includes(request.action) && typeof request.token === 'string') {
      value = await releaseQueued(ctx, agent, request.token, request.action, request.text)
    } else throw new EditError('invalid', 'Choose a queued message or a held draft.')
    return { kind: 'success', text: JSON.stringify({ ok: true, value }) }
  } catch (error) {
    return { kind: 'error', text: JSON.stringify({ ok: false, error: {
      code: error instanceof EditError ? error.code : 'internal',
      message: error instanceof EditError ? error.message : 'The queue operation could not finish.',
      details: error instanceof EditError ? error.details : {},
    } }) }
  }
}

export async function registerQueueEditing(ctx) {
  const projection = await ctx.sessionProjections.register(queueEditProjection)
  ctx.effect(() => () => projection.dispose())
  ctx.effect(() => ctx.commands.register({ name: 'message-queue',
    description: 'Hold queued input aside while editing, then re-queue or restore it.', recordInput: false,
    handler: invocation => executeQueueEdit(ctx, invocation) }))
}
