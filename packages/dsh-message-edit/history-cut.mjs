/** Replace user history in-place or in a fork at a user-message boundary. */
import { randomUUID } from 'node:crypto'
import { EditError, replaceText, assertEditableText, collectEdits, revisionOf, commitEdit } from './journal.mjs'

export async function replaceUserHistory(ctx, agent, request, progress, maintenance, flush, signal, invocationSignal) {
  const source = agent.session
  const original = source.eventAt(request.targetSeq)
  if (original?.type !== 'user/message') throw new EditError('invalid-target', 'Choose a user message to regenerate.')
  const modelSelection = request.modelSelection ?? agent.model.current()
  if (request.modelSelection) {
    let available
    try {
      available = ctx.llm.listProviders().some(provider => provider.id === modelSelection.provider)
        && (await ctx.llm.listModels(modelSelection.provider)).some(model => model.id === modelSelection.model)
    } catch { throw new EditError('model-unavailable', 'The selected model could not be loaded. Choose another model.') }
    if (!available) throw new EditError('model-unavailable', 'The selected model is no longer available. Choose another model.')
  }
  checkCancellation(signal, invocationSignal)
  assertEditableText(original.data)
  const { rpcId, ...sourceWithoutOldRequest } = original.data.source
  void rpcId
  const replacement = { ...original.data, id: randomUUID(),
    source: sourceWithoutOldRequest, content: replaceText(original.data, request.text).content }

  if (request.action === 'save') {
    if (ctx.agents.turnBoundaryOf(source).openTurnStartSeq !== null) {
      throw new EditError('busy', 'This session has an open turn. Finish or cancel it before editing.')
    }
    const nodes = source.surface.nodes
    if (!nodes.includes(request.targetSeq)) {
      throw new EditError('compacted', 'This message is already compacted. Edit it in a fork instead.')
    }
    const endSeq = nodes.at(-1)
    const shadowedSeqs = nodes.slice(nodes.indexOf(request.targetSeq))
    const cutCommandId = randomUUID()
    const cutPayload = { version: 3, kind: 'cut', targetSeq: request.targetSeq, endSeq,
      messageId: request.messageId, replacementMessageId: replacement.id, text: request.text }
    Object.assign(progress, { committed: false, followupAccepted: false })
    source.append('command/run', { commandId: cutCommandId, name: 'message-edit-cut',
      args: JSON.stringify(cutPayload), source: { kind: 'user' } })
    Object.assign(progress, { journalAppended: true, durability: 'unconfirmed', followupAccepted: false })
    const shadowedNode = source.append('user/message', { id: randomUUID(), role: 'user',
      source: { kind: 'message-edit-cut', targetSeq: request.targetSeq, endSeq },
      content: [{ type: 'text', text: '' }] },
      { surfaceOp: { op: 'replace', startSeq: request.targetSeq, endSeq }, sourceEventSeqs: shadowedSeqs })
    progress.surfaceCutApplied = true
    const cutDone = source.append('command/done', { commandId: cutCommandId, kind: 'success',
      text: 'dsh-message-edit-cut/v3:' + JSON.stringify({ ...cutPayload, shadowedNodeSeq: shadowedNode.seq }),
      sourceEventSeq: request.targetSeq })
    Object.assign(progress, { committed: true, revision: cutDone.seq })
    await flush(ctx, source)
    Object.assign(progress, { durability: 'confirmed', checkpointDurability: 'confirmed' })
    checkCancellation(signal, invocationSignal)
    progress.durability = 'unconfirmed'
    progress.inboxClearStarted = true
    agent.inbox.clear()
    progress.inboxCleared = true
    if (request.modelSelection) { progress.modelSelectionStarted = true; agent.model.select(request.modelSelection); progress.modelSelected = true }
    try { agent.followup(replacement) }
    catch (error) {
      progress.followupAccepted = 'unknown'
      try { if (agent.inbox.nextTurn.some(item => item.id === replacement.id)) progress.followupAccepted = true } catch {}
      throw error
    }
    progress.followupAccepted = true
    await flush(ctx, source)
    progress.durability = 'confirmed'
    return { messageId: replacement.id, targetSeq: request.targetSeq, revision: cutDone.seq,
      text: request.text, replaced: true, followupAccepted: true }
  }

  const activePrefix = source.surface.nodes.filter(seq => seq < request.targetSeq && source.deriveEventMessage(source.eventAt(seq)) !== null)
  const child = activePrefix.length > 0
    ? await ctx.sessionController.fork({ sessionId: source.id, atSeq: request.targetSeq - 1 })
    : await ctx.sessionController.create({ cwd: source.header.cwd, agentPreset: source.header.agentPreset })
  Object.assign(progress, { childSessionId: child.sessionId, committed: false, followupAccepted: false, durability: 'unconfirmed' })
  checkCancellation(signal, invocationSignal)
  const resolved = await ctx.sessionController.resolveAgent(child.sessionId)
  if ('error' in resolved) throw new EditError('child-unavailable', 'The replacement generation could not be opened.')
  const next = resolved.agent
  return maintenance(next, async childSignal => {
    checkCancellation(signal, childSignal, invocationSignal)
    const edits = Object.values(collectEdits(source.snapshotEvents())).filter(edit => edit.targetSeq < request.targetSeq)
    for (const edit of edits.sort((a, b) => a.targetSeq - b.targetSeq)) {
      if (!next.session.surface.nodes.includes(edit.targetSeq)) continue
      const current = next.session.deriveEventMessage(next.session.eventAt(edit.targetSeq))
      if (current && current.content.filter(block => block.type === 'text').map(block => block.text).join('') !== edit.text) {
        commitEdit(next.session, { ...edit, revision: revisionOf(next.session.snapshotEvents(), edit.targetSeq) }, randomUUID())
        progress.committed = true
      }
    }
    await flush(ctx, next.session)
    Object.assign(progress, { durability: 'confirmed', checkpointDurability: 'confirmed' })
    checkCancellation(signal, childSignal, invocationSignal)
    progress.durability = 'unconfirmed'
    progress.inboxClearStarted = true
    next.inbox.clear()
    progress.inboxCleared = true
    if (modelSelection) { progress.modelSelectionStarted = true; next.model.select(modelSelection); progress.modelSelected = true }
    try { next.followup(replacement) }
    catch (error) {
      progress.followupAccepted = 'unknown'
      if (progress.committed !== true) progress.committed = 'unknown'
      try {
        if (next.inbox.nextTurn.some(item => item.id === replacement.id)) {
          progress.followupAccepted = true
          progress.committed = true
        }
      } catch {}
      throw error
    }
    Object.assign(progress, { committed: true, followupAccepted: true })
    await flush(ctx, next.session)
    progress.durability = 'confirmed'
    return { childSessionId: next.id, sourceSessionId: source.id, revision: next.session.seq - 1,
      replaced: false, followupAccepted: true }
  })
}

function checkCancellation(...signals) {
  if (signals.some(signal => signal?.aborted)) throw new EditError('cancelled', 'The edit was cancelled.')
}
