/**
 * Host-only, profile-level past-message text editing; no model-facing tool.
 * Mount ONCE per profile (not per Agent): command/done has one interpreter owner.
 * Durable decisions preserve original records and streams. Disabling/unloading
 * that interpreter invalidates Sessions which used it: further derivation is
 * refused until it is registered again. Readers without this plugin see the
 * original text. This is an interpreter dependency, not a log-format migration.
 * No monkeypatching, application rebuilds, profile writes, or installs occur here.
 */
import { randomUUID } from 'node:crypto'
import { apply as configureChatPreferences } from './native-chat/src/index.ts'
export { Config } from './native-chat/src/index.ts'
import { z } from 'zod'
import { registerQueueEditing } from './queue.mjs'
import { replaceUserHistory } from './history-cut.mjs'
export { holdQueued, releaseQueued, applyQueueRecord, executeQueueEdit } from './queue.mjs'
import { COMMIT_COMMAND, RECEIPT_PREFIX, EditError, validateEdit,
  commandEditProjection, commitEdit, revisionOf, replaceText, assertEditableText, collectEdits } from './journal.mjs'

export const name = 'message-edit'
export const inject = ['sessions', 'commands', 'sessionProjections', 'agents', 'sessionController', 'sessionTitle', 'llm']

const seqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const editSchema = z.object({ version: z.literal(3), targetSeq: seqSchema,
  messageId: z.string().min(1), role: z.enum(['user', 'assistant']), text: z.string(),
  revision: seqSchema })
const viewSchema = z.object({ edits: z.record(z.string(), editSchema), journalCount: seqSchema })

/** Pure incremental fold. Pending internal runs survive JSON checkpoints. */
export const messageEditJournal = Object.freeze({
  key: 'messageEditJournal', stateVersion: 3,
  stateSchema: z.object({ pending: z.record(z.string(), seqSchema),
    edits: z.record(z.string(), editSchema), journalCount: seqSchema }),
  init: () => ({ pending: {}, edits: {}, journalCount: 0 }),
  apply(state, event) {
    if (event.type === 'command/run' && event.data.name === COMMIT_COMMAND) {
      return { ...state, pending: { ...state.pending, [event.data.commandId]: event.seq } }
    }
    if (event.type !== 'command/done'
      || !Object.hasOwn(state.pending, event.data.commandId)) return state
    const runSeq = state.pending[event.data.commandId]
    const pending = { ...state.pending }
    delete pending[event.data.commandId]
    if (event.seq <= runSeq || event.data.kind !== 'success'
      || typeof event.data.text !== 'string' || !event.data.text.startsWith(RECEIPT_PREFIX)) {
      return { ...state, pending }
    }
    // Match journal.decisionOf's record validation; never interpret other output.
    let edit
    try { edit = validateEdit(JSON.parse(event.data.text.slice(RECEIPT_PREFIX.length))) }
    catch { throw new EditError('invalid-record', 'The saved edit record is malformed.') }
    return { pending, edits: { ...state.edits,
      [edit.messageId]: { ...edit, revision: event.seq } }, journalCount: state.journalCount + 1 }
  },
  wire: { viewSchema, summary: false,
    // Pending-only changes must not cause wire publication.
    view: (() => {
      const views = new WeakMap()
      return state => {
        let view = views.get(state.edits)
        if (!view) { view = { edits: state.edits, journalCount: state.journalCount }; views.set(state.edits, view) }
        return view
      }
    })() },
})

function parseRequest(rawInput) {
  let value
  try { value = JSON.parse(rawInput) }
  catch { throw new EditError('invalid', 'Expected the raw version 3 edit JSON.') }
  const edit = validateEdit(value)
  if (!['save', 'fork'].includes(value.action)) throw new EditError('invalid', 'Choose save or fork.')
  let modelSelection
  if (value.modelSelection !== undefined) {
    const model = z.object({ provider: z.string().min(1), model: z.string().min(1),
      reasoningEffort: z.string().min(1).optional() }).strict().safeParse(value.modelSelection)
    if (!model.success || edit.role !== 'user') throw new EditError('invalid', 'Choose a valid model for user regeneration.')
    modelSelection = model.data
  }
  return { ...edit, action: value.action, ...(modelSelection ? { modelSelection } : {}) }
}

function checkCancellation(...signals) {
  if (signals.some(signal => signal?.aborted)) throw new EditError('cancelled', 'The edit was cancelled.')
}

/** Source validation permits compacted targets: an exact earlier fork restores them. */
function validateSource(session, request) {
  const events = session.snapshotEvents()
  const original = events[request.targetSeq]
  const message = original?.type === 'user/message' ? original.data
    : original?.type === 'assistant/message' ? original.data.message : undefined
  if (!message || message.id !== request.messageId || message.role !== request.role) {
    throw new EditError('invalid-target', 'The message identity no longer matches the edit.')
  }
  const revision = revisionOf(events, request.targetSeq)
  if (request.revision !== revision) {
    throw new EditError('conflict', 'This message changed while you were editing.', { currentRevision: revision })
  }
  const current = session.deriveEventMessage(original)
  if (!current || current.id !== request.messageId || current.role !== request.role) {
    throw new EditError('invalid-target', 'The effective message identity no longer matches the edit.')
  }
  assertEditableText(current)
  replaceText(current, request.text)
}

async function maintenance(agent, operation) {
  let entered = false
  try {
    return await agent.runMaintenance(async signal => { entered = true; return operation(signal) })
  } catch (error) {
    if (!entered) throw new EditError('busy', 'The agent has active work. Wait for it to finish before editing.')
    throw error
  }
}

async function flush(ctx, session) {
  try {
    if (!await ctx.sessions.flush(session)) throw new Error('No durability listener')
  } catch {
    // Do not copy filesystem/transport errors or unrelated session data to the log.
    throw new EditError('flush-failed', 'The edit was committed in memory but durable storage could not be confirmed.')
  }
}

function commandError(error, progress) {
  const known = error instanceof EditError
  const details = { ...(known ? error.details : {}), ...progress }
  return { kind: 'error', text: JSON.stringify({ ok: false, error: {
    code: details.childSessionId ? 'partial' : known ? error.code : 'internal',
    message: details.childSessionId
      ? 'A child session already exists, but the operation did not finish. Do not automatically retry or create another fork.'
      : known ? error.message : 'The edit could not be completed.',
    details: { ...details, ...(details.childSessionId ? { causeCode: known ? error.code : 'internal' } : {}) },
  } }) }
}

/** Shared operation behind the UI command; no agent authority is implied here. */
export async function executeEdit(ctx, invocation) {
  const progress = {}
  try {
    const request = parseRequest(invocation.rawInput)
    checkCancellation(invocation.signal)
    const agent = ctx.agents.get(invocation.agent.id)
    if (!agent || ctx.sessions.get(agent.id) !== agent.session) {
      throw new EditError('not-found', 'The receiving agent is no longer live.')
    }
    const source = agent.session
    const value = await maintenance(agent, async signal => {
      checkCancellation(invocation.signal, signal)
      validateSource(source, request)
      if (request.role === 'user') {
        return replaceUserHistory(ctx, agent, request, progress, maintenance, flush, signal, invocation.signal)
      }
      if (request.action === 'save') {
        if (ctx.agents.turnBoundaryOf(source).openTurnStartSeq !== null) {
          throw new EditError('busy', 'This session has an open turn. Finish or cancel it before editing.')
        }
        const receipt = commitEdit(source, request, randomUUID())
        Object.assign(progress, { committed: true, revision: receipt.revision, durability: 'unconfirmed', followupAccepted: false })
        await flush(ctx, source)
        progress.durability = 'confirmed'
        return { ...receipt, followupAccepted: false }
      }
      // Fork only when explicitly selected. The boundary is inclusive; the
      // controller supplies synthetic closers and the source stays unchanged.
      const child = await ctx.sessionController.fork({ sessionId: source.id, atSeq: request.targetSeq })
      Object.assign(progress, { childSessionId: child.sessionId, committed: false })
      checkCancellation(invocation.signal, signal)
      const resolved = await ctx.sessionController.resolveAgent(child.sessionId)
      if ('error' in resolved) throw new EditError('child-unavailable', 'The child agent could not be resolved.')
      const childAgent = resolved.agent
      if (ctx.agents.get(child.sessionId) !== childAgent || ctx.sessions.get(child.sessionId) !== childAgent.session) {
        throw new EditError('child-unavailable', 'The child agent is no longer live.')
      }
      return maintenance(childAgent, async childSignal => {
        checkCancellation(invocation.signal, signal, childSignal)
        if (ctx.agents.turnBoundaryOf(childAgent.session).openTurnStartSeq !== null) {
          throw new EditError('busy', 'The child session still has an open turn.')
        }
        // A time-cut excludes later command receipts even when they edit earlier
        // messages. Carry the current earlier edits explicitly, without changing
        // the source or pretending they were part of the inherited prefix.
        const priorEdits = Object.values(collectEdits(source.snapshotEvents()))
          .filter(edit => edit.targetSeq < request.targetSeq)
          .sort((a, b) => a.targetSeq - b.targetSeq)
        for (const edit of priorEdits) {
          if (!childAgent.session.surface.nodes.includes(edit.targetSeq)) continue
          const revision = revisionOf(childAgent.session.snapshotEvents(), edit.targetSeq)
          const current = childAgent.session.deriveEventMessage(childAgent.session.eventAt(edit.targetSeq))
          if (current && current.content.filter(block => block.type === 'text').map(block => block.text).join('') !== edit.text) {
            commitEdit(childAgent.session, { ...edit, revision }, randomUUID())
          }
        }
        const receipt = commitEdit(childAgent.session, { ...request, revision: request.targetSeq }, randomUUID())
        Object.assign(progress, { committed: true, revision: receipt.revision, durability: 'unconfirmed', followupAccepted: false })
        await flush(ctx, childAgent.session)
        progress.durability = 'confirmed'
        checkCancellation(invocation.signal, signal, childSignal)
        return { ...receipt, childSessionId: child.sessionId, followupAccepted: false }
      })
    })
    return { kind: 'success', text: JSON.stringify({ ok: true, value }) }
  } catch (error) { return commandError(error, progress) }
}

export async function apply(ctx) {
  configureChatPreferences(ctx)
  // One global interpreter, owned by this profile plugin's fiber. Nested effects
  // retain the exact disposers so registration failures roll back on unload.
  ctx.effect(() => ctx.sessions.registerMessageProjection(commandEditProjection))
  const journal = await ctx.sessionProjections.register(messageEditJournal)
  ctx.effect(() => () => journal.dispose())
  await registerQueueEditing(ctx)
  ctx.effect(() => ctx.commands.register({ name: 'message-edit',
    description: 'Edit past message text; regenerate here or save in a fork.',
    input: { hint: 'Version 3 edit JSON with save or fork action' }, recordInput: false,
    handler: invocation => executeEdit(ctx, invocation) }))
}
