/**
 * Shared message-edit facts: projection selection, display overlay, and the
 * Session verbs the keyed renderers trigger. The authoritative edited text
 * arrives only through the `messageEdits` projection; this module keeps the
 * interaction's transient state in the Chat store.
 */
// Type-only: the `messageEdits` SessionProjectionMap key merge (single source, the domain's pure outlet).
import type {} from '@deepseek-ai/dsh-message-edit/types'
import type { MessageEditEntry } from '@deepseek-ai/dsh-message-edit/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISession, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { BoundActions, ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { MessageEditState } from '../contract/store.ts'
type RegenerationModel = MessageEditState['modelSelection']
import type { AssistantBlock } from '../contract/snapshot.ts'
import type { ChatStore } from '../contract/slots.ts'

/** Edit verbs injected into the keyed Chat renderers that own editable rows. */
export interface MessageEditInjected {
  /**
   * Commit the supplied draft into this session. Outcomes land in the Chat
   * store's open editor; success closes it.
   * @param messageId - identity of the message being edited.
   * @param targetSeq - event seq of the message.
   * @param text - draft text.
   * @param expectedRevision - CAS revision the caller last observed.
   */
  readonly saveMessageEdit: (messageId: MessageId, targetSeq: number, text: string, expectedRevision: number, modelSelection?: RegenerationModel) => void
  /**
   * Fork this session at the edited message and commit the draft into the
   * child; a confirmed edit navigates to the child. Partial and failed
   * settlements keep the editor open with their outcome.
   * @param messageId - identity of the message being edited.
   * @param targetSeq - event seq of the message.
   * @param text - draft text.
   * @param expectedRevision - CAS revision the caller last observed.
   */
  readonly saveMessageEditAndFork: (messageId: MessageId, targetSeq: number, text: string, expectedRevision: number, modelSelection?: RegenerationModel) => void
}

export interface UserModelEditInjected extends MessageEditInjected {
  readonly hooks: { readonly editModels: ObservableSnapshot<ModelDirectoryState> }
  readonly loadEditModels: () => void
}

/**
 * Field equality for one projected edit entry, keeping a per-message
 * selection stable while unrelated record entries are rebuilt.
 * @param a - previous selection.
 * @param b - next selection.
 * @returns whether both entries carry the same edit.
 */
export function messageEditEntryEqual(a: MessageEditEntry | undefined, b: MessageEditEntry | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.text === b.text && a.targetSeq === b.targetSeq && a.editSeq === b.editSeq
}

/**
 * Resolve one message's current edit entry through the standard projection seat.
 * @param useProjection - the session-scope projection reader.
 * @param messageId - durable message identity, or absence for rows without one.
 * @returns the latest committed edit for the message, when any exists.
 */
export function selectMessageEdit(
  useProjection: UseProjection,
  messageId: MessageId | undefined,
): MessageEditEntry | undefined {
  return useProjection(
    'messageEditJournal',
    view => messageId === undefined || view?.edits?.[messageId] === undefined ? undefined : { ...view.edits[messageId], editSeq: view.edits[messageId].revision },
    messageEditEntryEqual,
  )
}

/**
 * Whether the messageEdits capability is present for this session. A mounted
 * Host unit with no edits still reads as an empty record; only an absent key
 * (unmounted unit, or no baseline/frame has landed) reads undefined.
 * @param useProjection - the session-scope projection reader.
 * @returns whether edit state is served at all.
 */
export function useMessageEditsAvailable(useProjection: UseProjection): boolean {
  return useProjection('messageEditJournal', view => view !== undefined)
}

/**
 * CAS revision for the next edit attempt on one target.
 * @param entry - the target's latest committed edit, when present.
 * @param targetSeq - event seq of the message.
 * @returns the entry's edit seq when edited, else the target seq.
 */
export function messageEditRevision(entry: MessageEditEntry | undefined, targetSeq: number): number {
  return entry?.editSeq ?? targetSeq
}

/**
 * Replace the text blocks of Assistant content with one edited text at the
 * first text position, preserving every non-text block and their order —
 * the same install the Session's message projection performs.
 * @param blocks - original Assistant content blocks.
 * @param text - committed replacement text.
 * @returns the overlaid block sequence.
 */
export function overlayAssistantBlocks(blocks: readonly AssistantBlock[], text: string): readonly AssistantBlock[] {
  let replaced = false
  const overlaid: AssistantBlock[] = []
  for (const block of blocks) {
    if (block.kind !== 'text') {
      overlaid.push(block)
      continue
    }
    if (replaced) continue
    overlaid.push({ kind: 'text', text })
    replaced = true
  }
  // A committed edit requires a text target; this arm keeps the overlay total.
  if (!replaced) overlaid.unshift({ kind: 'text', text })
  return overlaid
}

/**
 * Replace the text blocks of user message content with one edited text at
 * the first text position, preserving every non-text block and their order.
 * @param content - original user message content blocks.
 * @param text - committed replacement text.
 * @returns the overlaid content sequence.
 */
export function overlayUserContent(content: readonly ContentBlock[], text: string): readonly ContentBlock[] {
  let replaced = false
  const overlaid: ContentBlock[] = []
  for (const block of content) {
    if (block.type !== 'text') {
      overlaid.push(block)
      continue
    }
    if (replaced) continue
    overlaid.push({ type: 'text', text })
    replaced = true
  }
  // A committed edit requires a text target; this arm keeps the overlay total.
  if (!replaced) overlaid.unshift({ type: 'text', text })
  return overlaid
}

/**
 * Join the text blocks of user message content the way the row display does.
 * @param content - user message content blocks.
 * @returns concatenated text blocks.
 */
export function userContentText(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** The edit operations the orchestration needs from the bound Session. */
export type MessageEditSessionFace = {
  [K in 'editMessage' | 'editMessageAndFork']:
    (...args: [...Parameters<ISession[K]>, RegenerationModel?]) => ReturnType<ISession[K]>
}

/**
 * Build one session's edit callbacks over its Chat store actions. The
 * closures single-flight each settlement: a store busy flag fences renders,
 * and an in-flight guard fences same-frame gestures the pending render has
 * not yet disabled.
 * @param session - bound Session edit verbs.
 * @param actions - baked Chat store actions of the same session scope.
 * @param openChild - child-session opener, invoked only on a confirmed fork-then-edit.
 * @returns the save and save-and-fork verbs for the keyed renderers.
 */
export function bindMessageEditCallbacks(
  session: MessageEditSessionFace,
  actions: BoundActions<ChatStore>,
  openChild: (childSessionId: SessionId) => void,
): MessageEditInjected {
  let inFlight = false
  const settle = (): void => {
    inFlight = false
    actions.setMessageEditBusy(false)
  }
  return {
    saveMessageEdit(messageId, targetSeq, text, expectedRevision, modelSelection) {
      if (inFlight) return
      inFlight = true
      actions.setMessageEditBusy(true)
      actions.setMessageEditOutcome(undefined)
      session.editMessage(messageId, SessionSeq(targetSeq), text, SessionSeq(expectedRevision), modelSelection)
        .then((result) => {
          if (result.ok) {
            if (result.value?.kind === 'partial') {
              actions.setMessageEditOutcome({ kind: 'partialFork', childSessionId: result.value.childSessionId })
              return
            }
            actions.closeMessageEdit()
            if (result.value?.childSessionId) openChild(result.value.childSessionId)
            return
          }
          const error = result.error
          if (error.code === 'session/edit-conflict') {
            if (error.details.currentRevision !== undefined) actions.setMessageEditRevision(error.details.currentRevision)
            actions.setMessageEditOutcome({ kind: 'conflict' })
          } else if (error.code === 'session/agent-busy') {
            actions.setMessageEditOutcome({ kind: 'busy' })
          } else if (error.code === 'session/edit-target-invalid') {
            actions.setMessageEditOutcome({ kind: 'invalidTarget' })
          } else if (error.details?.durability === 'unconfirmed') {
            actions.setMessageEditOutcome({ kind: 'unconfirmed' })
          } else {
            actions.setMessageEditOutcome({ kind: 'operationError', message: error.message, childSessionId: error.details?.childSessionId })
          }
        })
        .catch(() => {
          // Assembly faults (unmounted method, carrier mismatch) carry no RemoteResult branch.
          actions.setMessageEditOutcome({ kind: 'failed' })
        })
        .finally(settle)
    },
    saveMessageEditAndFork(messageId, targetSeq, text, expectedRevision, modelSelection) {
      if (inFlight) return
      inFlight = true
      actions.setMessageEditBusy(true)
      actions.setMessageEditOutcome(undefined)
      session.editMessageAndFork(messageId, SessionSeq(targetSeq), text, SessionSeq(expectedRevision), modelSelection)
        .then((result) => {
          if (!result.ok) {
            if (result.error.details?.durability === 'unconfirmed') actions.setMessageEditOutcome({ kind: 'unconfirmed' })
            else actions.setMessageEditOutcome({ kind: 'operationError', message: result.error.message, childSessionId: result.error.details?.childSessionId })
            return
          }
          const value = result.value
          if (value.kind === 'edited') {
            actions.closeMessageEdit()
            openChild(value.childSessionId)
            return
          }
          actions.setMessageEditOutcome({ kind: 'partialFork', childSessionId: value.childSessionId })
        })
        .catch(() => {
          actions.setMessageEditOutcome({ kind: 'forkFailed' })
        })
        .finally(settle)
    },
  }
}
