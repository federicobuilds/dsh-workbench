/** Chat-owned per-Session view state. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Tool call identity as carried by Chat nodes. */
export type ToolCallId = string

/** One manual whole-Turn disclosure choice for a Turn answer generation. */
export interface TurnProcessViewEntry {
  readonly turn: number
  readonly answerStep: number
  /** Explicitly collapsed; absent means explicitly opened. */
  readonly collapsed?: true
}

/** Transient outcome of the open message editor's last attempt. */
export type MessageEditOutcome =
  /** The Host rejected a stale revision; the retained revision was refreshed for retry. */
  | { readonly kind: 'conflict' }
  /** The agent is still active; wait before saving. */
  | { readonly kind: 'busy' }
  /** The target cannot be edited on the current model surface. */
  | { readonly kind: 'invalidTarget' }
  /** An in-memory commit could not be confirmed durable. */
  | { readonly kind: 'unconfirmed' }
  /** The edit call failed; the draft is retained. */
  | { readonly kind: 'failed' }
  /** The fork-then-edit call failed before any settlement; the draft is retained. */
  | { readonly kind: 'forkFailed' }
  /** The fork succeeded without the edit: the child exists and is named by its identity. */
  | { readonly kind: 'partialFork'; readonly childSessionId: SessionId }
  | { readonly kind: 'operationError'; readonly message: string; readonly childSessionId?: SessionId }

/** Interaction state of the one open message editor; at most one exists per Session. */
export interface MessageEditState {
  /** Identity of the durable message being edited. */
  readonly messageId: MessageId
  /** Event seq of the message being edited. */
  readonly targetSeq: number
  /** CAS revision for the next attempt: the latest edit seq when edited, else the target seq. */
  revision: number
  /** Draft text, initialized from the current (possibly already edited) text. */
  draft: string
  /** Optional model used only for this user-message regeneration. */
  modelSelection?: { readonly provider: string; readonly model: string }
  /** A save or save-and-fork attempt is in flight. */
  busy: boolean
  /** Outcome of the latest failed attempt; a successful attempt closes the editor instead. */
  outcome?: MessageEditOutcome
}

/** Per-Session state shared only by the Chat view and details surface. */
export interface ChatStoreState {
  turnProcesses: TurnProcessViewEntry[]
  /** The open message editor; opening another replaces it. */
  messageEdit?: MessageEditState
}
