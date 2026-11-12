window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-session-controls',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const css = `
.kh-dock{font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:8px auto;box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance)*2);max-width:var(--dsh-composer-card-max-width)}
.kh-bar{box-sizing:border-box;display:flex;align-items:center;gap:9px;width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;border-radius:10px;padding:8px 12px;cursor:pointer;font:inherit;text-align:left;transition:border-color .2s cubic-bezier(0.22, 1, 0.36, 1)}
.kh-bar:hover{border-color:var(--dsw-alias-label-secondary)}
.kh-mark{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 8px var(--dsw-alias-state-success-primary);flex-shrink:0}.kh-mark[data-error=true]{background:var(--dsw-alias-state-error-primary)}
.kh-pill{font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.kh-pill[data-alert=true]{color:var(--dsw-alias-state-warn-primary)}.kh-pill[data-corrupt=true]{color:var(--dsw-alias-state-error-primary)}
.kh-panel{margin-top:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);transform-origin:top;animation:kh-expand .18s ease-out}
@keyframes kh-expand{from{opacity:0;transform:scaleY(.96)}to{opacity:1;transform:scaleY(1)}}
.kh-head{padding:12px 16px;display:flex;align-items:center}.kh-heading{font-size:13px;font-weight:650;margin:0}
.kh-btn{font:inherit;font-size:11px;color:inherit;background:inherit;border:1px solid var(--dsw-alias-border-l1);padding:5px 10px;border-radius:6px;cursor:pointer;margin-left:auto;transition:border-color .2s cubic-bezier(0.22, 1, 0.36, 1)}.kh-btn:disabled{opacity:.4;cursor:wait}
.kh-context{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 16px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}.kh-label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);margin-bottom:4px}.kh-mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px}
.kh-tools{display:flex;align-items:center;gap:8px;padding:10px 16px}.kh-tools strong{font-size:12px}.kh-filter{font:inherit;font-size:11px;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:4px 10px;margin-left:auto;width:100%}
.kh-events{max-height:320px;overflow:auto;padding:0 16px 8px}.kh-event{padding:10px 0 10px 14px;border-left:2px solid var(--dsw-alias-border-l1);position:relative;margin-left:3px}.kh-event:before{content:'';position:absolute;left:-4px;top:14px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}.kh-event[data-block=true]:before{background:var(--dsw-alias-state-warn-primary)}.kh-event-head{display:flex;align-items:center;gap:8px;font-size:11px;line-height:1.5;font-weight:600}.kh-time{margin-left:auto;font-size:10px;font-weight:400;color:var(--dsw-alias-label-secondary)}.kh-reason{font-size:12px;line-height:1.5;margin:3px 0}.kh-details{font-size:10px;color:var(--dsw-alias-label-secondary);line-height:1.7;overflow-wrap:anywhere}
.kh-empty{padding:18px 0 22px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}.kh-error{margin:0 16px 12px;padding:10px;border-left:2px solid var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.kh-bar:focus-visible,.kh-btn:focus-visible,.kh-filter:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:3px}@media(max-width:520px){.kh-context{grid-template-columns:1fr}}
`;
    const inputCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', jsonSchema: { type: 'string', minLength: 1 }, create: () => ({ parse(value) { if (typeof value !== 'string' || !value) throw new Error('Invalid session'); return value; } }) };
    const trackCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#Track', jsonSchema: { type: 'string', enum: ['off','free','simple','advanced'] }, create: () => ({ parse: value => { if (!['off','free','simple','advanced'].includes(value)) throw new Error('Invalid track'); return value; } }) };
    const revisionCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#TrackRevision', jsonSchema: { type: 'integer', minimum: 0 }, create: () => ({ parse: value => { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid revision'); return value; } }) };
    const roleCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#RoleId', jsonSchema: { type: 'string', minLength: 1, maxLength: 120 }, create: () => ({ parse: value => { if (typeof value !== 'string' || !value || value.length > 120) throw new Error('Invalid role'); return value; } }) };
    const resultCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#Status', jsonSchema: {}, create: () => ({ parse: value => value }) };
    const contribution = { package: '@dsh-workbench/dsh-session-controls', descriptors: [
      { id: '@dsh-workbench/dsh-session-controls#dshSessionControlsUi/status', namespace: 'dshSessionControlsUi', method: 'status', service: 'dshSessionControlsUi', invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' }, parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: inputCodec, strictCodec: inputCodec }], cancellation: { parameter: 'signal' }, result: resultCodec },
      { id: '@dsh-workbench/dsh-session-controls#dshSessionControlsUi/setTrack', namespace: 'dshSessionControlsUi', method: 'setTrack', service: 'dshSessionControlsUi', invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' }, parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: inputCodec, strictCodec: inputCodec }, { name: 'mode', wire: 'mode', source: 'json', codec: trackCodec }, { name: 'expectedRevision', wire: 'expectedRevision', source: 'json', codec: revisionCodec }], cancellation: { parameter: 'signal' }, result: resultCodec },
      { id: '@dsh-workbench/dsh-session-controls#dshSessionControlsUi/setRole', namespace: 'dshSessionControlsUi', method: 'setRole', service: 'dshSessionControlsUi', invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' }, parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: inputCodec, strictCodec: inputCodec }, { name: 'roleId', wire: 'roleId', source: 'json', codec: roleCodec }], cancellation: { parameter: 'signal' }, result: resultCodec },
    ] };

    function Panel({ sessionId, load, saveTrack, saveRole }) {
      const [open, setOpen] = React.useState(false);
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [filter, setFilter] = React.useState('all');
      const revision = React.useRef(0);
      const expanded = React.useRef(open); expanded.current = open;
      const saving = React.useRef(false);
      const [savingTrack, setSavingTrack] = React.useState(false);
      const [savingRole, setSavingRole] = React.useState(false);

      const refresh = React.useCallback(async signal => {
        const current = ++revision.current;
        setBusy(true);
        try {
          const result = await load(signal);
          if (signal?.aborted || current !== revision.current) return;
          if (!result.ok) throw new Error(result.error?.message ?? 'Host status unavailable');
          if (result.value?.schema !== 'dsh.ui.status/v1' || result.value.sessionId !== sessionId) throw new Error('Status does not match this session');
          setData(result.value); setError(null);
        } catch { if (!signal?.aborted && current === revision.current) setError('Status could not be read. Refresh and retry.'); }
        finally { if (!signal?.aborted && current === revision.current) setBusy(false); }
      }, [load, sessionId]);

      const changeTrack = async mode => {
        if (!data || saving.current) return;
        saving.current = true; setSavingTrack(true);
        const current = ++revision.current;
        try {
          const result = await saveTrack(mode, data.trackRevision);
          if (current !== revision.current) return;
          if (!result.ok) throw new Error(result.error?.message ?? 'Track could not be saved');
          if (result.value?.sessionId !== sessionId || result.value?.track !== mode || result.value?.trackRevision !== data.trackRevision + 1) throw new Error('Host did not confirm the selected track');
          setData(result.value); setError(result.value.selectionLog === 'write-failed' ? 'Worker track saved, but its decision-log entry failed. Check the decision store and refresh.' : null);
        } catch { if (current === revision.current) setError('Worker track could not be confirmed. Refresh to check, then retry if needed.'); }
        finally { saving.current = false; setSavingTrack(false); setBusy(false); }
      };

      const changeRole = async roleId => {
        if (!data || saving.current || !saveRole) return;
        saving.current = true; setSavingRole(true);
        const current = ++revision.current;
        try {
          const result = await saveRole(roleId);
          if (current !== revision.current) return;
          if (!result.ok) throw new Error(result.error?.message ?? 'Role could not be switched');
          if (result.value?.sessionId !== sessionId || result.value?.preset !== roleId) throw new Error('Host did not confirm the selected role');
          const target = data.availableRoles?.find(role => role.id === roleId)?.target;
          if (target && `${result.value.model?.provider}/${result.value.model?.model}` !== target) throw new Error('Host did not confirm the assigned model');
          setData(result.value); setError(result.value.selectionLog === 'write-failed' ? 'Role switched, but its decision-log entry failed. Check the decision store and refresh.' : null);
        } catch { if (current === revision.current) setError('Role and model could not be confirmed. Refresh to check, then retry if needed.'); }
        finally { saving.current = false; setSavingRole(false); setBusy(false); }
      };

      React.useEffect(() => {
        const controller = new AbortController();
        refresh(controller.signal);
        let timer;
        let active = true;
        async function tick() {
          if (!active) return;
          if (expanded.current && !saving.current && document.visibilityState === 'visible') await refresh(controller.signal);
          if (active) timer = setTimeout(tick, 2500);
        }
        timer = setTimeout(tick, 2500);
        return () => { active = false; controller.abort(); clearTimeout(timer); revision.current++; };
      }, [refresh]);

      const blockedSet = ['refused','denied','blocked','request-denied','fail'];
      const rows = (data?.decisions ?? []).filter(event => filter === 'all' || (filter === 'blocked' ? blockedSet.includes(event.decision) : event.kind === filter));
      const titleOf = event => `${event.kind === 'judge' ? 'Judge' : event.kind === 'dispatch' ? 'Worker dispatch' : event.kind === 'mcp-gate' ? 'MCP gate' : event.kind === 'check' ? 'Check' : event.kind === 'resource' ? 'Resource' : event.kind === 'efficiency' ? 'Efficiency' : event.kind === 'review' ? 'Review' : event.kind} · ${event.decision}`;
      const trackLabel = data?.track ? `Workers: ${data.track[0].toUpperCase() + data.track.slice(1)}${data.inheritedTrack ? ' (inherited)' : ''}` : 'Workers: Default';
      const blockedCount = data?.counts?.blocked ?? 0;
      const roleLabel = data?.availableRoles?.find(role => role.id === data.preset)?.label ?? data?.preset ?? 'Standard';
      const indexError = data?.workspaceIndex?.status === 'error' || data?.workspaceIndex?.status === 'corrupt';
      const corrupt = data?.workspaceIndex?.status === 'corrupt' || data?.workspaceIndex?.reason === 'corrupt-index';

      return h('section', { className: 'kh-dock', 'aria-label': 'Session Guard' },
        h('button', { className: 'kh-bar', type: 'button', onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-controls': `kh-panel-${sessionId}` },
          h('span', { className: 'kh-mark', 'data-error': Boolean(!data?.logReady || indexError), 'aria-hidden': true }),
          h('span', { className: 'kh-pill' }, `Role: ${roleLabel}`),
          h('span', { className: 'kh-pill' }, trackLabel),
          blockedCount > 0 && h('span', { className: 'kh-pill', 'data-alert': true }, `Blocked: ${blockedCount}`),
          indexError && h('span', { className: 'kh-pill', 'data-corrupt': true }, corrupt ? 'Index: Corrupt' : 'Index: Error')),
        open && h('div', { className: 'kh-panel', id: `kh-panel-${sessionId}` },
          h('header', { className: 'kh-head' },
            h('h2', { className: 'kh-heading' }, 'Session Guard'),
            h('button', { type: 'button', className: 'kh-btn', disabled: busy || savingTrack || savingRole, onClick: () => refresh() }, busy ? 'Reading…' : 'Refresh')),
          h('div', { className: 'kh-context' },
            h('div', null,
              h('label', { className: 'kh-label', htmlFor: `kh-role-${sessionId}` }, savingRole ? 'Role · Switching…' : 'Role'),
              h('select', { id: `kh-role-${sessionId}`, className: 'kh-filter', value: data?.preset ?? '', disabled: savingRole || savingTrack || !data?.controls?.roleSwitch, onChange: event => changeRole(event.target.value), 'aria-label': 'Select session role' },
                h('option', { value: '', disabled: true }, data?.preset ?? 'Default session'),
                ...(data?.availableRoles ?? []).map(r => h('option', { key: r.id, value: r.id }, r.label)))),
            h('div', null,
              h('label', { className: 'kh-label', htmlFor: `kh-track-${sessionId}` }, savingTrack ? 'Worker Track · Saving…' : `Worker Track${data?.inheritedTrack ? ` (Inherited: ${data.inheritedTrack})` : ''}`),
              h('select', { id: `kh-track-${sessionId}`, className: 'kh-filter', value: data?.track ?? '', disabled: savingTrack || savingRole || !data?.controls?.trackSwitch, onChange: event => changeTrack(event.target.value), 'aria-label': 'Select worker track' },
                h('option', { value: '', disabled: true }, 'Choose track'),
                ...['off','free','simple','advanced'].map(mode => h('option', { key: mode, value: mode }, mode[0].toUpperCase()+mode.slice(1)))))),
          data?.workspaceIndex?.status === 'ok' && data.workspaceIndex.indexed === false && h('div', { className: 'kh-empty' }, data.workspaceIndex.label),
          error && h('div', { className: 'kh-error', role: 'alert' }, error, ' Refresh to read the current Host state.'),
          data && !data.logReady && h('div', { className: 'kh-error', role: 'status' }, 'The required decision store is not open. Check the decision store and refresh.'),
          data?.decisions?.length > 0 && h('div', { className: 'kh-tools' },
            h('strong', null, 'Recent Activity'),
            h('select', { className: 'kh-filter', style: { width: 'auto' }, value: filter, onChange: event => setFilter(event.target.value), 'aria-label': 'Filter decisions' },
              ...[['all','All decisions'],['blocked','Stopped actions'],['judge','Judge'],['dispatch','Dispatch'],['check','Checks'],['resource','Resources'],['efficiency','Efficiency'],['mcp-gate','MCP gate'],['review','Review'],['redaction','Redaction']].map(([value,label]) => h('option', { value, key: value }, label)))),
          data?.decisions?.length > 0 && h('div', { className: 'kh-events' }, rows.length ? rows.map(event => h('article', { className: 'kh-event', key: event.id, 'data-block': blockedSet.includes(event.decision) },
            h('div', { className: 'kh-event-head' }, h('span', null, titleOf(event)), h('time', { className: 'kh-time', dateTime: new Date(event.ts ?? 0).toISOString() }, event.ts ? new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')),
            h('p', { className: 'kh-reason' }, event.reason ?? 'No reason recorded.'),
            h('div', { className: 'kh-details kh-mono' }, [event.unit, event.seat, event.childId ? `Worker ${event.childId}` : null, event.judge, event.requestedTier && event.tier ? `Requested ${event.requestedTier} → required ${event.tier}` : event.tier ? `Tier ${event.tier}` : null, event.declaredRisk && event.risk ? `Declared ${event.declaredRisk} → judged ${event.risk}` : event.risk ? `Risk ${event.risk}` : null, event.tool ? `Tool: ${event.tool}` : null].filter(Boolean).join(' · ')))) : h('div', { className: 'kh-empty' }, data?.logReady ? 'No matching decisions recorded in this session yet.' : 'Decisions cannot be read until the shared store is available.'))));
    }
    return {
      inject: ['slots', 'remote'],
      async apply(ctx) {
        await ctx.get('remote').$mount(contribution);
        const style = document.createElement('style'); style.dataset.plugin = '@dsh-workbench/dsh-session-controls'; style.textContent = css; document.head.appendChild(style);
        ctx.effect(() => () => style.remove());
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'dsh-governance-status', order: 30,
          inject: sessionId => ({
            sessionId,
            load: signal => ctx.get('remote.dshSessionControlsUi').status(sessionId, signal),
            saveTrack: (mode, expectedRevision) => ctx.get('remote.dshSessionControlsUi').setTrack(sessionId, mode, expectedRevision),
            saveRole: roleId => ctx.get('remote.dshSessionControlsUi').setRole(sessionId, roleId),
          }),
        }, Panel));
      },
    };
  },
});
