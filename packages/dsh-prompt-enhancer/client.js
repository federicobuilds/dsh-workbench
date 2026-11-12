window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-prompt-enhancer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const css = `.pe-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px)*2 - var(--dsh-composer-dock-inset,8px)*4);max-width:calc(var(--dsh-composer-card-max-width,748px) - var(--dsh-composer-dock-inset,8px)*4);margin:0 auto 4px;display:flex;justify-content:flex-end;align-items:center;gap:6px;flex-wrap:wrap;font:inherit;color:var(--dsw-alias-text-primary,var(--dsw-alias-label-primary))}
.pe-control{position:relative;margin-left:auto;animation:pe-enter .18s cubic-bezier(0.22,1,0.36,1) both}.pe-split{display:flex;align-items:stretch;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1)}
.pe-button,.pe-chevron,.pe-cancel,.pe-option{display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;font-weight:600;line-height:18px;padding:3px 10px;cursor:pointer;transition:color .2s cubic-bezier(0.22,1,0.36,1),background .2s cubic-bezier(0.22,1,0.36,1)}
.pe-button{border-radius:999px 0 0 999px}.pe-chevron{border-left:1px solid var(--dsw-alias-border-l1);border-radius:0 999px 999px 0;color:var(--dsw-alias-text-secondary,var(--dsw-alias-label-secondary))}.pe-cancel{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1)}
.pe-button:not(:disabled):hover,.pe-chevron:hover,.pe-cancel:hover,.pe-option:hover{color:var(--dsw-alias-interactive-primary,var(--dsw-alias-brand-primary))}
.pe-button:focus-visible,.pe-chevron:focus-visible,.pe-cancel:focus-visible,.pe-option:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,var(--dsw-alias-brand-primary));outline-offset:2px}
.pe-button:disabled{color:var(--dsw-alias-text-secondary,var(--dsw-alias-label-secondary));opacity:.65;cursor:not-allowed}
.pe-button svg{width:14px;height:14px;flex:none}.pe-busy svg{animation:pe-pulse 1.5s cubic-bezier(0.22,1,0.36,1) infinite}
.pe-cancel{color:var(--dsw-alias-text-secondary,var(--dsw-alias-label-secondary));font-weight:500}
.pe-error{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:18px;padding:3px 10px}
.pe-menu{position:absolute;z-index:10;right:0;bottom:calc(100% + 6px);min-width:160px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 18px #0003}.pe-option{display:flex;width:100%;justify-content:space-between;text-align:left;border-radius:6px;font-weight:500;white-space:nowrap}.pe-option[aria-checked=true]{font-weight:700}
@keyframes pe-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes pe-pulse{0%,100%{opacity:.55;transform:scale(.94)}50%{opacity:1;transform:scale(1.06)}}
@media(prefers-reduced-motion:reduce){.pe-button,.pe-chevron,.pe-cancel,.pe-option{transition:none}.pe-control,.pe-busy svg{animation:none}}`;
    const idCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', jsonSchema: { type: 'string', minLength: 1 }, create: () => ({ parse(value) { if (typeof value !== 'string' || !value) throw new Error('Invalid session'); return value; } }) };
    const textCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-prompt-enhancer#PromptText', jsonSchema: { type: 'string' }, create: () => ({ parse(value) { if (typeof value !== 'string') throw new Error('Invalid text'); return value; } }) };
    const modelCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-prompt-enhancer#EnhanceModel', jsonSchema: { type: 'string' }, create: () => ({ parse(value) { if (value !== undefined && typeof value !== 'string') throw new Error('Invalid model'); return value; } }) };
    const resultCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-prompt-enhancer#EnhanceResult', jsonSchema: { type: 'object', properties: { text: { type: 'string' }, route: { type: 'string' } }, required: ['text', 'route'] }, create: () => ({ parse(value) { if (!value || typeof value.text !== 'string' || typeof value.route !== 'string') throw new Error('Invalid enhancement result'); return value; } }) };
    const models = [
      { id: 'openrouter/deepseek/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' },
      { id: 'openrouter/google/gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { id: 'openrouter/google/gemini-4-argon', label: 'Gemini 4 Argon' },
      { id: 'openrouter/qwen/qwen3.8-2.4t-a95b', label: 'Qwen 3.8' },
      { id: 'openrouter/moonshotai/kimi-k3.1-pro', label: 'Kimi K3.1 Pro' },
      { id: 'openrouter/z-ai/glm-5.2', label: 'GLM 5.2' },
      { id: 'llm-server/Qwen3.8 Flash Next', label: 'Local · Qwen 3.8 Flash' },
    ];
    const storageKey = 'dsh.prompt-enhancer.model.v1';
    const contribution = { package: '@dsh-workbench/dsh-prompt-enhancer', descriptors: [{
      id: '@dsh-workbench/dsh-prompt-enhancer#promptEnhancer/enhance', namespace: 'promptEnhancer', method: 'enhance', service: 'promptEnhancer',
      invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
      parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec },
        { name: 'text', wire: 'text', source: 'json', codec: textCodec, strictCodec: textCodec },
        { name: 'model', wire: 'model', source: 'json', codec: modelCodec, strictCodec: modelCodec, optional: true }],
      cancellation: { parameter: 'signal' }, result: resultCodec,
    }] };
    const rich = editor => editor.querySelector('[data-composer-quote], [data-composer-chip], [data-composer-command], [data-composer-text-ref]');
    function scopedEditor(anchor) {
      if (!anchor?.isConnected) return null;
      const dock = anchor.closest('[data-composer-dock]');
      const seat = anchor.closest('[data-composer-seat]');
      const parent = dock?.parentElement ?? seat ?? anchor.parentElement;
      if (!parent?.isConnected) return null;
      const editors = [...parent.querySelectorAll('[data-composer-input][role="textbox"]')].filter(editor => editor.isConnected);
      if (editors.length !== 1) return null;
      if (seat && (!seat.isConnected || (typeof seat.contains === 'function' && !seat.contains(editors[0])))) return null;
      return { dock: dock ?? seat ?? parent, parent, seat, editor: editors[0] };
    }

    function EnhanceDock({ sessionId, session, useSession, input: propInput, useInput, inputActions, enhance }) {
      const [enhancing, setEnhancing] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [resolvedRoute, setResolvedRoute] = React.useState(null);
      const [inspection, setInspection] = React.useState('unknown');
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [model, setModel] = React.useState(() => {
        try { return models.find(option => option.id === window.localStorage?.getItem(storageKey))?.id ?? models[0].id; }
        catch { return models[0].id; }
      });
      const anchor = React.useRef(null);
      const toggle = React.useRef(null);
      const selectedOption = React.useRef(null);
      const request = React.useRef(null);
      const live = React.useRef(null);
      const hookedSession = (typeof useSession === 'function' ? useSession : () => undefined)(value => value);
      const activeSession = session ?? hookedSession;
      const ownerSessionId = activeSession?.sessionId ?? sessionId;
      const hookedInput = (typeof useInput === 'function' ? useInput : () => undefined)(value => {
        if (live.current?.sessionId === sessionId) live.current.input = value;
        return value;
      });
      const input = hookedInput ?? propInput;
      if (live.current?.sessionId === sessionId && input !== undefined) live.current.input = input;
      live.current = { sessionId, ownerSessionId, input, inputActions };
      const visible = Boolean(input?.draft?.trim()) || enhancing || Boolean(error);

      React.useEffect(() => {
        const inspect = () => {
          const scope = scopedEditor(anchor.current);
          setInspection(!scope ? 'unknown' : rich(scope.editor) ? 'rich' : 'ready');
        };
        inspect();
        const scope = scopedEditor(anchor.current);
        if (!scope || typeof MutationObserver === 'undefined') return;
        const observer = new MutationObserver(inspect);
        observer.observe(scope.parent, { childList: true, subtree: true, attributes: true });
        return () => observer.disconnect();
      }, [sessionId, visible]);
      React.useEffect(() => () => { request.current?.controller.abort(); request.current = null; }, []);
      React.useEffect(() => {
        const current = request.current;
        if (current && (current.sessionId !== sessionId || current.ownerSessionId !== ownerSessionId || current.inputActions !== inputActions)) {
          current.controller.abort(); request.current = null; setEnhancing(false);
          setError('The editor changed. Review the draft and retry.');
        }
      }, [sessionId, ownerSessionId, inputActions]);
      React.useEffect(() => {
        if (!visible) setMenuOpen(false);
      }, [visible]);
      React.useEffect(() => {
        if (!menuOpen || !visible) return;
        const outside = event => { if (!anchor.current?.contains(event.target)) setMenuOpen(false); };
        const escape = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); toggle.current?.focus(); }
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape);
        selectedOption.current?.focus();
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
      }, [menuOpen, visible]);

      const valid = typeof input?.draft === 'string' && Number.isSafeInteger(input.draftRev) && Array.isArray(input.attachmentIds) && Array.isArray(input.occurrences) &&
        typeof inputActions?.insertText === 'function' && typeof enhance === 'function' && typeof sessionId === 'string' && sessionId.length > 0 && ownerSessionId === sessionId;
      const reason = !valid ? 'Editor is not ready.' : !input.draft.trim() ? 'Enter a prompt to enhance.' :
        input.occurrences.length || inspection === 'rich' ? 'Remove embedded references or quotes before enhancing.' :
          inspection !== 'ready' ? 'Editor is not ready.' : '';

      const changePrompt = async event => {
        if (request.current) return;
        const button = event.currentTarget;
        const scope = scopedEditor(button);
        const current = live.current, state = current?.input;
        if (!scope || !current || current.ownerSessionId !== sessionId || (typeof useInput !== 'function' && !propInput) ||
          typeof current.inputActions?.insertText !== 'function' || typeof state?.draft !== 'string' || !state.draft.trim() ||
          !Number.isSafeInteger(state.draftRev) || !Array.isArray(state.attachmentIds) || !Array.isArray(state.occurrences) ||
          state.occurrences.length || rich(scope.editor)) return;
        const captured = { sessionId, ownerSessionId: current.ownerSessionId, inputActions: current.inputActions,
          draft: state.draft, draftRev: state.draftRev, attachmentIds: [...state.attachmentIds], scope };
        const controller = new AbortController();
        request.current = { ...captured, controller };
        setEnhancing(true); setError(null); setResolvedRoute(null);
        try {
          const result = await enhance(captured.draft, model, controller.signal);
          if (controller.signal.aborted || request.current?.controller !== controller) return;
          if (!result?.ok || typeof result.value?.text !== 'string' || !result.value.text.trim() || typeof result.value.route !== 'string' || !result.value.route) throw new Error('request');
          const latest = live.current, next = latest?.input, now = scopedEditor(button);
          if (!now || now.dock !== scope.dock || now.parent !== scope.parent || now.seat !== scope.seat || now.editor !== scope.editor || rich(now.editor) ||
            latest.sessionId !== captured.sessionId || latest.ownerSessionId !== captured.ownerSessionId || latest.inputActions !== captured.inputActions ||
            next?.draft !== captured.draft || next?.draftRev !== captured.draftRev || !Array.isArray(next?.occurrences) || next.occurrences.length ||
            !Array.isArray(next.attachmentIds) || next.attachmentIds.length !== captured.attachmentIds.length ||
            next.attachmentIds.some((id, index) => id !== captured.attachmentIds[index])) {
            setError('The editor changed. Review the draft and retry.'); return;
          }
          if (captured.inputActions.insertText(result.value.text, { start: 0, end: captured.draft.length, draftRev: captured.draftRev }) !== true) {
            setError('The edit could not be applied. Review the draft and retry.');
          } else setResolvedRoute(result.value.route);
        } catch {
          if (!controller.signal.aborted) setError('Enhancement failed. Check the model settings and retry.');
        } finally {
          if (request.current?.controller === controller) { request.current = null; setEnhancing(false); }
        }
      };
      const cancel = () => { request.current?.controller.abort(); request.current = null; setEnhancing(false); setError(null); };
      if (!visible) return null;
      return h('section', { className: 'pe-dock', ref: anchor, 'aria-label': 'Prompt enhancement' },
        h('div', { className: 'pe-control' },
          h('div', { className: 'pe-split' },
        h('span', { title: reason || `Send the draft to ${model.split('/')[0]} for enhancement` },
          h('button', { type: 'button', className: enhancing ? 'pe-button pe-busy' : 'pe-button', 'aria-label': 'Enhance Prompt',
            disabled: enhancing || Boolean(reason), title: reason || `Send the draft to ${model.split('/')[0]} for enhancement`, onClick: changePrompt },
          h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('path', { d: 'M5 19 16 8M14 6l2-3 1 3 3 1-3 1-1 3-1-3-3-1 2-1ZM5 8l1-2 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z' })),
          enhancing ? 'Enhancing…' : model.startsWith('openrouter/') ? 'Enhance via OpenRouter' : 'Enhance via LLM server')),
          h('button', { type: 'button', className: 'pe-chevron', ref: toggle, 'aria-label': 'Choose enhancement model', 'aria-haspopup': 'menu',
            'aria-expanded': menuOpen, title: models.find(option => option.id === model).label, onClick: () => setMenuOpen(!menuOpen) }, '▾')),
          menuOpen && h('div', { className: 'pe-menu', role: 'menu', 'aria-label': 'Enhancement model', onKeyDown: event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const options = [...event.currentTarget.querySelectorAll('[role="menuitemradio"]')];
            const index = options.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
              (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            event.preventDefault(); options[next].focus();
          } },
            ...models.map(option => h('button', { type: 'button', className: 'pe-option', key: option.id, role: 'menuitemradio',
              ref: model === option.id ? selectedOption : undefined, 'aria-checked': model === option.id, onClick: () => {
                setModel(option.id); setMenuOpen(false);
                toggle.current?.focus();
                try { window.localStorage?.setItem(storageKey, option.id); } catch {}
              } }, option.label, model === option.id ? '✓' : '')))),
        enhancing && h('button', { type: 'button', className: 'pe-cancel', 'aria-label': 'Cancel enhancement', onClick: cancel }, 'Cancel'),
        resolvedRoute && h('span', { role: 'status', 'aria-label': 'Enhancement model used', style: { fontSize: '11px', color: 'var(--dsw-alias-text-secondary,var(--dsw-alias-label-secondary))' } }, resolvedRoute),
        error && h('span', { className: 'pe-error', role: 'alert' }, error));
    }
    return {
      inject: ['slots', 'remote'],
      async apply(ctx) {
        await ctx.get('remote').$mount(contribution);
        const style = document.createElement('style'); style.dataset.plugin = '@dsh-workbench/dsh-prompt-enhancer'; style.textContent = css; document.head.appendChild(style);
        ctx.effect(() => () => style.remove());
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'prompt-enhancer', order: 30,
          inject: sessionId => ({ sessionId, enhance: (text, model, signal) => ctx.get('remote.promptEnhancer').enhance(sessionId, text, model, signal) }),
        }, EnhanceDock));
      },
    };
  },
});
