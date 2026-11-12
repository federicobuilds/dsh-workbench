import { commandEdit } from '../../../../bridge.mjs'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PerformanceUsageMode } from '../../chat-settings.ts'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'
import type { ChatStore } from '../contract/slots.ts'
import { NS } from '../locale.ts'
import { AssistantNodeView, type AssistantNodeInjected } from './AssistantNodeView.tsx'
import { sessionFilePath } from '../file-path.ts'
import { CommandNodeView, ManualCompactionNodeView } from './CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from './MessageItem.tsx'
import { DefaultReasoningBody, ReasoningContent } from './ReasoningContent.tsx'
import { SystemPromptNodeView } from './SystemPromptRow.tsx'
import { TurnProcessNodeView } from './TurnProcessNodeView.tsx'
import { TurnTailNodeView } from './TurnTailNodeView.tsx'
import { TurnTriggerNodeView } from './TurnTriggerNodeView.tsx'
import { bindMessageEditCallbacks, type MessageEditInjected, type UserModelEditInjected } from './message-edit.ts'

/**
 * Register this package's business renderers behind the keyed Chat Node seat.
 * Renderers whose output depends on the work-details mode receive the policy
 * through their own registration; the seat and the other renderers do not.
 * @param ctx - owning UI Conversation context.
 * @param performanceUsage - live statistics detail preference.
 * @param presentation - live presentation policy.
 * @param chatStore - shared Chat store handle; editable-row registrations declare it.
 */
export function registerChatNodeRenderers(
  ctx: Context,
  performanceUsage: ObservableSnapshot<PerformanceUsageMode>,
  presentation: ObservableSnapshot<ChatPresentationPolicy>,
  chatStore: ChatStore,
): void {
  // One edit face per rendered Session: the bound Session's verbs, the
  // session-scope store actions, and the workspace's child-session opener.
  const editInjected = (sessionId: SessionId, actions: BoundActions<ChatStore>, role = 'assistant'): MessageEditInjected => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) {
      // Rows must keep rendering when the edit face is unavailable (renderer
      // probes without a retained Session); controls stay inert.
      return { saveMessageEdit: () => {}, saveMessageEditAndFork: () => {} }
    }
    const face = {
      editMessage: (messageId, targetSeq, text, revision, modelSelection) => commandEdit(ctx, sessionId, role, messageId, targetSeq, text, revision, 'save', modelSelection),
      editMessageAndFork: (messageId, targetSeq, text, revision, modelSelection) => commandEdit(ctx, sessionId, role, messageId, targetSeq, text, revision, 'fork', modelSelection),
    }
    return bindMessageEditCallbacks(face, actions, (childId) => { ctx.uiWorkspace.openSession(childId) })
  }
  const userEditInjected = (sessionId: SessionId, actions: BoundActions<ChatStore>): UserModelEditInjected => {
    const directory = ctx.modelDirectories.directoryFor(sessionId)
    return { ...editInjected(sessionId, actions, 'user'), hooks: { editModels: directory.store },
      loadEditModels: () => { void directory.load().catch(() => { /* the directory publishes its load failure */ }) } }
  }
  ctx.effect(() => ctx.slots.registerFactory({
    name: 'conversation.chat.reasoning.content',
    scope: 'root',
    locale: NS,
  }, ReasoningContent))
  ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register({
    name: 'conversation.chat.reasoning.body',
    priority: 100,
  }, DefaultReasoningBody))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'user', locale: NS, store: chatStore,
    children: { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } },
    inject: userEditInjected,
  }, UserMessageNodeView))
  // Steering rows share the renderer without owning the message-source seat.
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'steering', locale: NS, store: chatStore,
    inject: (sessionId, actions) => ({ renderSlotChain: () => null, ...userEditInjected(sessionId, actions) }),
  }, UserMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'context', locale: NS }, ContextMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-trigger', locale: NS }, TurnTriggerNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'system-prompt', locale: NS }, SystemPromptNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    locale: NS,
    store: chatStore,
    children: {
      'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
      'conversation.chat.message.images': { kind: 'single', scope: 'session' },
    },
    inject: (sessionId, actions): AssistantNodeInjected & MessageEditInjected => ({
      hooks: { presentation },
      resolveFilePath: sessionFilePath(ctx, sessionId),
      fileMentions: (owner, getFileTriggerProps) => ctx.get('chatFileMentions')?.forClosing(owner, sessionId, getFileTriggerProps),
      ...editInjected(sessionId, actions),
    }),
  }, AssistantNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command',
    locale: NS,
    children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
  }, CommandNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'manual-compaction', locale: NS }, ManualCompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'compaction', locale: NS }, CompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'model-retry', locale: NS }, RetryNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-error', locale: NS }, TurnErrorNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-max-tokens', locale: NS }, TurnMaxTokensNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-process', locale: NS }, TurnProcessNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'turn-tail',
    locale: NS,
    store: chatStore,
    inject: (sessionId, actions) => ({ hooks: { performanceUsage }, ...editInjected(sessionId, actions, 'assistant') }),
    children: {
      'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    },
  }, TurnTailNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'unknown', locale: NS }, UnknownNodeView))
}
