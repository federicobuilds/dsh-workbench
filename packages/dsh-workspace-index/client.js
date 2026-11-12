window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-workspace-index',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const css = `.wi-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance)*2);max-width:var(--dsh-composer-card-max-width);margin:0 auto 4px;display:flex;justify-content:flex-end;font:inherit;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.wi-control{position:relative;min-width:0}.wi-pill,.wi-rebuild{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer}.wi-pill{border-radius:999px;padding:3px 10px}.wi-pill:hover,.wi-rebuild:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.wi-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}.wi-dot[data-state=stale]{background:var(--dsw-alias-state-warn-primary)}.wi-dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}.wi-dot[data-state=building]{animation:wi-pulse 1.4s ease-in-out infinite}
.wi-card{position:absolute;right:0;bottom:calc(100% + 6px);z-index:10;box-sizing:border-box;width:min(330px,calc(100vw - 32px));padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 18px #0003}.wi-heading{margin:0 0 12px;font-size:12px;font-weight:650}.wi-list{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 14px;margin:0;font-size:11px;line-height:1.45}.wi-list dt{color:var(--dsw-alias-label-secondary)}.wi-list dd{margin:0;text-align:right;overflow-wrap:anywhere}.wi-progress{margin:10px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px}.wi-error{margin:10px 0 0;color:var(--dsw-alias-state-error-primary);font-size:11px}.wi-rebuild{justify-content:center;width:100%;margin-top:14px;padding:5px 10px;border-radius:7px;color:var(--dsw-alias-label-primary);font-weight:600}.wi-rebuild:disabled{opacity:.55;cursor:wait}.wi-spinner{width:10px;height:10px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:wi-spin .8s linear infinite}.wi-pill:focus-visible,.wi-rebuild:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@keyframes wi-pulse{0%,100%{opacity:.45}50%{opacity:1}}@keyframes wi-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.wi-dot[data-state=building],.wi-spinner{animation:none}}`;
    const idCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', jsonSchema: { type: 'string', minLength: 1 }, create: () => ({ parse(value) { if (typeof value !== 'string' || !value) throw new Error('Invalid session'); return value; } }) };
    const resultCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-workspace-index#Status', jsonSchema: {}, create: () => ({ parse: value => value }) };
    const descriptor = method => ({ id: `@dsh-workbench/dsh-workspace-index#workspaceIndexUi/${method}`, namespace: 'workspaceIndexUi', method, service: 'workspaceIndexUi', invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' }, parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec }], cancellation: { parameter: 'signal' }, result: resultCodec });
    const contribution = { package: '@dsh-workbench/dsh-workspace-index', descriptors: [descriptor('getStatus'), descriptor('rebuild')] };

    function IndexDock({ sessionId, load, rebuild }) {
      const [data, setData] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const anchor = React.useRef(null);
      const toggle = React.useRef(null);
      const methods = React.useRef({ load, rebuild });
      const request = React.useRef(null);
      methods.current = { load, rebuild };

      React.useEffect(() => {
        setData(null); setError(null); setBusy(false); setOpen(false);
        return () => { request.current?.abort(); request.current = null; };
      }, [sessionId]);
      React.useEffect(() => {
        const controller = new AbortController();
        let timer;
        async function refresh() {
          try {
            const result = await methods.current.load(controller.signal);
            if (!controller.signal.aborted) {
              if (!result?.ok) throw new Error('Status unavailable');
              setData(result.value); setError(null);
            }
          } catch { if (!controller.signal.aborted) setError('Index status is unavailable.'); }
          if (!controller.signal.aborted) timer = setTimeout(refresh, open ? 2500 : 30000);
        }
        refresh();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [sessionId, open]);
      React.useEffect(() => {
        if (!open) return;
        const outside = event => { if (!anchor.current?.contains(event.target)) setOpen(false); };
        const escape = event => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
        document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
      }, [open]);

      async function startRebuild() {
        if (request.current || busy || data?.building) return;
        const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
        try {
          const result = await methods.current.rebuild(controller.signal);
          if (!controller.signal.aborted) {
            if (!result?.ok) throw new Error('Rebuild unavailable');
            setData(result.value);
          }
        } catch { if (!controller.signal.aborted) setError('Rebuild failed. Check the embedding server and try again.'); }
        finally { if (request.current === controller) { request.current = null; setBusy(false); } }
      }
      const building = busy || data?.building;
      const state = error || data?.status === 'error' ? 'error' : building ? 'building' : !data?.indexed || data?.stale ? 'stale' : 'ok';
      const updating = data?.indexed && data?.dirty && data?.watching && !data?.fingerprintMismatch;
      const label = state === 'error' ? 'Index · Error' : state === 'building' ? 'Indexing…' : updating ? 'Index · Updating' : state === 'stale' ? (data?.indexed ? 'Index · Stale' : 'Index · Not indexed') : `Index · ${data.fileCount} files`;
      const root = data?.root ?? '';
      const workspace = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root || 'Unavailable';
      const rows = [
        ['Workspace', workspace, root],
        ['Coverage', `${data?.fileCount ?? 0} files · ${data?.chunkCount ?? 0} chunks`],
        ['Embeddings', `${data?.model ?? 'Unavailable'} (${data?.dimensions ?? '—'}d)`],
        ['Provider', data?.provider ?? 'Unavailable'],
        ['Endpoint', data?.baseURL ?? 'Unavailable'],
        ...(data?.baseURL ? [['Data sent', 'Workspace text and search queries']] : []),
        ['Storage & Watcher', `${(data?.storageBackend ?? 'unknown').toUpperCase()} · ${data?.watching ? (data.recursive ? 'Watching' : 'Watching · Node top-level') : 'Idle'}`],
        ...(data?.dirtyPaths?.length ? [['Pending', `${data.dirtyPaths[0]} · ${data.dirtyPaths.length} pending`]] : []),
        ['Last indexed', data?.lastIndexedAt ? new Date(data.lastIndexedAt).toLocaleString() : 'Never'],
      ];
      return h('section', { className: 'wi-dock', 'aria-label': 'Workspace index' },
        h('div', { className: 'wi-control', ref: anchor },
          h('button', { type: 'button', className: 'wi-pill', ref: toggle, 'aria-expanded': open, onClick: () => setOpen(!open) },
            h('span', { className: 'wi-dot', 'data-state': state, 'aria-hidden': true }), label),
          open && h('div', { className: 'wi-card' },
            h('h3', { className: 'wi-heading' }, 'Workspace index'),
            h('dl', { className: 'wi-list' }, ...rows.flatMap(([name, value, title]) => [h('dt', { key: `${name}-label` }, name), h('dd', { key: name, title }, value)])),
            building && data?.progress && h('p', { className: 'wi-progress', role: 'status' }, `${data.progress.processedFiles}/${data.progress.totalFiles} files · ${data.progress.embeddedChunks}/${data.progress.totalChunks} chunks`),
            (error || data?.status === 'error') && h('p', { className: 'wi-error', role: 'alert' }, error ?? `Index error: ${data.reason ?? 'unknown'}`),
            data?.watchError && h('p', { className: 'wi-error', role: 'alert' }, `Watcher error: ${data.watchError}`),
            h('button', { type: 'button', className: 'wi-rebuild', disabled: building || ['external-embeddings-disabled', 'external-embeddings-require-https', 'invalid-embedding-endpoint'].includes(data?.reason), onClick: startRebuild }, building && h('span', { className: 'wi-spinner', 'aria-hidden': true }), building ? 'Indexing…' : 'Rebuild Index'))));
    }
    return {
      inject: ['slots', 'remote'],
      async apply(ctx) {
        await ctx.get('remote').$mount(contribution);
        const style = document.createElement('style'); style.dataset.plugin = '@dsh-workbench/dsh-workspace-index'; style.textContent = css; document.head.appendChild(style);
        ctx.effect(() => () => style.remove());
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'workspace-index', order: 4,
          inject: sessionId => ({ sessionId, load: signal => ctx.get('remote.workspaceIndexUi').getStatus(sessionId, signal), rebuild: signal => ctx.get('remote.workspaceIndexUi').rebuild(sessionId, signal) }),
        }, IndexDock));
      },
    };
  },
});
