import { memo } from 'react'
import type { InjectFace, PropsRenderSlots, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatNodeViewProps, ChatStore, PerformanceUsageInjected, TurnTailOwnerProps,
} from '../contract/slots.ts'
import {
  messageEditRevision, selectMessageEdit, useMessageEditsAvailable, type MessageEditInjected,
} from './message-edit.ts'
import { MessageEditPanel } from './MessageEditPanel.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import { TurnUsagePanel } from './TurnUsagePanel.tsx'
import { assistantText } from './turn-assistant.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import css from './TurnTailNodeView.module.css'

type TurnTailNodeViewProps = ChatNodeViewProps<'turn-tail'>
  & PropsRenderSlots<'conversation.chat.turnTail' | 'conversation.chat.assistant-actions'>
  & InjectFace<PerformanceUsageInjected & MessageEditInjected>
  & PropsStore<ChatStore>

function lastContent(snapshot: ChatSnapshot, turn: number, skipWarning: boolean): ChatNode | undefined {
  const keys = snapshot.locations.getTurn(turn)
  for (let index = keys.length - 1; index >= 0; index--) {
    const node = snapshot.nodes.get(keys[index] as string) as ChatNode | undefined
    if (node === undefined || node.kind === 'turn-tail' || node.kind === 'turn-process'
      || (skipWarning && node.kind === 'turn-max-tokens')) continue
    return node
  }
  return undefined
}

/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node, openFile, forkAt, renderSlot, t, useAccess, useChat, usePerformanceUsage,
  useProjection, useStore, actions, saveMessageEdit, saveMessageEditAndFork,
}: TurnTailNodeViewProps) {
  const detailed = usePerformanceUsage(mode => mode) === 'detailed'
  const forkAllowed = useAccess('session/fork')
  const data = node.data
  // The closing reply's edit affordance and editor live here, not on the
  // Assistant row: one strip and one panel per message, tail-owned.
  const closingMessageId = data.closing?.finalNode.messageId
  const editsAvailable = useMessageEditsAvailable(useProjection)
  const editEntry = selectMessageEdit(useProjection, closingMessageId)
  const canEdit = useAccess('commands/execute')
  const canFork = useAccess('session/fork')
  const editing = useStore(state =>
    closingMessageId !== undefined && state.messageEdit !== undefined && state.messageEdit.messageId === closingMessageId
      ? state.messageEdit
      : undefined)
  const hasLaterChatNode = useChat(snapshot =>
    (lastContent(snapshot, data.turn, true)?.anchorSeq ?? -1) > (data.closing?.finalNode.seq ?? data.seq))
  const endsWithResponse = useChat((snapshot) => {
    if (snapshot.timeline.turnOrder.at(-1) !== data.turn) return false
    const last = lastContent(snapshot, data.turn, false)
    const block = last?.kind === 'assistant-step' ? last.data.blocks.findLast(candidate =>
      (candidate.kind !== 'text' && candidate.kind !== 'reasoning') || candidate.text.trim() !== '') : undefined
    return block !== undefined && hasAssistantReplyContent([block])
  })
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn === undefined) return null
  const closing = data.closing
  const owner: TurnTailOwnerProps = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile }
  const tail = renderSlot('conversation.chat.turnTail', owner)
  if (closing === null) return tail === null ? null : <div className={css.root} data-turn-tail={data.turn}>{tail}</div>
  // Interruption-frozen partials carry no messageId, so they address no
  // durable message and contribute no per-message actions.
  const messageId = closing.finalNode.messageId
  const assistantActions = messageId === undefined
    ? null
    : renderSlot('conversation.chat.assistant-actions', { messageId })
  const panel = editing !== undefined && messageId !== undefined
    ? (
      <MessageEditPanel
        draft={editing.draft}
        busy={editing.busy}
        canEdit={canEdit}
        canFork={canFork}
        outcome={editing.outcome}
        onChange={actions.setMessageEditDraft}
        onCancel={actions.closeMessageEdit}
        onSave={() => { saveMessageEdit(editing.messageId, editing.targetSeq, editing.draft, editing.revision) }}
        onSaveAndFork={() => { saveMessageEditAndFork(editing.messageId, editing.targetSeq, editing.draft, editing.revision) }}
        t={t}
      />
    )
    : null
  const openEditor = messageId !== undefined && editsAvailable && canEdit && editing === undefined
    ? () => {
      actions.openMessageEdit(
        messageId,
        closing.finalNode.seq,
        messageEditRevision(editEntry, closing.finalNode.seq),
        editEntry?.text ?? assistantText(closing.blocks),
      )
    }
    : undefined
  return (
    <div
      className={css.root}
      data-turn-tail={data.turn}
      data-actions-reveal={endsWithResponse ? 'always' : 'hover'}
    >
      {tail}
      {panel ?? (
        <MessageIconActions
          // A committed edit overlays the copy payload the way it overlays the reply text.
          text={editEntry?.text ?? assistantText(closing.blocks)}
          time={closing.time}
          clock="end"
          onEdit={openEditor}
          // The branch action owns boundary resolution: it sends the real
          // turn/end seq it already has, and the Host cuts exactly there.
          onBranch={forkAllowed ? () => { forkAt(data.seq) } : undefined}
          branchUnavailable={data.branchUnavailable || hasLaterChatNode}
          className={css.actions}
          extraActions={assistantActions}
          usageAction={detailed && data.tokenUsage !== undefined
            ? <TurnUsagePanel usage={data.tokenUsage} t={t} />
            : null}
          t={t}
        />
      )}
    </div>
  )
})
