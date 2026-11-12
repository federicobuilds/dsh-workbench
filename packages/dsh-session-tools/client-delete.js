window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-session-tools',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const css = `
.dcd-icon{width:16px;height:16px;flex:none}
.dcd-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dcd-menu{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:start;cursor:pointer}
.dcd-action:hover,.dcd-menu:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}
.dcd-action:disabled,.dcd-menu:disabled{opacity:.5;cursor:not-allowed}
.dcd-action:focus-visible,.dcd-menu:focus-visible,.dcd-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dcd-dialog{pointer-events:auto;box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;margin:auto;padding:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit}
.dcd-dialog::backdrop{pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-bg-base) 75%,transparent)}
.dcd-title{font-size:16px;line-height:24px;font-weight:600;margin:0 0 12px}
.dcd-copy{font-size:13px;line-height:20px;margin:0 0 12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dcd-name{display:block;margin-bottom:12px;font-size:14px;line-height:21px;font-weight:600;overflow-wrap:anywhere}
.dcd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px;flex-wrap:wrap}
.dcd-button{min-height:36px;padding:7px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dcd-button:hover{background:var(--dsw-alias-bg-layer-2)}
.dcd-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dcd-button:disabled{opacity:.5;cursor:wait}
.dcd-error{color:var(--dsw-alias-state-error-primary)}
.dcd-detail{display:block;font-size:11px;line-height:16px}
@media(hover:none){.dcd-menu,.dcd-button{min-height:44px}}
`;
    const dicts = {
      en: {
        delete: 'Delete permanently', title: 'Delete this chat?', untitled: 'Untitled chat',
        warning: 'The saved DSH conversation will be permanently deleted. This cannot be undone.',
        copies: 'Shared attachments, exports, backups, and external search indexes are kept.',
        cancel: 'Cancel', close: 'Close', preparing: 'Checking this chat…', deleting: 'Deleting…',
        doneTitle: 'Chat deleted', done: 'The saved conversation has been deleted.',
        partial: 'The conversation was deleted, but some cleanup could not finish.',
        recovery: 'Nothing was deleted, but the original archive or pin state could not be restored.',
        durability: 'Deletion durability could not be confirmed.', workspace: 'Workspace cleanup needs attention.', cache: 'The projection cache could not be cleared.', verification: 'Transcript removal could not be verified.', lock: 'The writer handle did not close cleanly.', restore: 'Restore the archive or pin state manually.',
        live: 'Close this chat before deleting it.', active: 'This chat is still working or held by another process. Stop or close it first.',
        missing: 'This saved chat no longer exists.', format: 'This chat is not in a supported saved format. Nothing was deleted.',
        generations: 'This chat has multiple saved log versions. Nothing was deleted.', changed: 'The chat changed. Close this dialog and try again.',
        confirmation: 'The confirmation expired or was already used. Close this dialog and try again.',
        busy: 'A deletion is already in progress. Please wait.', invalid: 'The chat identifier is invalid.',
        unavailable: 'Deletion is unavailable right now. Try again after reconnecting.', storage: 'Storage refused the deletion. Nothing was deleted.',
      },
      es: {
        delete: 'Eliminar permanentemente', title: '¿Eliminar este chat?', untitled: 'Chat sin título',
        warning: 'La conversación guardada en DSH se eliminará permanentemente. No se puede deshacer.',
        copies: 'Se conservan los archivos adjuntos compartidos, las exportaciones, las copias de seguridad y los índices de búsqueda externos.',
        cancel: 'Cancelar', close: 'Cerrar', preparing: 'Comprobando este chat…', deleting: 'Eliminando…',
        doneTitle: 'Chat eliminado', done: 'Se eliminó la conversación guardada.',
        partial: 'Se eliminó la conversación, pero no se pudo completar toda la limpieza.',
        recovery: 'No se eliminó nada, pero no se pudo restaurar el estado anterior de archivo o fijación.',
        durability: 'No se pudo confirmar la durabilidad de la eliminación.', workspace: 'La limpieza del espacio de trabajo requiere atención.', cache: 'No se pudo limpiar la caché de proyecciones.', verification: 'No se pudo verificar la eliminación de la transcripción.', lock: 'El bloqueo de escritura no se cerró correctamente.', restore: 'Restaura manualmente el estado de archivo o fijación.',
        live: 'Cierra este chat antes de eliminarlo.', active: 'Este chat sigue trabajando o está abierto en otro proceso. Detén o cierra el chat primero.',
        missing: 'Este chat guardado ya no existe.', format: 'El formato guardado de este chat no es compatible. No se eliminó nada.',
        generations: 'Este chat tiene varias versiones guardadas. No se eliminó nada.', changed: 'El chat cambió. Cierra este diálogo e inténtalo de nuevo.',
        confirmation: 'La confirmación venció o ya se usó. Cierra este diálogo e inténtalo de nuevo.',
        busy: 'Ya hay una eliminación en curso. Espera un momento.', invalid: 'El identificador del chat no es válido.',
        unavailable: 'La eliminación no está disponible. Inténtalo de nuevo después de reconectar.', storage: 'El almacenamiento rechazó la eliminación. No se eliminó nada.',
      },
    };
    function Trash() {
      return h('svg', { className: 'dcd-icon', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M2.5 4h11M6 4V2.5h4V4M4 4l.6 9h6.8l.6-9M6.5 6.5v4M9.5 6.5v4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }
    // Every wire name is explicit; these descriptors mirror protocol.mjs.
    const string = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-tools#String', jsonSchema: { type: 'string', minLength: 1 }, create: () => ({ parse(value) { if (typeof value !== 'string' || !value) throw new Error('Invalid argument'); return value; } }) };
    const diagnosticSchema = { type: 'object', properties: Object.fromEntries(['stage', 'name', 'code'].map(key => [key, { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_.-]{0,64}(?![\\s\\S])' }])), required: ['stage', 'name', 'code'], additionalProperties: false };
    const result = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-tools#Result', jsonSchema: { type: 'object', properties: { diagnostic: diagnosticSchema } }, create: () => ({ parse(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid result'); if (value.diagnostic !== undefined) { const diagnostic = value.diagnostic; if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic) || Object.keys(diagnostic).length !== 3 || ['stage', 'name', 'code'].some(key => typeof diagnostic[key] !== 'string' || diagnostic[key].length > 64 || /[^A-Za-z0-9_.-]/.test(diagnostic[key]))) throw new Error('Invalid diagnostic'); } return value; } }) };
    const descriptors = ['prepare', 'commit'].map(method => ({
      id: `@dsh-workbench/dsh-session-tools#chatDelete/${method}`, namespace: 'chatDelete', service: 'chatDelete', method,
      invocation: { kind: 'direct' }, parameters: (method === 'prepare' ? ['sessionId'] : ['sessionId', 'token']).map(name => ({ name, wire: name, source: 'json', codec: string, strictCodec: string })),
      cancellation: { parameter: 'signal' }, result,
    }));
    /** Unwrap DSH's RemoteCallResult before reading the confirmation token or deletion result. */
    function payload(response) {
      if (!response || response.ok !== true || !Object.hasOwn(response, 'value')) throw response?.error ?? new Error('Deletion remote returned an invalid result');
      return response.value;
    }
    return {
      inject: ['slots', 'remote', 'locale', 'contextMenus'],
      async apply(ctx) {
        const locale = ctx.get('locale');
        for (const [language, dict] of Object.entries(dicts)) ctx.effect(() => locale.register('chatDelete', language, dict));
        const translate = locale.bind('chatDelete');
        const subscribeLocale = listener => locale.subscribe(listener);
        const localeSnapshot = () => locale.getSnapshot();
        function useText() { React.useSyncExternalStore(subscribeLocale, localeSnapshot); return translate; }
        const disposeRemote = await ctx.get('remote').$mount({ package: '@dsh-workbench/dsh-session-tools', descriptors });
        ctx.effect(() => disposeRemote);
        const remote = ctx.get('remote.chatDelete');
        if (!remote) throw new Error('Chat deletion remote bridge unavailable');
        let state = null;
        let disposed = false;
        let control;
        const listeners = new Set();
        const store = { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
        const set = value => { if (!disposed) { state = value; for (const listener of listeners) listener(); } };
        function dismiss() { if (state?.phase === 'deleting') return; control?.abort(); set(null); }
        function request(sessionId, title) {
          if (state || disposed) return;
          ctx.get('contextMenus').close();
          control = new AbortController();
          const current = { sessionId, title, phase: 'preparing' };
          set(current);
          remote.prepare(sessionId, control.signal).then(response => {
            const value = payload(response);
            if (state !== current) return;
            set(value.ok ? { ...current, phase: 'ready', token: value.token } : { ...current, phase: 'error', reason: value.reason, diagnostic: value.diagnostic });
          }).catch(() => { if (state === current) set({ ...current, phase: 'error', reason: 'unavailable' }); });
        }
        async function commit() {
          if (state?.phase !== 'ready') return;
          const current = { ...state, phase: 'deleting' };
          set(current);
          try {
            const value = payload(await remote.commit(current.sessionId, current.token, control.signal));
            if (state !== current) return;
            set(value.deleted ? { ...current, phase: 'done', warnings: value.warnings } : { ...current, phase: 'error', reason: value.reason, warnings: value.warnings, diagnostic: value.diagnostic });
          } catch { if (state === current) set({ ...current, phase: 'error', reason: 'unavailable' }); }
        }
        function Action(props) {
          const t = useText();
          const blocked = props.useSessions(snapshot => {
            const row = snapshot.byId[props.sessionId];
            return Boolean(row?.running || Object.values(row?.retainedBy ?? {}).some(count => count > 0));
          });
          return h('button', { type: 'button', className: props.menu ? 'dcd-menu' : 'dcd-action', role: props.menu ? 'menuitem' : undefined,
            disabled: blocked, title: blocked ? t('live') : t('delete'), 'aria-label': t('delete'),
            onClick: () => request(props.sessionId, props.displayTitle),
          }, h(Trash), props.menu ? h('span', null, t('delete')) : null);
        }
        function Overlay() {
          const current = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
          const t = useText();
          const dialog = React.useRef(null);
          const cancel = React.useRef(null);
          const id = React.useId();
          React.useEffect(() => {
            if (!current || !dialog.current) return;
            const element = dialog.current;
            const previous = document.activeElement;
            element.showModal(); // Native dialog provides focus containment and background inertness.
            cancel.current?.focus();
            return () => { if (element.open) element.close(); if (previous?.isConnected) previous.focus(); };
          }, [Boolean(current)]);
          if (!current) return h('style', null, css);
          const deleting = current.phase === 'deleting';
          const done = current.phase === 'done';
          return h(React.Fragment, null, h('style', null, css), h('dialog', {
            ref: dialog, className: 'dcd-dialog', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-copy`,
            onCancel: event => { event.preventDefault(); dismiss(); },
          }, h('h2', { id: `${id}-title`, className: 'dcd-title' }, t(done ? 'doneTitle' : 'title')),
          h('span', { className: 'dcd-name' }, current.title || t('untitled')),
          h('p', { id: `${id}-copy`, className: 'dcd-copy' }, t(done ? 'done' : 'warning')),
          !done ? h('p', { className: 'dcd-copy' }, t('copies')) : null,
          current.phase === 'preparing' || deleting ? h('p', { className: 'dcd-copy', role: 'status' }, t(deleting ? 'deleting' : 'preparing')) : null,
          current.phase === 'error' ? h('p', { className: 'dcd-copy dcd-error', role: 'alert' }, t(current.reason in dicts.en ? current.reason : 'storage'), current.reason === 'storage' && current.diagnostic ? h('small', { className: 'dcd-detail' }, [current.diagnostic.stage, current.diagnostic.name, current.diagnostic.code].join(' / ')) : null) : null,
          current.warnings?.length ? h('p', { className: 'dcd-copy dcd-error', role: 'alert' }, t(done ? 'partial' : 'recovery'), ' ', current.warnings.map(code => t(code in dicts.en ? code : 'unavailable')).join(' ')) : null,
          h('div', { className: 'dcd-actions' },
            h('button', { ref: cancel, type: 'button', className: 'dcd-button', disabled: deleting, onClick: dismiss }, t(done || current.phase === 'error' ? 'close' : 'cancel')),
            current.phase === 'ready' || deleting ? h('button', { type: 'button', className: 'dcd-button dcd-danger', disabled: deleting, onClick: () => { void commit(); } }, t(deleting ? 'deleting' : 'delete')) : null,
          )));
        }
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'chat-delete', order: 110 }, Action));
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'chat-delete', order: 10 }, props => h(Action, { ...props, menu: true })));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'chat-delete-dialog', order: 90 }, Overlay));
        ctx.effect(() => () => { control?.abort(); disposed = true; listeners.clear(); });
      },
    };
  },
});
