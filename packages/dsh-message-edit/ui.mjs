/** Compact editable Chat presentation, hosted in DSH's existing conversation slot. */
import React from 'react'
import { marked } from 'marked'

const h = React.createElement
const NS = 'message-edit'
const strings = {
  you: 'You', assistant: 'Assistant', edit: 'Edit message', copy: 'Copy text', copied: 'Copied',
  save: 'Save changes', fork: 'Save in a fork', userSave: 'Save and regenerate in a fork',
  cancel: 'Cancel', saving: 'Saving…', edited: 'Edited', older: 'Load earlier messages',
  loading: 'Loading…', empty: 'Send a message to start the conversation.',
  assistantNote: 'Updates the history used by future replies. Existing replies are not rerun.',
  userNote: 'The corrected message continues in a new fork. This conversation stays unchanged.',
  unavailable: 'Editing is unavailable until the plugin and session finish loading.',
  partial: 'A fork was created but the operation did not finish. Review it before retrying.',
  conflict: 'This message changed elsewhere. Your draft is preserved; reopen the message to review the latest text.',
  inspect: 'Inspect tool call', details: 'Details', reason: 'Reasoning', unsaved: 'Unsaved edit',
  more: 'Work details', attachment: 'Attachment', original: 'Original records are preserved.',
}
const zh = {
  you: '你', assistant: '助手', edit: '编辑消息', copy: '复制文本', copied: '已复制',
  save: '保存修改', fork: '保存到分支', userSave: '保存并在分支中重新生成', cancel: '取消',
  saving: '保存中…', edited: '已编辑', older: '加载更早的消息', loading: '加载中…',
  empty: '发送消息以开始对话。', assistantNote: '更新后续回复使用的历史记录，不重新运行已有回复。',
  userNote: '修改后的消息会在新分支中继续，当前对话保持不变。', unavailable: '插件和会话加载后才能编辑。',
  partial: '分支已创建，但操作未完成。请先检查，再决定是否重试。',
  conflict: '此消息已在别处修改。草稿已保留；请重新打开消息并查看最新文本。',
  inspect: '检查工具调用', details: '详细信息', reason: '思考过程', unsaved: '未保存的修改',
  more: '工作详情', attachment: '附件', original: '原始记录已保留。',
}

const CSS = `
.me-chat{--me-line:var(--dsw-alias-border-l2);--me-muted:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-primary);width:100%;min-height:100%;padding:22px 24px 28px;box-sizing:border-box}
.me-column{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:25px}.me-row{min-width:0;position:relative}.me-row[data-role=user]{align-self:flex-end;width:min(100%,660px)}
.me-label{display:flex;align-items:center;gap:8px;font-size:11px;line-height:20px;color:var(--me-muted);margin-bottom:6px}.me-row[data-role=user] .me-label{justify-content:flex-end}
.me-bubble{padding:12px 17px;border-radius:17px 17px 5px 17px;background:var(--dsw-alias-interactive-bg-hover-solid);overflow-wrap:anywhere}.me-row[data-role=assistant] .me-bubble{background:transparent;padding:0;border-radius:0}
.me-markdown{font-size:14px;line-height:1.7;overflow-wrap:anywhere}.me-markdown>:first-child{margin-top:0}.me-markdown>:last-child{margin-bottom:0}.me-markdown p{margin:0 0 12px;white-space:pre-wrap}.me-markdown pre,.me-json{padding:12px 14px;max-width:100%;overflow:auto;border:1px solid var(--me-line);border-radius:9px;background:var(--dsw-alias-markdown-code-block);font-size:12px;line-height:1.5}.me-markdown code{font-family:ui-monospace,monospace;font-size:.9em}.me-markdown a{color:var(--dsw-alias-state-info-primary);text-decoration:underline;text-underline-offset:3px}.me-markdown blockquote{border-left:2px solid var(--me-line);margin:12px 0;padding:0 14px;color:var(--dsw-alias-label-secondary)}.me-table-wrap{overflow:auto}.me-markdown table{border-collapse:collapse;width:100%;font-size:13px}.me-markdown th,.me-markdown td{border-bottom:1px solid var(--me-line);padding:7px 10px;text-align:left}.me-markdown hr{border:0;border-top:1px solid var(--me-line);margin:20px 0}
.me-actions{display:flex;gap:4px;align-items:center;opacity:0;transition:opacity .14s;margin-top:7px}.me-row[data-role=user] .me-actions{justify-content:flex-end}.me-row:hover .me-actions,.me-row:focus-within .me-actions{opacity:1}.me-button{display:inline-flex;justify-content:center;align-items:center;gap:6px;font:inherit;font-size:12px;line-height:20px;padding:5px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.me-button:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}.me-button:focus-visible,.me-textarea:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary);outline-offset:3px}.me-button[disabled]{opacity:.45;cursor:default}.me-button[data-primary]{border-color:var(--dsw-alias-state-info-primary);background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}.me-button[data-icon]{width:30px;height:30px;padding:4px}
.me-editor{border:1px solid var(--me-line);border-radius:13px;padding:12px;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:10px}.me-editor-head{display:flex;justify-content:space-between;color:var(--me-muted);font-size:11px}.me-textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:115px;max-height:60vh;padding:10px;font:inherit;font-size:14px;line-height:1.6;color:inherit;background:transparent;border:0;border-radius:5px}.me-editor-actions{display:flex;gap:5px;flex-wrap:wrap;align-items:center}.me-note{font-size:11px;line-height:1.5;color:var(--me-muted)}.me-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}.me-tools{border-left:1px solid var(--me-line);padding-left:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}.me-tools summary{cursor:pointer;padding:5px 0}.me-media{margin-top:9px;display:flex;flex-wrap:wrap;gap:6px}.me-chip{font-size:12px;padding:5px 8px;border:1px solid var(--me-line);border-radius:7px}.me-top{display:flex;justify-content:center}.me-empty{color:var(--me-muted);font-size:14px;padding:32px 0;text-align:center}.me-edited{font-size:10px;border:1px solid var(--me-line);border-radius:4px;padding:0 4px}
@media(hover:none){.me-actions{opacity:1}}@media(max-width:480px){.me-chat{padding:16px 14px 24px}.me-column{gap:22px}.me-textarea{font-size:16px}.me-editor-actions .me-button{padding:6px 8px}.me-bubble{padding:11px 14px}}
`

/** Reject script/data URL navigation; React escapes all rendered token text. */
export function safeHref(value) {
  if (typeof value !== 'string') return undefined
  return /^(https?:|mailto:)/i.test(value.trim()) ? value : undefined
}
function tokens(nodes, prefix = 't') {
  return (nodes ?? []).map((token, i) => {
    const key = prefix + i
    const children = () => tokens(token.tokens, key)
    switch (token.type) {
      case 'text': return token.tokens ? h(React.Fragment, { key }, children()) : h(React.Fragment, { key }, token.text)
      case 'paragraph': return h('p', { key }, children())
      case 'heading': return h('h' + Math.min(6, Math.max(1, token.depth)), { key }, children())
      case 'strong': return h('strong', { key }, children())
      case 'em': return h('em', { key }, children())
      case 'del': return h('del', { key }, children())
      case 'codespan': return h('code', { key }, token.text)
      case 'code': return h('pre', { key }, h('code', null, token.text))
      case 'br': return h('br', { key })
      case 'hr': return h('hr', { key })
      case 'blockquote': return h('blockquote', { key }, children())
      case 'link': return safeHref(token.href)
        ? h('a', { key, href: safeHref(token.href), target: '_blank', rel: 'noopener noreferrer' }, children())
        : h('span', { key }, children())
      case 'image': return h('span', { key }, token.text || token.href)
      case 'list': return h(token.ordered ? 'ol' : 'ul', { key, ...(token.ordered ? { start: token.start } : {}) },
        token.items.map((item, j) => h('li', { key: j }, tokens(item.tokens, key + j))))
      case 'table': return h('div', { className: 'me-table-wrap', key }, h('table', null,
        h('thead', null, h('tr', null, token.header.map((cell, j) => h('th', { key: j }, tokens(cell.tokens))))),
        h('tbody', null, token.rows.map((row, j) => h('tr', { key: j }, row.map((cell, k) => h('td', { key: k }, tokens(cell.tokens))))))))
      case 'space': return null
      default: return h('span', { key }, token.raw ?? token.text ?? '')
    }
  })
}
export function Markdown({ text }) {
  const parsed = React.useMemo(() => marked.lexer(text, { gfm: true, breaks: false }), [text])
  return h('div', { className: 'me-markdown' }, tokens(parsed))
}
function icon(kind) {
  const paths = kind === 'edit' ? ['M12 3l5 5M4 16l1-5L14 2l4 4-9 9-5 1z']
    : ['M7 6V3h10v11h-3', 'M3 7h10v11H3z']
  return h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
    paths.map((d, i) => h('path', { d, key: i, strokeLinejoin: 'round', strokeLinecap: 'round' })))
}
function textOf(blocks) {
  return (blocks ?? []).filter(block => block.type === 'text' || block.kind === 'text').map(block => block.text).join('')
}
function identity(node) {
  const data = node.data ?? {}
  if (node.kind === 'user' || node.kind === 'steering') return data.messageId
    ? { role: 'user', id: data.messageId, seq: data.seq, blocks: data.content ?? [] } : undefined
  if (node.kind === 'assistant-step' && data.status === 'settled' && data.finalNode?.messageId) {
    return { role: 'assistant', id: data.finalNode.messageId, seq: data.finalNode.seq, blocks: data.blocks ?? [] }
  }
  return undefined
}

function Editor({ editor, setEditor, runEdit, openChild, canFork, t }) {
  const inFlight = React.useRef(false)
  const save = async action => {
    if (inFlight.current || editor.busy || !editor.draft.trim()) return
    inFlight.current = true
    setEditor(current => current ? { ...current, busy: true, error: undefined } : current)
    try {
      const result = await runEdit({ version: 3, messageId: editor.id, targetSeq: editor.seq,
        role: editor.role, revision: editor.revision, text: editor.draft, action })
      if (!result.ok) {
        const error = result.error
        setEditor(current => current ? { ...current, busy: false,
          error: error.code === 'conflict' ? t('conflict') : error.message,
          partial: error.details?.childSessionId } : current)
        return
      }
      setEditor(undefined)
      if (result.value.childSessionId) openChild(result.value.childSessionId)
    } catch (error) {
      setEditor(current => current ? { ...current, busy: false, error: error.message } : current)
    } finally {
      inFlight.current = false
    }
  }
  return h('div', { className: 'me-editor', 'data-message-editor': editor.id },
    h('div', { className: 'me-editor-head' }, h('span', null, t('unsaved')), h('span', null, editor.role === 'user' ? t('you') : t('assistant'))),
    h('textarea', { className: 'me-textarea', value: editor.draft, autoFocus: true, disabled: editor.busy,
      'aria-label': t('edit'), onChange: event => setEditor(current => ({ ...current, draft: event.target.value })),
      onKeyDown: event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Escape' && !editor.busy) { event.preventDefault(); setEditor(undefined) }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save('save') }
      } }),
    h('div', { className: 'me-editor-actions' },
      h('button', { type: 'button', className: 'me-button', 'data-primary': true, disabled: editor.busy || !editor.draft.trim() || (editor.role === 'user' && !canFork),
        onClick: () => save('save') }, editor.busy ? t('saving') : editor.role === 'user' ? t('userSave') : t('save')),
      editor.role === 'assistant' && canFork ? h('button', { type: 'button', className: 'me-button', disabled: editor.busy || !editor.draft.trim(),
        onClick: () => save('fork') }, t('fork')) : null,
      h('button', { type: 'button', className: 'me-button', disabled: editor.busy, onClick: () => setEditor(undefined) }, t('cancel'))),
    h('span', { className: 'me-note' }, editor.role === 'user' ? t('userNote') : t('assistantNote')),
    editor.error ? h('div', { className: 'me-error', role: 'alert' }, editor.error,
      editor.partial ? h('div', null, t('partial'), ' ', editor.partial) : null) : null)
}

function Row(props) {
  const { node, editor, setEditor, t } = props
  const item = identity(node)
  const edit = props.useProjection('messageEditJournal', view => item ? view?.edits?.[item.id] : undefined,
    (a, b) => a?.revision === b?.revision && a?.text === b?.text)
  const [copied, setCopied] = React.useState(false)
  if (!item) {
    if (['turn-process', 'turn-tail', 'system-prompt'].includes(node.kind)) return null
    const data = node.data ?? {}
    if (node.kind === 'assistant-step') return h('article', { className: 'me-row', 'data-role': 'assistant' },
      h('div', { className: 'me-label' }, t('assistant')), h(Markdown, { text: textOf(data.blocks) }))
    const title = data.name ?? data.call?.name ?? (node.kind === 'tool-call' ? t('more') : node.kind.replaceAll('-', ' '))
    if (node.kind === 'command' && ['message-edit', 'message-edit-commit'].includes(data.name)) return null
    return h('details', { className: 'me-tools' }, h('summary', null, title),
      h('pre', { className: 'me-json' }, JSON.stringify(data, null, 2)),
      data.callId && props.inspectCall ? h('button', { type: 'button', className: 'me-button', onClick: () => props.inspectCall(data.callId) }, t('inspect')) : null)
  }
  const text = edit?.text ?? textOf(item.blocks)
  const active = editor?.id === item.id
  const attachments = item.blocks.flatMap(block => {
    const value = block.kind === 'other' ? block.block : block
    if ((value?.type === 'image' || value?.kind === 'image') && value.attachment) {
      return [{ type: 'image', image: { attachment: value.attachment } }]
    }
    if (value?.type === 'file' && value.attachment) return [{ type: 'file', file: value.attachment }]
    return []
  })
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true) }
    catch { setCopied(false) }
  }
  return h('article', { className: 'me-row', 'data-role': item.role, 'data-message-id': item.id },
    h('div', { className: 'me-label' }, item.role === 'user' ? t('you') : t('assistant'), edit ? h('span', { className: 'me-edited' }, t('edited')) : null),
    active ? h(Editor, { ...props, editor }) : h('div', { className: 'me-bubble' },
      h(Markdown, { text }),
      item.blocks.some(block => block.kind === 'reasoning' || block.type === 'reasoning')
        ? h('details', { className: 'me-tools' }, h('summary', null, t('reason')),
          h(Markdown, { text: item.blocks.filter(block => block.kind === 'reasoning' || block.type === 'reasoning').map(block => block.text).join('') })) : null,
      attachments.length ? h('div', { className: 'me-media' }, props.renderFactorySlot('conversation.chat.user.content', {
        content: { text: '', attachments, extraBlocks: [] }, facts: {}, interactive: false, loadImage: props.loadImage,
      })) : null),
    !active ? h('div', { className: 'me-actions' },
      h('button', { type: 'button', className: 'me-button', 'data-icon': true, title: copied ? t('copied') : t('copy'), 'aria-label': copied ? t('copied') : t('copy'), onClick: copy }, icon('copy')),
      props.canEdit && props.available && text ? h('button', { type: 'button', className: 'me-button', 'data-icon': true, title: t('edit'), 'aria-label': t('edit'), disabled: Boolean(editor?.busy),
        onClick: () => setEditor({ ...item, draft: text, revision: edit?.revision ?? item.seq, busy: false }) }, icon('edit')) : null) : null)
}

export function EditableChat(props) {
  const snapshot = props.useChat(value => value)
  const session = props.useSession(value => value)
  const available = props.useProjection('messageEditJournal', view => view !== undefined)
  const canEdit = props.useAccess('commands/execute')
  const canFork = props.useAccess('session/fork')
  const [editor, setEditor] = React.useState(undefined)
  const nodes = snapshot.order.map(key => snapshot.nodes.get(key)).filter(Boolean)
  return h('div', { className: 'me-chat', 'data-message-edit-chat': props.sessionId }, h('style', null, CSS),
    h('div', { className: 'me-column' },
      session.hasMore ? h('div', { className: 'me-top' }, h('button', { type: 'button', className: 'me-button', disabled: session.loadingOlder, onClick: props.loadOlder }, session.loadingOlder ? props.t('loading') : props.t('older'))) : null,
      !nodes.length ? h('div', { className: 'me-empty' }, props.t('empty')) : null,
      nodes.map(node => h(Row, { ...props, key: node.key, node, editor, setEditor, canEdit, canFork, available }))))
}

export const inject = ['slots', 'sessions', 'remote', 'locale', 'uiWorkspace', 'uiConversation']
export function apply(ctx) {
  console.debug('Message editor plugin: client activated')
  ctx.effect(() => ctx.locale.register(NS, { en: strings, zh }))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'chat', priority: -100, order: 0, locale: NS,
    inject: sessionId => ({
      runEdit: async request => {
        const result = await ctx.remote.commands.execute(sessionId, '/message-edit ' + JSON.stringify(request), [])
        if (!result.ok) return { ok: false, error: { code: result.error.code, message: result.error.message } }
        if (!result.value?.result?.text) throw new Error('The message editor is not available in this session.')
        return JSON.parse(result.value.result.text)
      },
      loadOlder: () => { void ctx.sessions.binding(sessionId)?.session.loadOlder() },
      openChild: childId => { ctx.uiWorkspace.openSession(childId) },
      loadImage: Object.assign(attachment => ctx.uiConversation.imageUrl(sessionId, attachment), {
        peek: attachment => ctx.uiConversation.peekImageUrl(sessionId, attachment),
      }),
    }),
  }, EditableChat))
}
