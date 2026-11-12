/** Queue reservations: live queue and parked edit drafts occupy separate sections. */
import { useMemo, useRef, useState } from 'react'
import { InlineEditor, IconEditOutlineRegular, IconCheckOutlineRegular,
  IconCloseOutlineRegular, IconTrashOutlineRegular, IconSendOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

const NS = 'message-edit-queue'
const en = {
  queued: 'Queued messages', held: 'Editing — held aside', edit: 'Edit queued message',
  save: 'Re-queue message', restore: 'Cancel and restore original', remove: 'Remove queued message',
  steer: 'Send as steering', hint: 'Not in the live queue. Enter saves and re-queues; Shift+Enter adds a line.',
  working: 'Saving…', sending: 'Sending…', error: 'The queue operation failed. Your message is preserved.',
  attachment: 'Attachment',
}
const zh = {
  queued: '排队消息', held: '正在编辑 — 已暂存', edit: '编辑排队消息', save: '重新加入队列',
  restore: '取消并恢复原始消息', remove: '移除排队消息', steer: '作为引导发送',
  hint: '不在实时队列中。Enter 保存并重新排队；Shift+Enter 换行。', working: '保存中…',
  sending: '发送中…', error: '队列操作失败，消息已保留。', attachment: '附件',
}
const style = `
.mqe{font-size:12px;display:flex;flex-direction:column;gap:7px;margin-bottom:8px}.mqe-section{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-base)}.mqe-title{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:5px}.mqe-row{display:flex;gap:7px;align-items:center;min-width:0;padding:3px 0}.mqe-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}.mqe-action{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px;border-radius:5px;display:inline-flex;cursor:pointer}.mqe-action:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}.mqe-action:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary);outline-offset:2px}.mqe-action[disabled]{opacity:.4;cursor:default}.mqe-draft{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px;margin-top:5px}.mqe-draft:first-of-type{border-top:0;padding-top:0}.mqe-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}.mqe-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}.mqe-chips{display:flex;gap:4px;flex-wrap:wrap}.mqe-chip{font-size:11px;padding:2px 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px}.mqe-controls{display:flex;justify-content:flex-end;gap:3px}
`
function textOf(content) { return content.filter(block => block.type === 'text').map(block => block.text).join('') }
function Attachments({ content, t }) {
  const items = content.filter(block => block.type === 'image' || block.type === 'file')
  if (!items.length) return null
  return <span className="mqe-chips">{items.map((block, i) => <span className="mqe-chip" key={i}>
    {block.attachment?.name ?? t('attachment')}
  </span>)}</span>
}
function Action({ title, busy, onClick, children }) {
  return <button type="button" className="mqe-action" aria-label={title} title={title} disabled={busy} onClick={onClick}>{children}</button>
}

export function QueueEditor({ useProjection, useSession, useAccess, reserveQueue, releaseQueue, updateQueue, t }) {
  const inbox = useProjection('inbox', value => value)
  const heldView = useProjection('messageQueueEdits', value => value)
  const pending = useSession(value => value.pendingSubmissions)
  const running = useSession(value => value.running)
  const mutable = useSession(value => value.subagent === null || value.subagent.address.mode === 'continuable')
  const canEdit = useAccess('commands/execute')
  const canUpdate = useAccess('session/updateQueue')
  const [drafts, setDrafts] = useState({})
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const lock = useRef(false)
  const queue = inbox?.['next-turn'] ?? []
  const held = Object.values(heldView?.held ?? {})
  const pendingQueue = useMemo(() => {
    const ids = new Set(queue.map(item => item.source?.rpcId))
    return pending.filter(item => item.placement === 'queued' && !ids.has(item.requestId))
  }, [pending, queue])
  const attempt = async (id, operation) => {
    if (lock.current) return
    lock.current = true
    setBusy(id); setError(null)
    try {
      const result = await operation()
      if (!result.ok) { setError(result.error.message); return false }
      return true
    } catch (cause) { setError(cause?.message ?? t('error')); return false }
    finally { lock.current = false; setBusy(null) }
  }
  const save = async (item, restore = false) => {
    const text = drafts[item.token] ?? textOf(item.message.content)
    if (!restore && !text.trim()) return
    if (await attempt(item.token, () => releaseQueue(item.token, restore ? 'restore' : 'requeue', text))) {
      setDrafts(previous => { const next = { ...previous }; delete next[item.token]; return next })
    }
  }
  if (!queue.length && !held.length && !pendingQueue.length && !error) return null
  return <div className="mqe" data-queue-editor="">
    <style>{style}</style>
    {(queue.length > 0 || pendingQueue.length > 0) && <section className="mqe-section" data-live-queue="">
      <div className="mqe-title">{t('queued')} · {queue.length + pendingQueue.length}</div>
      {queue.map(item => <div className="mqe-row" key={item.id} data-queued-message={item.id}>
        <span className="mqe-preview" title={textOf(item.content)}>{textOf(item.content)}</span>
        <Attachments content={item.content} t={t} />
        {mutable && <span className="mqe-controls">
          <Action title={t('edit')} busy={busy !== null || !canEdit || !heldView || !textOf(item.content).trim()}
            onClick={() => attempt(item.id, async () => {
              const result = await reserveQueue(item.id)
              if (result.ok) setDrafts(previous => ({ ...previous, [result.value.token]: textOf(result.value.message.content) }))
              return result
            })}><IconEditOutlineRegular size={14} /></Action>
          <Action title={t('remove')} busy={busy !== null || !canUpdate} onClick={() => attempt(item.id, () => updateQueue(item.id, { kind: 'remove' }))}>
            <IconTrashOutlineRegular size={14} /></Action>
          <Action title={t('steer')} busy={busy !== null || !canUpdate || !running} onClick={() => attempt(item.id, () => updateQueue(item.id, { kind: 'steer' }))}>
            <IconSendOutlineRegular size={14} /></Action>
        </span>}
      </div>)}
      {pendingQueue.map(item => <div className="mqe-row" key={item.requestId}><span className="mqe-preview">{item.text}</span><span className="mqe-note">{t('sending')}</span></div>)}
    </section>}
    {held.length > 0 && <section className="mqe-section" data-held-queue-drafts="">
      <div className="mqe-title">{t('held')} · {held.length}</div>
      {held.map(item => <div className="mqe-draft" key={item.token} data-held-token={item.token}>
        <InlineEditor value={drafts[item.token] ?? textOf(item.message.content)} label={t('edit')}
          onChange={text => { if (busy === null) setDrafts(previous => ({ ...previous, [item.token]: text })) }}
          onSave={() => { if (busy === null) void save(item) }}
          onCancel={() => { if (busy === null) void save(item, true) }} />
        <Attachments content={item.message.content} t={t} />
        <div className="mqe-row"><span className="mqe-note">{t('hint')}</span><span className="mqe-controls">
          <Action title={t('save')} busy={busy !== null || !(drafts[item.token] ?? textOf(item.message.content)).trim()} onClick={() => save(item)}><IconCheckOutlineRegular size={14} /></Action>
          <Action title={t('restore')} busy={busy !== null} onClick={() => save(item, true)}><IconCloseOutlineRegular size={14} /></Action>
        </span></div>
      </div>)}
    </section>}
    {error && <div className="mqe-error" role="alert">{error}</div>}
  </div>
}

export function registerQueueEditor(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'queue', order: 20, priority: -10, locale: NS,
    inject: sessionId => {
      const command = async request => {
        const result = await ctx.remote.commands.execute(sessionId, '/message-queue ' + JSON.stringify(request), [])
        if (!result.ok) return { ok: false, error: { message: result.error.message } }
        if (!result.value?.result?.text) return { ok: false, error: { message: 'Queue editing is unavailable.' } }
        return JSON.parse(result.value.result.text)
      }
      return {
        reserveQueue: itemId => command({ action: 'hold', itemId }),
        releaseQueue: (token, action, text) => command({ token, action, text }),
        updateQueue: (itemId, action) => ctx.sessions.binding(sessionId).session.updateQueue(itemId, action),
      }
    },
  }, QueueEditor))
}
