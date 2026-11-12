window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-workspace-placement',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const css = `
.dwp-icon{width:16px;height:16px;flex:none}
.dwp-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dwp-menu{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:start;cursor:pointer}
.dwp-action:hover,.dwp-menu:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}
.dwp-action:disabled,.dwp-menu:disabled{opacity:.5;cursor:not-allowed}
.dwp-action:focus-visible,.dwp-menu:focus-visible,.dwp-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dwp-dialog{pointer-events:auto;box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;margin:auto;padding:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit}
.dwp-dialog::backdrop{pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-bg-base) 75%,transparent)}
.dwp-title{font-size:16px;line-height:24px;font-weight:600;margin:0 0 12px}
.dwp-copy{font-size:13px;line-height:20px;margin:0 0 12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dwp-name{display:block;margin-bottom:12px;font-size:14px;line-height:21px;font-weight:600;overflow-wrap:anywhere}
.dwp-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px;flex-wrap:wrap}
.dwp-button{min-height:36px;padding:7px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dwp-button:hover{background:var(--dsw-alias-bg-layer-2)}
.dwp-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dwp-button:disabled{opacity:.5;cursor:wait}
.dwp-error{color:var(--dsw-alias-state-error-primary)}
.dwp-detail{display:block;font-size:11px;line-height:16px}
.dwp-targets{display:grid;gap:5px;max-height:155px;overflow:auto;margin:10px 0;padding:0;list-style:none}
.dwp-target{padding:6px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px}
.dwp-source{display:inline-block;padding:6px;cursor:grab;border:1px solid var(--dsw-alias-border-l2);border-radius:6px}
.dwp-workspace-select{display:block;width:100%;margin:5px 0 10px}
@media(hover:none){.dwp-menu,.dwp-button{min-height:44px}}
`;
    const result = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-workspace-placement#Result', jsonSchema: { type: 'object' }, create: () => ({
      parse(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid result');
        return value;
      },
    }) };
    function payload(response) {
      if (!response || response.ok !== true || !Object.hasOwn(response, 'value')) throw new Error('Workspace reference call failed');
      return response.value;
    }
    return {
      inject: ['slots', 'remote', 'contextMenus', 'workspaces', 'sessions', 'uiWorkspace'],
      async apply(ctx) {
        const workspaceList = ctx.get('workspaces').list;
        const sessionList = ctx.get('sessions').list;
        const uiWorkspace = ctx.get('uiWorkspace');
        const workspaceSnapshot = () => workspaceList.getSnapshot();
        const subscribeWorkspaces = listener => workspaceList.subscribe(listener);
        const sessionSnapshot = () => sessionList.getSnapshot();
        const subscribeSessions = listener => sessionList.subscribe(listener);
        const placementString = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-workspace-placement#PlacementString', jsonSchema: { type: 'string', minLength: 1, pattern: '\\S' }, create: () => ({ parse(value) { if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid argument'); return value; } }) };
        const taskFields = ['taskId', 'originalParentSessionId', 'successorSessionId', 'workerSessionId'];
        const taskCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-workspace-placement#PlacementTask', jsonSchema: { type: 'object', properties: { taskId: placementString.jsonSchema, originalParentSessionId: placementString.jsonSchema, successorSessionId: { anyOf: [placementString.jsonSchema, { type: 'null' }] }, workerSessionId: { anyOf: [placementString.jsonSchema, { type: 'null' }] } }, required: taskFields, additionalProperties: false }, create: () => ({ parse(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || !taskFields.every(key => Object.hasOwn(value, key)) || typeof value.taskId !== 'string' || !value.taskId.trim() || typeof value.originalParentSessionId !== 'string' || !value.originalParentSessionId.trim() || !(value.successorSessionId === null || typeof value.successorSessionId === 'string' && value.successorSessionId.trim()) || !(value.workerSessionId === null || typeof value.workerSessionId === 'string' && value.workerSessionId.trim()) || value.successorSessionId === null && value.workerSessionId === null) throw new Error('Invalid task reference'); return value; } }) };
        const placementDescriptors = Object.entries({ moveSessionReference: ['sessionId', 'workspaceId'], appendTaskReference: ['fields'], detachReference: ['eventId'], listReferences: [] }).map(([method, names]) => ({
          id: `@dsh-workbench/dsh-workspace-placement#chatPlacement/${method}`, namespace: 'chatPlacement', service: 'chatPlacement', method, invocation: { kind: 'direct' },
          parameters: names.map(name => ({ name, wire: name, source: 'json', codec: name === 'fields' ? taskCodec : placementString, strictCodec: name === 'fields' ? taskCodec : placementString })), cancellation: { parameter: 'signal' }, result,
        }));
        let placementRemote;
        try {
          const dispose = await ctx.get('remote').$mount({ package: '@dsh-workbench/dsh-workspace-placement', descriptors: placementDescriptors });
          ctx.effect(() => dispose);
          placementRemote = ctx.get('remote.chatPlacement');
        } catch {}
        let placementState = null;
        let placementControl;
        let placementDisposed = false;
        const placementListeners = new Set();
        const placementStore = { getSnapshot: () => placementState, subscribe(listener) { placementListeners.add(listener); return () => placementListeners.delete(listener); } };
        const setPlacement = next => { if (!placementDisposed) { placementState = next; for (const listener of placementListeners) listener(); } };
        function closePlacement() { placementControl?.abort(); setPlacement(null); }
        async function refreshPlacement() {
          const current = placementState;
          if (!current) return;
          try {
            if (!placementRemote) throw new Error('Placement unavailable');
            const value = payload(await placementRemote.listReferences(placementControl.signal));
            if (!value.ok || !Array.isArray(value.references)) throw new Error('Placement unavailable');
            if (placementState === current) setPlacement({ ...current, references: value.references, error: '', busy: false });
          } catch { if (placementState === current) setPlacement({ ...current, error: 'Unavailable', busy: false }); }
        }
        function openPlacement(sessionId, displayTitle = '', workspaceId = '') {
          if (placementState || placementDisposed) return;
          ctx.get('contextMenus').close();
          placementControl = new AbortController();
          setPlacement({ sessionId, displayTitle, workspaceId, taskId: '', successorSessionId: '', workerSessionId: '', references: [], error: '', busy: true });
          void refreshPlacement();
        }
        async function changePlacement(method, ...args) {
          if (!placementRemote || !placementState || placementState.busy) return;
          const current = { ...placementState, busy: true, error: '' };
          setPlacement(current);
          try {
            const value = payload(await placementRemote[method](...args, placementControl.signal));
            if (placementState !== current) return;
            setPlacement({ ...current, busy: value.ok, error: value.ok ? '' : `Unavailable: ${value.reason || 'unknown'}` });
            if (value.ok) await refreshPlacement();
          } catch { if (placementState === current) setPlacement({ ...current, busy: false, error: 'Unavailable' }); }
        }
        function PlacementMenu(props) {
          return h('button', { type: 'button', className: 'dwp-menu', role: 'menuitem', onClick: () => openPlacement(props.sessionId, props.displayTitle) }, 'Task references');
        }
        function WorkspaceReferencesMenu({ onDismiss }) {
          return h('button', { type: 'button', className: 'dwp-menu', role: 'menuitem', onClick: () => { onDismiss(); openPlacement(null); } }, 'Workspace references');
        }
        function PlacementOverlay() {
          const current = React.useSyncExternalStore(placementStore.subscribe, placementStore.getSnapshot);
          const workspaces = React.useSyncExternalStore(subscribeWorkspaces, workspaceSnapshot).items;
          const sessions = React.useSyncExternalStore(subscribeSessions, sessionSnapshot).byId;
          const dialog = React.useRef(null);
          const close = React.useRef(null);
          const dragging = React.useRef(false);
          const dialogId = React.useId();
          React.useEffect(() => {
            if (!current || !dialog.current) return;
            const element = dialog.current, previous = document.activeElement;
            element.showModal();
            close.current?.focus();
            return () => { if (element.open) element.close(); if (previous?.isConnected) previous.focus(); };
          }, [Boolean(current)]);
          if (!current) return null;
          const source = current.sessionId;
          const label = workspace => workspace.title ? `${workspace.title} · ${workspace.path}` : workspace.path;
          const workspacesById = new Map(workspaces.map(workspace => [workspace.workspaceId, workspace]));
          const targets = workspaces.filter(workspace => !source || !workspace.sessionIds.includes(source));
          const dragType = 'application/x-dsh-workspace-reference';
          const ready = !current.busy && Boolean(placementRemote);
          const workspaceSelect = h('label', null, source ? 'Target workspace' : 'Filter by workspace',
            h('select', { className: 'dwp-workspace-select', value: current.workspaceId, disabled: current.busy,
              onChange: event => setPlacement({ ...placementState, workspaceId: event.target.value }) },
            h('option', { value: '' }, source ? 'Choose a workspace' : 'All workspaces'),
            ...targets.map(workspace => h('option', { key: workspace.workspaceId, value: workspace.workspaceId }, label(workspace)))));
          const addReference = targetId => { void changePlacement('moveSessionReference', source, targetId); };
          const filtered = current.references.filter(ref => source
            ? (ref.kind === 'workspace' ? ref.sessionId === source : [ref.originalParentSessionId, ref.successorSessionId, ref.workerSessionId].includes(source))
            : ref.kind === 'workspace' && (!current.workspaceId || ref.workspaceId === current.workspaceId));
          const showTarget = ref => {
            const workspace = workspacesById.get(ref.workspaceId);
            return workspace ? label(workspace) : ref.target?.path ?? 'Unavailable';
          };
          const input = (label, key) => h('label', null, label, h('input', { value: current[key], disabled: current.busy, onChange: event => setPlacement({ ...placementState, [key]: event.target.value }) }));
          return h('dialog', { ref: dialog, className: 'dwp-dialog', 'aria-labelledby': `${dialogId}-placement`, onCancel: event => { event.preventDefault(); closePlacement(); } },
            h('h2', { id: `${dialogId}-placement`, className: 'dwp-title' }, source ? 'Task references' : 'Workspace references'),
            h('p', { className: 'dwp-copy' }, 'A reference opens the original chat in its own working directory.'),
            current.error ? h('p', { role: 'alert', className: 'dwp-error' }, current.error) : null,
            workspaceSelect,
            source ? h(React.Fragment, null,
            h('button', { type: 'button', className: 'dwp-button', disabled: !ready || !targets.some(workspace => workspace.workspaceId === current.workspaceId),
              onClick: () => addReference(current.workspaceId) }, 'Add workspace reference'),
            h('p', { className: 'dwp-copy' }, 'You can also drag this chat onto a workspace below.'),
            h('span', { className: 'dwp-source', draggable: ready,
              onDragStart: event => {
                if (!ready || !event.dataTransfer) { event.preventDefault(); return; }
                dragging.current = true;
                event.dataTransfer.setData(dragType, source);
                event.dataTransfer.effectAllowed = 'link';
              },
              onDragEnd: () => { dragging.current = false; },
            }, current.displayTitle || source),
            h('ul', { className: 'dwp-targets', 'aria-label': 'Workspace reference drop targets' },
              ...targets.map(workspace => h('li', { key: workspace.workspaceId, className: 'dwp-target',
                onDragOver: event => {
                  if (!dragging.current || !ready || !event.dataTransfer?.types.includes(dragType)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'link';
                },
                onDrop: event => {
                  if (!dragging.current || !ready || event.dataTransfer?.getData(dragType) !== source) return;
                  event.preventDefault();
                  dragging.current = false;
                  addReference(workspace.workspaceId);
                },
              }, label(workspace)))),
            h('h3', null, 'Add task reference'), input('Task ID', 'taskId'), input('Successor session ID', 'successorSessionId'), input('Shared worker session ID', 'workerSessionId'),
            h('button', { type: 'button', className: 'dwp-button', disabled: !ready || !current.taskId.trim() || !(current.successorSessionId.trim() || current.workerSessionId.trim()), onClick: () => { void changePlacement('appendTaskReference', { taskId: current.taskId, originalParentSessionId: source, successorSessionId: current.successorSessionId || null, workerSessionId: current.workerSessionId || null }); } }, 'Add task reference')) : null,
            h('h3', null, 'Current references'),
            !filtered.length && !current.busy ? h('p', { className: 'dwp-copy' }, 'No references in this view.') : null,
            ...filtered.map(ref => h('section', { key: ref.eventId },
              h('p', null, 'Source folder: ', ref.sourceFolder || 'Unavailable'),
              ref.kind === 'workspace' ? h('p', null, 'Target workspace: ', showTarget(ref)) : h('p', null, 'Task: ', ref.taskId, ' | Successor: ', ref.successorSessionId || 'Incomplete', ' | Shared worker: ', ref.workerSessionId || 'Incomplete'),
              ref.unavailable ? h('p', null, 'Unavailable') : null,
              ref.incomplete ? h('p', null, 'This task reference still needs its successor or worker association.') : null,
              ref.kind === 'workspace' && !ref.unavailable ? h('button', { type: 'button', className: 'dwp-button',
                onClick: () => { closePlacement(); uiWorkspace.openSession(ref.sessionId); } }, sessions[ref.sessionId]?.title || ref.sessionId) : null,
              h('button', { type: 'button', className: 'dwp-button', disabled: current.busy || !placementRemote, onClick: () => { void changePlacement('detachReference', ref.eventId); } }, 'Detach reference'))),
            h('div', { className: 'dwp-actions' }, h('button', { ref: close, type: 'button', className: 'dwp-button', onClick: closePlacement }, 'Close')));
        }
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'chat-placement', order: 20 }, PlacementMenu));
        ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({ name: 'sidebar.panellist.actions', id: 'workspace-references', order: 30 }, WorkspaceReferencesMenu));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'chat-placement-dialog', order: 91 }, PlacementOverlay));
        ctx.effect(() => ctx.get('contextMenus').register({
          id: 'workspace.references', target: 'workspace', order: 200,
          resolve: ({ workspaceId }) => [{ id: 'references', label: 'Workspace references', run: () => openPlacement(null, '', workspaceId) }],
        }));
        ctx.effect(() => () => { placementControl?.abort(); placementDisposed = true; placementListeners.clear(); });

      },
    };
  },
});
