/**
 * Message edit — Client half.
 *
 * Adds "Edit" to past messages using only additive seats and public session
 * APIs. Committed history is never rewritten: saving an edit forks the session
 * at the boundary before the edited prompt and submits the corrected text to
 * the child, then opens it. For an assistant reply the edited text is the
 * prompt that produced it, so saving regenerates that answer in the branch.
 *
 * Seats (all replaceRisk none):
 *   user row        -> conversation.chat.user.before chain trigger
 *   assistant reply -> conversation.chat.assistant-actions list trigger
 *   editor panel    -> conversation.input.overlay (the feedback dialog's seat)
 *
 * v2.0.1: hook-order and module-table fixes.
 */

window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-message-edit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = [
      '.dsh-me-trigger{display:inline-flex;align-items:center;margin:0 0 3px;opacity:.72}',
      '.dsh-me-trigger button,.dsh-me-strip button{font:inherit;font-size:11px;line-height:1.6;padding:0 7px;',
      'border-radius:4px;cursor:pointer;color:var(--dsw-alias-label-secondary,inherit);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
      'background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.10))}',
      '.dsh-me-trigger button:hover,.dsh-me-strip button:hover{color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-me-strip{display:inline-flex;align-items:center}',
      '.dsh-me-panel{display:flex;flex-direction:column;gap:6px;margin:6px 0 2px;padding:10px;',
      'border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
      'background:var(--dsw-alias-bg-base,transparent)}',
      '.dsh-me-head{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.dsh-me-ta{width:100%;box-sizing:border-box;resize:vertical;min-height:4.5em;font:inherit;',
      'line-height:1.45;padding:8px;border-radius:6px;color:inherit;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
      'background:var(--dsw-alias-bg-base,transparent)}',
      '.dsh-me-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
      '.dsh-me-row button{font:inherit;font-size:12px;padding:4px 10px;border-radius:5px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));color:inherit;',
      'background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.10))}',
      '.dsh-me-row button[data-primary]{background:var(--dsw-alias-state-info-primary,#247bbf);',
      'border-color:transparent;color:#fff}',
      '.dsh-me-row button:disabled{opacity:.5;cursor:default}',
      '.dsh-me-note{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.dsh-me-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#c0392b)}',
    ].join('')

    /** Minimal snapshot source with React 18 external-store semantics. */
    function createState(initial) {
      let value = initial
      const subscribers = new Set()
      return {
        getSnapshot: () => value,
        set(next) { value = next; for (const notify of subscribers) notify() },
        subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener) } },
      }
    }

    /** Plain text of user-message content blocks. */
    function textOf(content) {
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          text += block.text
        }
      }
      return text
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        // Own stylesheet tag, removed with the plugin run (the module loader
        // also sweeps `style[data-plugin]` for this id on teardown).
        const styleTag = typeof document === 'undefined' ? undefined : document.createElement('style')
        if (styleTag !== undefined) {
          styleTag.setAttribute('data-plugin', '@dsh-workbench/dsh-message-edit')
          styleTag.textContent = CSS
          document.head.appendChild(styleTag)
        }
        ctx.effect(() => () => { styleTag?.remove() })

        // One open editor per session; triggers write it, the overlay reads it.
        const editorStates = new Map()
        const editorOf = (sessionId) => {
          let state = editorStates.get(sessionId)
          if (state === undefined) {
            state = createState(undefined)
            editorStates.set(sessionId, state)
          }
          return state
        }
        ctx.effect(() => () => { editorStates.clear() })

        const openEditor = (sessionId, editor) => { editorOf(sessionId).set(editor) }
        const closeEditor = (sessionId) => { editorOf(sessionId).set(undefined) }

        /** Fork before the edited prompt, submit the corrected text, open the child. */
        const commit = async (sessionId, editor, update) => {
          update({ busy: true, error: undefined })
          try {
            const childId = await ctx.sessions.fork({ sessionId, atSeq: editor.boundary, increaseTitle: true })
            await ctx.sessions.using(childId, { source: 'controllerOperation' }, async (reference) => {
              const result = await reference.binding.session.prompt([{ type: 'text', text: editor.draft }], 'queue')
              if (result === undefined || result.ok !== true) {
                const message = result !== undefined && result.error !== undefined
                  ? (result.error.message ?? result.error.code)
                  : 'The edited message was not accepted.'
                throw new Error(message)
              }
            })
            editorStates.get(sessionId)?.set(undefined)
            ctx.uiWorkspace.openSession(childId)
          } catch (cause) {
            update({
              busy: false,
              error: cause !== null && typeof cause === 'object' && typeof cause.message === 'string'
                ? cause.message
                : String(cause),
            })
          }
        }

        /** Resolve the durable user node carrying one rpc id, or undefined. */
        const userRowFor = (snapshot, rpcId) => {
          if (rpcId === undefined || snapshot === undefined || snapshot === null) return undefined
          const nodes = snapshot.nodes
          if (nodes === undefined || nodes === null || typeof nodes.values !== 'function') return undefined
          for (const node of nodes.values()) {
            const data = node.data
            if (node.kind === 'user' && data !== undefined && data !== null
              && data.source !== null && typeof data.source === 'object' && data.source.rpcId === rpcId) {
              return node
            }
          }
          return undefined
        }

        // Stable identities so hook call order never depends on which framework
        // seats arrived.
        const noChat = () => undefined
        const denyAccess = () => false

        /** User-row trigger: edit this message into a new branch. */
        function UserEditTrigger(props) {
          const matched = props.matched
          const rpcId = matched === undefined || matched === null || matched.source === null
            || typeof matched.source !== 'object' ? undefined : matched.source.rpcId
          const useAccess = typeof props.useAccess === 'function' ? props.useAccess : denyAccess
          const useChat = typeof props.useChat === 'function' ? props.useChat : noChat
          const canFork = useAccess('session/fork')
          const canPrompt = useAccess('session/prompt')
          const allowed = canFork && canPrompt
          const node = useChat((snapshot) => rpcId === undefined || !allowed
            ? undefined
            : userRowFor(snapshot, rpcId))
          if (node === undefined || typeof node.anchorSeq !== 'number' || node.anchorSeq < 1) return null
          const current = textOf(node.data === undefined || node.data === null ? undefined : node.data.content)
          if (current === '') return null
          return h('div', { className: 'dsh-me-trigger' },
            h('button', {
              type: 'button',
              title: 'Edit this message in a new conversation branch',
              onClick: () => openEditor(props.sessionId, {
                heading: 'Edit your message — continues in a new conversation',
                boundary: node.anchorSeq - 1,
                draft: current,
                busy: false,
                error: undefined,
              }),
            }, 'Edit'),
          )
        }

        /** Assistant-strip trigger: edit the prompt that produced this reply. */
        function AssistantEditTrigger(props) {
          const messageId = props.messageId
          const useAccess = typeof props.useAccess === 'function' ? props.useAccess : denyAccess
          const useChat = typeof props.useChat === 'function' ? props.useChat : noChat
          const canFork = useAccess('session/fork')
          const canPrompt = useAccess('session/prompt')
          const allowed = canFork && canPrompt
          const origin = useChat((snapshot) => {
            if (messageId === undefined || !allowed) return undefined
            if (snapshot === undefined || snapshot === null) return undefined
            const nodes = snapshot.nodes
            if (nodes === undefined || nodes === null || typeof nodes.values !== 'function') return undefined
            let replySeq
            for (const node of nodes.values()) {
              const finalNode = node.data === undefined || node.data === null ? undefined : node.data.finalNode
              if (finalNode !== undefined && finalNode !== null && finalNode.messageId === messageId) {
                replySeq = typeof node.anchorSeq === 'number' ? node.anchorSeq : finalNode.seq
                break
              }
            }
            if (replySeq === undefined) return undefined
            let prompt
            for (const node of nodes.values()) {
              if (node.kind !== 'user' || typeof node.anchorSeq !== 'number') continue
              if (node.anchorSeq >= replySeq) continue
              if (prompt === undefined || node.anchorSeq > prompt.anchorSeq) prompt = node
            }
            if (prompt === undefined || prompt.anchorSeq < 1) return undefined
            return { boundary: prompt.anchorSeq - 1, text: textOf(prompt.data === undefined || prompt.data === null ? undefined : prompt.data.content) }
          })
          if (origin === undefined || origin.text === '') return null
          return h('span', { className: 'dsh-me-strip' },
            h('button', {
              type: 'button',
              title: 'Edit the prompt that produced this reply and regenerate it in a new conversation',
              onClick: () => openEditor(props.sessionId, {
                heading: 'Edit the prompt and regenerate — continues in a new conversation',
                boundary: origin.boundary,
                draft: origin.text,
                busy: false,
                error: undefined,
              }),
            }, 'Edit'),
          )
        }

        /** The session's open editor, rendered above the composer card. */
        function MessageEditOverlay(props) {
          const state = editorOf(props.sessionId)
          const editor = React.useSyncExternalStore(state.subscribe, state.getSnapshot)
          if (editor === undefined) return null
          const update = (patch) => { state.set({ ...state.getSnapshot(), ...patch }) }
          const save = () => {
            if (editor.busy !== true && editor.draft.trim() !== '') void commit(props.sessionId, editor, update)
          }
          return h('div', { className: 'dsh-me-panel' },
            h('div', { className: 'dsh-me-head' }, editor.heading),
            h('textarea', {
              className: 'dsh-me-ta',
              value: editor.draft,
              autoFocus: true,
              'aria-label': editor.heading,
              onChange: (event) => update({ draft: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Escape') { event.preventDefault(); closeEditor(props.sessionId) }
                else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save() }
              },
            }),
            h('div', { className: 'dsh-me-row' },
              h('button', {
                type: 'button',
                'data-primary': true,
                disabled: editor.busy === true || editor.draft.trim() === '',
                onClick: save,
              }, editor.busy === true ? 'Branching…' : 'Save in new conversation'),
              h('button', {
                type: 'button',
                disabled: editor.busy === true,
                onClick: () => closeEditor(props.sessionId),
              }, 'Cancel'),
              h('span', { className: 'dsh-me-note' },
                'This conversation stays unchanged; the edit continues in a new branch.'),
              editor.error === undefined ? null : h('span', { className: 'dsh-me-err' }, editor.error),
            ),
          )
        }

        ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
          name: 'conversation.chat.user.before',
          select: (owner) => owner !== null && owner !== undefined && owner.kind === 'user' ? owner : null,
        }, UserEditTrigger))

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'message-edit-regenerate',
          order: 30,
        }, AssistantEditTrigger))

        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'message-edit-panel',
          order: 30,
        }, MessageEditOverlay))
      },
    }
  },
})
