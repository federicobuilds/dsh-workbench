import { memo, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRenderSlots, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatFileMentions, ChatNodeViewProps, ChatStore, PresentationInjected, TurnTailOwnerProps,
} from '../contract/slots.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import { assistantText } from './turn-assistant.ts'
import {
  messageEditRevision, overlayAssistantBlocks, selectMessageEdit, useMessageEditsAvailable,
  type MessageEditInjected,
} from './message-edit.ts'
import { MessageEditPanel } from './MessageEditPanel.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './AssistantMarkdown.module.css'

/** Business readers owned by the assistant renderer's existing Slot registration. */
export interface AssistantNodeInjected extends PresentationInjected {
  /** Resolve against the live Session directory. @param path - Recorded path. @returns Host path. */
  resolveFilePath: (path: string) => string
  /** Resolve closing-Turn mentions with the supplied ordinary file gesture callback. */
  fileMentions: (owner: TurnTailOwnerProps, getFileTriggerProps: NonNullable<Parameters<ChatFileMentions['forClosing']>[2]>) => ReturnType<ChatFileMentions['forClosing']>
}

type AssistantNodeViewProps = ChatNodeViewProps<'assistant-step'>
  & InjectFace<AssistantNodeInjected & MessageEditInjected>
  & PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.message.images'>
  & PropsStore<ChatStore>

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, groupPart, useDisclosure, useGroupAction, useTurnData, turnProcess, openFile, loadImage, fileMentions,
  usePresentation, renderSlot, useProjection, useAccess, useStore, actions,
  saveMessageEdit, saveMessageEditAndFork, t, sessionId, useContextMenu, resolveFilePath,
}: AssistantNodeViewProps) {
  const { getTriggerProps } = useContextMenu()
  const getFileTriggerProps = useCallback((path: string) => getTriggerProps(() => ({
    kind: 'file', value: { sessionId, path: resolveFilePath(path) },
  })), [getTriggerProps, sessionId, resolveFilePath])
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const messageId = data.finalNode?.messageId
  const editsAvailable = useMessageEditsAvailable(useProjection)
  const editEntry = selectMessageEdit(useProjection, messageId)
  const canEdit = useAccess('commands/execute')
  const canFork = useAccess('session/fork')
  const editing = useStore(state =>
    messageId !== undefined && state.messageEdit !== undefined && state.messageEdit.messageId === messageId
      ? state.messageEdit
      : undefined)
  // The committed edit overlays the text blocks of the displayed content;
  // reasoning, images, and tool rows keep their original order.
  const blocks = useMemo(
    () => editEntry === undefined ? data.blocks : overlayAssistantBlocks(data.blocks, editEntry.text),
    [data.blocks, editEntry],
  )
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner, getFileTriggerProps),
    [fileMentions, owner, getFileTriggerProps],
  )
  const keepReplies = usePresentation(policy => policy.foldedReplies === 'all')
  // A kept reply row stays visible while the folded Turn hides its inline reasoning.
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable
    && (keepReplies
      ? groupPart !== 'reasoning'
      : turnProcess.spec.answerStep === data.step && turnProcess.spec.inlineReasoning)
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  // Single ownership with the turn tail: the tail's strip and editor serve the
  // closing reply once its data lands; until then (or when it never loads in
  // a partial window) the finalized row serves its own actions and editor.
  const closingMessageId = tail?.closing?.finalNode.messageId
  if (editing !== undefined && messageId !== closingMessageId) {
    const { messageId: editId, targetSeq, draft, revision, busy, outcome } = editing
    return (
      <MessageEditPanel
        draft={draft}
        busy={busy}
        canEdit={canEdit}
        canFork={canFork}
        outcome={outcome}
        onChange={actions.setMessageEditDraft}
        onCancel={actions.closeMessageEdit}
        onSave={() => { saveMessageEdit(editId, targetSeq, draft, revision) }}
        onSaveAndFork={() => { saveMessageEditAndFork(editId, targetSeq, draft, revision) }}
        t={t}
      />
    )
  }
  // The reasoning part never carries the action strip.
  const finalNode = data.finalNode
  let strip: ReactNode = null
  if (data.status === 'settled'
    && finalNode?.messageId !== undefined
    && finalNode.messageId !== closingMessageId
    && groupPart !== 'reasoning') {
    const editMessageId = finalNode.messageId
    const openEditor = editsAvailable && canEdit
      ? () => {
        actions.openMessageEdit(
          editMessageId,
          finalNode.seq,
          messageEditRevision(editEntry, finalNode.seq),
          assistantText(blocks),
        )
      }
      : undefined
    strip = (
      <div data-actions-reveal="hover">
        <MessageIconActions
          text={assistantText(blocks)}
          time={finalNode.time}
          clock="end"
          onEdit={openEditor}
          className={css.actions}
          t={t}
        />
      </div>
    )
  }
  return (
    <>
      <AssistantMarkdown
        blocks={blocks}
        groupPart={groupPart}
        useDisclosure={useDisclosure}
        streaming={data.status === 'running'}
        textInteractionSource={data.status === 'settled' && data.finalNode?.messageId !== undefined}
        interrupted={data.status === 'interrupted'}
        loadImage={loadImage}
        reasoningHidden={reasoningHidden}
        useGroupAction={useGroupAction}
        usePresentation={usePresentation}
        renderSlot={renderSlot}
        revealProcess={revealProcess}
        mentions={mentions}
        t={t}
      />
      {strip}
    </>
  )
})
