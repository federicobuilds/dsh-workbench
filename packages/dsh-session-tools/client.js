window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-session-tools',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const css = `
.sd-menu-item{display:flex;align-items:center;gap:8px;width:100%;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer}
.sd-menu-item svg{width:15px;height:15px;flex:none;color:var(--dsw-alias-label-secondary)}
.sd-menu-item:hover,.sd-menu-item:hover svg{color:var(--dsw-alias-state-error-primary)}
.sd-row-action{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sd-row-action svg{width:15px;height:15px}
@media (hover:hover){.sd-row-action:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-state-error-primary)}}
.sd-row-action:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}
.sd-droptarget{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover,transparent)}
.sd-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.sd-card{box-sizing:border-box;min-width:320px;max-width:440px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary)}
.sd-card h2{margin:0 0 8px;font-size:14px;font-weight:600;line-height:20px}
.sd-card p{margin:0 0 14px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.sd-card .sd-session-name{font-weight:600;color:var(--dsw-alias-label-primary)}
.sd-actions{display:flex;justify-content:flex-end;gap:8px}
.sd-btn{font:inherit;font-size:13px;line-height:18px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.sd-btn:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.sd-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.sd-btn-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}
.sd-btn-danger:hover{background:var(--dsw-alias-state-error-primary);filter:brightness(1.08)}
.sd-btn:disabled{opacity:.6;cursor:default}
.sd-error{margin:0 0 12px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary)}
.sd-toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:1001;max-width:70vw;padding:8px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;box-shadow:0 8px 22px rgba(0,0,0,.22)}
.sd-toast-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
@media (prefers-reduced-motion:no-preference){.sd-card,.sd-toast{animation:sd-enter .16s ease-out both}}
@keyframes sd-enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.sd-toast{animation-name:sd-toast-enter}
@keyframes sd-toast-enter{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
`;

    function TrashIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M2.5 4h11M6.5 4V2.75A.75.75 0 0 1 7.25 2h1.5a.75.75 0 0 1 .75.75V4m2.75 0-.55 8.25a1.5 1.5 0 0 1-1.5 1.4H6.05a1.5 1.5 0 0 1-1.5-1.4L4 4m2.5 3v4m3-4v4',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    /* ---- module-level overlay store: one confirm dialog or one toast ---- */
    let overlay = null;
    const listeners = new Set();
    const overlayStore = {
      getSnapshot: () => overlay,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    function setOverlay(next) { overlay = next; for (const fn of listeners) fn(); }
    let toastTimer = null;
    function toast(text, tone) {
      if (toastTimer !== null) clearTimeout(toastTimer);
      setOverlay({ kind: 'toast', text, tone: tone ?? 'info' });
      toastTimer = setTimeout(() => { if (overlay?.kind === 'toast') setOverlay(null); }, 4200);
    }

    function messageOf(error) {
      const text = error?.details?.message ?? error?.message ?? String(error);
      return text === '' ? 'Something went wrong.' : text;
    }

    /* ---- overlay host: confirm dialog + toast, frame-wide layer ---- */
    function OverlayHost(props) {
      const [state, setState] = React.useState(overlayStore.getSnapshot());
      React.useEffect(() => overlayStore.subscribe(() => setState(overlayStore.getSnapshot())), []);
      const entry = props?.entry;
      const t = props?.t ?? ((key) => key);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      React.useEffect(() => { setBusy(false); setError(null); }, [state?.kind === 'confirm' ? state.sessionId : null]);

      React.useEffect(() => {
        if (state?.kind !== 'confirm') return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) setOverlay(null);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [state?.kind, busy]);

      const confirmDelete = async () => {
        if (busy || state?.kind !== 'confirm' || entry === undefined) return;
        setBusy(true); setError(null);
        try {
          await entry.deleteSession(state.sessionId);
          setOverlay(null);
        } catch (err) {
          setBusy(false); setError(messageOf(err));
        }
      };

      return h(React.Fragment, null,
        h('style', null, css),
        state?.kind === 'confirm' ? h('div', {
          className: 'sd-backdrop',
          role: 'presentation',
          onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) setOverlay(null); },
        }, h('div', { className: 'sd-card', role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'sd-confirm-title' },
          h('h2', { id: 'sd-confirm-title' }, t('confirmTitle')),
          h('p', null, t('confirmLead'), ' ',
            h('span', { className: 'sd-session-name' }, state.title || t('untitled')), '.',
            ' ', t('confirmBody')),
          error !== null ? h('p', { className: 'sd-error', role: 'alert' }, error) : null,
          h('div', { className: 'sd-actions' },
            h('button', { type: 'button', className: 'sd-btn', autoFocus: true, disabled: busy, onClick: () => setOverlay(null) }, t('cancel')),
            h('button', { type: 'button', className: 'sd-btn sd-btn-danger', disabled: busy, onClick: () => { void confirmDelete(); } },
              busy ? t('deleting') : t('delete')),
          ),
        )) : null,
        state?.kind === 'toast' ? h('div', {
          className: state.tone === 'error' ? 'sd-toast sd-toast-error' : 'sd-toast', role: 'status',
        }, state.text) : null,
      );
    }

    /* ---- sidebar entries ---- */
    function DeleteRowAction(props) {
      const t = props?.t ?? ((key) => key);
      const requestDelete = props?.requestDelete;
      return h('button', {
        type: 'button',
        className: 'sd-row-action',
        title: t('delete'),
        'aria-label': t('delete'),
        onClick: () => requestDelete?.(props?.sessionId, props?.displayTitle),
      }, TrashIcon());
    }

    function DeleteMenuItem(props) {
      const t = props?.t ?? ((key) => key);
      const requestDelete = props?.requestDelete;
      return h('span', {
        className: 'sd-menu-item',
        onClick: () => {
          // Best-effort dismiss of the shared menu before the dialog opens.
          const menuState = props?.hooks?.menuOpenState;
          menuState?.close?.();
          menuState?.setOpen?.(false);
          requestDelete?.(props?.sessionId, props?.displayTitle);
        },
      }, TrashIcon(), h('span', null, props?.label ?? t('delete')));
    }

    /* ---- remote contribution (mirrors remote.mjs) ---- */
    const sessionIdCodec = {
      mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      jsonSchema: { type: 'string', minLength: 1 },
      create: () => ({ parse(value) { if (typeof value !== 'string' || !value) throw new Error('Invalid session'); return value; } }),
    };
    const workspaceIdCodec = {
      mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-tools#WorkspaceId',
      jsonSchema: { type: 'string', minLength: 1 },
      create: () => ({ parse(value) { if (typeof value !== 'string' || !value) throw new Error('Invalid workspace'); return value; } }),
    };
    const deleteResultCodec = {
      mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-tools#DeleteResult',
      jsonSchema: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'], additionalProperties: false },
      create: () => ({ parse(value) { if (typeof value?.deleted !== 'boolean') throw new Error('Invalid delete result'); return value; } }),
    };
    const moveResultCodec = {
      mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-tools#MoveResult',
      jsonSchema: { type: 'object', properties: { moved: { type: 'boolean' } }, required: ['moved'], additionalProperties: false },
      create: () => ({ parse(value) { if (typeof value?.moved !== 'boolean') throw new Error('Invalid move result'); return value; } }),
    };
    const contribution = {
      package: '@dsh-workbench/dsh-session-tools',
      descriptors: [
        {
          id: '@dsh-workbench/dsh-session-tools#sessionTools/deleteSession', namespace: 'sessionTools', method: 'deleteSession', service: 'sessionTools',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'sessionId', wire: 'agentId', source: 'json', codec: sessionIdCodec, strictCodec: sessionIdCodec }],
          cancellation: { parameter: 'signal' }, result: deleteResultCodec,
        },
        {
          id: '@dsh-workbench/dsh-session-tools#sessionTools/moveSession', namespace: 'sessionTools', method: 'moveSession', service: 'sessionTools',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'sessionId', wire: 'agentId', source: 'json', codec: sessionIdCodec, strictCodec: sessionIdCodec },
            { name: 'workspaceId', source: 'json', codec: workspaceIdCodec, strictCodec: workspaceIdCodec },
          ],
          cancellation: { parameter: 'signal' }, result: moveResultCodec,
        },
      ],
    };

    const DICTS = {
      en: {
        delete: 'Delete',
        untitled: 'Untitled chat',
        confirmTitle: 'Delete this chat?',
        confirmLead: 'This permanently deletes',
        confirmBody: 'Its transcript is erased from this machine and cannot be restored.',
        cancel: 'Cancel',
        deleting: 'Deleting…',
        moveFailedPrefix: 'Move failed: ',
        movedToast: 'Chat moved to',
      },
      es: {
        delete: 'Eliminar',
        untitled: 'Chat sin título',
        confirmTitle: '¿Eliminar este chat?',
        confirmLead: 'Esto elimina permanentemente',
        confirmBody: 'Su transcripción se borra de este equipo y no se puede restaurar.',
        cancel: 'Cancelar',
        deleting: 'Eliminando…',
        moveFailedPrefix: 'Error al mover: ',
        movedToast: 'Chat movido a',
      },
    };

    const SESSION_ROW_PREFIX = 'session:';
    const WORKSPACE_ROW_PREFIX = 'workspace:';

    return {
      inject: ['slots', 'remote', 'locale'],
      async apply(ctx) {
        const locale = ctx.get('locale');
        for (const [language, dict] of Object.entries(DICTS)) {
          locale.register('sessionTools', language, dict);
        }
        const t = locale.bind('sessionTools');

        let remoteReady;
        const remoteReadyPromise = ctx.get('remote').$mount(contribution).then(() => {
          remoteReady = ctx.get('remote.sessionTools');
        });

        const requestDelete = (sessionId, displayTitle) => {
          if (typeof sessionId !== 'string' || sessionId === '') return;
          setOverlay({ kind: 'confirm', sessionId, title: displayTitle ?? '' });
        };

        const entry = {
          t,
          requestDelete,
          deleteSession: async (sessionId) => {
            await remoteReadyPromise;
            if (remoteReady === undefined) throw new Error('Remote bridge is not ready yet.');
            return remoteReady.deleteSession(sessionId);
          },
          moveSession: async (sessionId, workspaceId) => {
            await remoteReadyPromise;
            if (remoteReady === undefined) throw new Error('Remote bridge is not ready yet.');
            return remoteReady.moveSession(sessionId, workspaceId);
          },
        };

        function bound(Component) {
          return function SessionToolsEntry(props) {
            return h(Component, { ...props, t, requestDelete });
          };
        }

        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action', id: 'session-tools.delete', order: 110,
          label: () => t('delete'),
        }, bound(DeleteRowAction)));

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item', id: 'session-tools.delete', order: 10,
          label: () => t('delete'),
        }, bound(DeleteMenuItem)));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'session-tools.overlay', order: 90,
        }, function OverlayEntry() {
          return h(OverlayHost, { entry, t });
        }));

        /* ---- drag a session row onto a workspace header to move it ---- */
        ctx.effect(() => {
          let dragged = null;
          let marked = null;

          const sessionRowOf = (target) => target?.closest?.(`[data-row-key^="${SESSION_ROW_PREFIX}"]`) ?? null;
          const workspaceRowOf = (target) => target?.closest?.(`[data-row-key^="${WORKSPACE_ROW_PREFIX}"]`) ?? null;
          const workspaceKeyOf = (row) => row.getAttribute('data-row-key').slice(WORKSPACE_ROW_PREFIX.length);

          const sourceWorkspaceKeyOf = (row) => {
            let node = row.parentElement;
            while (node != null) {
              const header = node.querySelector?.(':scope > [data-row-key^="workspace:"]');
              if (header != null) return workspaceKeyOf(header);
              node = node.parentElement;
            }
            return undefined;
          };

          const unmark = () => {
            if (marked != null) { marked.classList.remove('sd-droptarget'); marked = null; }
          };

          const onDragStart = (event) => {
            const row = sessionRowOf(event.target);
            if (row == null) { dragged = null; return; }
            dragged = {
              sessionId: row.getAttribute('data-row-key').slice(SESSION_ROW_PREFIX.length),
              sourceKey: sourceWorkspaceKeyOf(row),
            };
          };

          const onDragOver = (event) => {
            if (dragged == null) return;
            const row = workspaceRowOf(event.target);
            if (row == null) { unmark(); return; }
            const key = workspaceKeyOf(row);
            if (key === '' || key === dragged.sourceKey) { unmark(); return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (marked !== row) { unmark(); row.classList.add('sd-droptarget'); marked = row; }
          };

          const onDrop = (event) => {
            const current = dragged;
            if (current == null) return;
            const row = workspaceRowOf(event.target);
            if (row == null) return;
            const key = workspaceKeyOf(row);
            if (key === '' || key === current.sourceKey) return;
            const payload = event.dataTransfer.getData('text/plain');
            if (payload !== current.sessionId) return; // a workspace drag or foreign payload
            event.preventDefault();
            event.stopPropagation();
            unmark();
            dragged = null;
            void (async () => {
              try {
                await entry.moveSession(current.sessionId, key);
                const title = row.textContent?.trim();
                toast(`${t('movedToast')} ${title || key}`);
              } catch (error) {
                toast(`${t('moveFailedPrefix')}${messageOf(error)}`, 'error');
              }
            })();
          };

          const onDragEnd = () => { dragged = null; unmark(); };

          document.addEventListener('dragstart', onDragStart, true);
          document.addEventListener('dragover', onDragOver, true);
          document.addEventListener('drop', onDrop, true);
          document.addEventListener('dragend', onDragEnd, true);
          return () => {
            unmark();
            document.removeEventListener('dragstart', onDragStart, true);
            document.removeEventListener('dragover', onDragOver, true);
            document.removeEventListener('drop', onDrop, true);
            document.removeEventListener('dragend', onDragEnd, true);
          };
        });
      },
    };
  },
});
