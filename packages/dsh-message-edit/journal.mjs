/** Durable text-edit decisions carried by existing DSH command records. */
export const COMMIT_COMMAND = 'message-edit-commit'
export const RECEIPT_PREFIX = 'dsh-message-edit/v3:'

export class EditError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'EditError'
    this.code = code
    this.details = details
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSeq = value => Number.isSafeInteger(value) && value >= 0

/** Validate a request at the JSON and persisted-record boundary. */
export function validateEdit(value) {
  if (!isRecord(value) || value.version !== 3 || !isSeq(value.targetSeq)
    || !isSeq(value.revision) || typeof value.messageId !== 'string' || !value.messageId
    || !['user', 'assistant'].includes(value.role) || typeof value.text !== 'string'
    || !value.text.trim() || new TextEncoder().encode(value.text).byteLength > 1048576) {
    throw new EditError('invalid', 'Provide a valid message and nonempty text under 1 MiB.')
  }
  return { version: 3, targetSeq: value.targetSeq, messageId: value.messageId,
    role: value.role, revision: value.revision, text: value.text }
}

/** Decode only this plugin's successful, paired commit records. */
export function decisionOf(event, events, baseSeq = 0) {
  if (event?.type !== 'command/done' || event.data?.kind !== 'success'
    || typeof event.data.text !== 'string' || !event.data.text.startsWith(RECEIPT_PREFIX)) return undefined
  const run = events.find(candidate => candidate.seq < event.seq && candidate.type === 'command/run'
    && candidate.data.commandId === event.data.commandId)
  if (run?.data.name !== COMMIT_COMMAND) return undefined
  if (baseSeq !== 0) throw new EditError('history-unavailable', 'Load the complete history before editing.')
  let value
  try { value = JSON.parse(event.data.text.slice(RECEIPT_PREFIX.length)) }
  catch { throw new EditError('invalid-record', 'The saved edit record is malformed.') }
  return validateEdit(value)
}

/** Replace text only, preserving every other block in its original order. */
export function replaceText(message, text) {
  let inserted = false
  const content = []
  for (const block of message.content) {
    if (block.type !== 'text') { content.push(block); continue }
    if (!inserted) { content.push(Object.freeze({ type: 'text', text })); inserted = true }
  }
  if (!inserted) throw new EditError('no-text', 'This message has no editable text.')
  const result = { ...message, content }
  if (message.role === 'assistant') {
    const { replayState, ...source } = message.source
    void replayState
    result.source = Object.freeze(source)
  }
  return Object.freeze({ ...result, content: Object.freeze(content) })
}

export function assertEditableText(message) {
  let seenText = false
  let separated = false
  for (const block of message.content) {
    if (block.type === 'text') {
      if (separated) throw new EditError('ambiguous-text', 'Text separated by non-text content cannot be edited safely.')
      seenText = true
    } else if (seenText) separated = true
  }
}

/** Read the latest accepted edit revision of an original message. */
export function revisionOf(events, targetSeq, beforeSeq = Infinity) {
  let revision = targetSeq
  for (const event of events) {
    if (event.seq >= beforeSeq) break
    const edit = decisionOf(event, events)
    if (edit?.targetSeq === targetSeq) revision = event.seq
  }
  return revision
}

/** Validate and project an edit against the actual current session surface. */
export function projectDecision(edit, context, eventSeq) {
  validateEdit(edit)
  if (context.baseSeq !== 0 || edit.targetSeq >= eventSeq) {
    throw new EditError('invalid-target', 'The edited message must precede this decision in complete history.')
  }
  const original = context.events[edit.targetSeq]
  const message = original?.type === 'user/message' ? original.data
    : original?.type === 'assistant/message' ? original.data.message : undefined
  if (!message || message.id !== edit.messageId || message.role !== edit.role) {
    throw new EditError('invalid-target', 'The message identity no longer matches the edit.')
  }
  if (!context.nodes.includes(edit.targetSeq)) {
    throw new EditError('compacted', 'This message is already compacted. Edit it in a fork instead.')
  }
  const revision = revisionOf(context.events, edit.targetSeq, eventSeq)
  if (revision !== edit.revision) {
    throw new EditError('conflict', 'This message changed while you were editing.', { currentRevision: revision })
  }
  const current = context.messages.get(edit.targetSeq) ?? message
  return new Map([[edit.targetSeq, replaceText(current, edit.text)]])
}

/** Interpreter registered once per profile. Unrelated commands remain unchanged. */
export const commandEditProjection = Object.freeze({
  type: 'command/done',
  project(event, context) {
    if (event?.type === 'command/done' && event.data?.kind === 'success'
      && typeof event.data.text === 'string' && event.data.text.startsWith('dsh-message-edit-cut/v3:')) {
      const run = context.events.find(candidate => candidate.seq < event.seq && candidate.type === 'command/run'
        && candidate.data.commandId === event.data.commandId)
      if (run?.data.name === 'message-edit-cut') {
        try {
          const cut = JSON.parse(event.data.text.slice('dsh-message-edit-cut/v3:'.length))
          const node = context.events[cut.shadowedNodeSeq]
          if (node?.type === 'user/message' && context.nodes.includes(cut.shadowedNodeSeq)) {
            return new Map([[cut.shadowedNodeSeq, null]])
          }
        } catch {}
      }
      return new Map()
    }
    const edit = decisionOf(event, context.events, context.baseSeq)
    return edit ? projectDecision(edit, context, event.seq) : new Map()
  },
})

/** Current display edits derived from the same durable decisions. */
export function collectEdits(events) {
  const edits = Object.create(null)
  for (const event of events) {
    const edit = decisionOf(event, events)
    if (edit) edits[edit.messageId] = { ...edit, revision: event.seq }
  }
  return edits
}

/** Append an internal command lifecycle under the caller's maintenance reservation. */
export function commitEdit(session, request, commandId) {
  const edit = validateEdit(request)
  const events = session.snapshotEvents()
  projectDecision(edit, { events, baseSeq: 0, nodes: session.surface.nodes,
    messages: new Map(events.flatMap(event => {
      const message = session.deriveEventMessage(event)
      return message ? [[event.seq, message]] : []
    })) }, session.seq)
  session.append('command/run', { commandId, name: COMMIT_COMMAND,
    args: JSON.stringify(edit), source: { kind: 'user' } })
  const receipt = session.append('command/done', { commandId, kind: 'success',
    text: RECEIPT_PREFIX + JSON.stringify(edit), sourceEventSeq: edit.targetSeq })
  return { messageId: edit.messageId, targetSeq: edit.targetSeq, revision: receipt.seq, text: edit.text }
}
