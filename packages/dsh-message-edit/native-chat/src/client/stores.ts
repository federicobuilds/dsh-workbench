/** Per-Session Chat view store. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type {
  ChatStoreState, MessageEditOutcome, TurnProcessViewEntry,
} from './contract/store.ts'
import type { TurnProcessSpec } from './contract/turn-process.ts'

type ChatActions = {
  setTurnProcessOpen: (
    draft: ChatStoreState,
    turn: number,
    answerStep: number,
    open: boolean,
  ) => void
  /**
   * Open the message editor on one target, replacing any open editor and
   * initializing the draft from the target's current text.
   */
  openMessageEdit: (
    draft: ChatStoreState,
    messageId: MessageId,
    targetSeq: number,
    revision: number,
    text: string,
  ) => void
  /** Update the open editor's draft. */
  setMessageEditDraft: (draft: ChatStoreState, text: string) => void
  /** Choose a model for user regeneration without changing the source or global default. */
  setMessageEditModel: (draft: ChatStoreState, selection: { provider: string; model: string } | undefined) => void
  /** Replace the open editor's CAS revision (conflict retry). */
  setMessageEditRevision: (draft: ChatStoreState, revision: number) => void
  /** Mark the open editor's save attempt in flight or settled. */
  setMessageEditBusy: (draft: ChatStoreState, busy: boolean) => void
  /** Publish or clear the open editor's transient outcome. */
  setMessageEditOutcome: (draft: ChatStoreState, outcome: MessageEditOutcome | undefined) => void
  /** Close the open editor. */
  closeMessageEdit: (draft: ChatStoreState) => void
}

/**
 * Resolve the manual disclosure choice for one Turn.
 * @param state - Chat store snapshot.
 * @param turn - owning Turn.
 * @returns the Turn's stored entry, when present.
 */
export function storedTurnProcessEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<TurnProcessViewEntry> | undefined {
  return state.turnProcesses.find(entry => entry.turn === turn)
}

/**
 * Whether a foldable Turn's process is open: the reader's choice for the current answer generation
 * wins; otherwise the latest completed Turn stays open until the next input, and older Turns fold.
 * @param state - Chat store snapshot.
 * @param spec - the Turn's process specification.
 * @param defaultOpen - whether this Turn is exempt from automatic folding.
 * @returns the effective open state.
 */
export function turnProcessOpen(
  state: Readonly<ChatStoreState>,
  spec: Pick<TurnProcessSpec, 'turn' | 'answerStep'>,
  defaultOpen: boolean,
): boolean {
  const stored = storedTurnProcessEntry(state, spec.turn)
  if (stored === undefined || stored.answerStep !== (spec.answerStep ?? 0)) return defaultOpen
  return stored.collapsed !== true
}

/**
 * Create the Chat view store handle.
 * @returns a handle instantiated once per rendered Session scope.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    init: (): ChatStoreState => ({ turnProcesses: [] }),
    actions: {
      setTurnProcessOpen: (draft, turn, answerStep, open) => {
        const index = draft.turnProcesses.findIndex(entry => entry.turn === turn)
        const next = (open ? { turn, answerStep } : { turn, answerStep, collapsed: true }) satisfies TurnProcessViewEntry
        if (index < 0) draft.turnProcesses.push(next)
        else draft.turnProcesses[index] = next
      },
      openMessageEdit: (state, messageId, targetSeq, revision, text) => {
        if (state.messageEdit?.busy) return
        state.messageEdit = { messageId, targetSeq, revision, draft: text, busy: false }
      },
      setMessageEditDraft: (state, text) => {
        if (state.messageEdit === undefined) return
        state.messageEdit.draft = text
      },
      setMessageEditModel: (state, selection) => {
        if (state.messageEdit === undefined || state.messageEdit.busy) return
        if (selection === undefined) delete state.messageEdit.modelSelection
        else state.messageEdit.modelSelection = selection
      },
      setMessageEditRevision: (state, revision) => {
        if (state.messageEdit === undefined) return
        state.messageEdit.revision = revision
      },
      setMessageEditBusy: (state, busy) => {
        if (state.messageEdit === undefined) return
        state.messageEdit.busy = busy
      },
      setMessageEditOutcome: (state, outcome) => {
        if (state.messageEdit === undefined) return
        if (outcome === undefined) delete state.messageEdit.outcome
        else state.messageEdit.outcome = outcome
      },
      closeMessageEdit: (state) => {
        delete state.messageEdit
      },
    },
  })
}
