window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-skill-mcp-router',
  factory(require) {
    const React = require('react');
    let RemoteClient = null, TYPERT = null;
    try { ({ RemoteClient } = require('@deepseek-ai/dsh-typert-client')); ({ TYPERT } = require('./remote.mjs')); } catch {}
    let activeCtx = null;
    const h = React.createElement;
    const css = `.sr-dock{position:relative;display:inline-flex;gap:6px}.sr-card{position:relative;display:inline-flex;align-items:center;gap:6px;max-width:min(440px,80vw);padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:18px}.sr-card.sr-enter{animation:sr-enter 180ms ease-out}.sr-card.sr-exit{animation:sr-exit 180ms ease-in forwards;pointer-events:none}.sr-card span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sr-card button{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}.sr-card button:hover{color:var(--dsw-alias-label-primary)}[data-slot="conversation.input.dock"]:has(> .sr-dock){box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance)*2);max-width:var(--dsh-composer-card-max-width);margin:0 auto 4px;display:grid!important;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;column-gap:6px}[data-slot="conversation.input.dock"]:has(> .sr-dock)>:not(.sr-dock):not(.wi-dock){grid-column:1/-1}[data-slot="conversation.input.dock"]:has(> .sr-dock)>.kh-dock,[data-slot="conversation.input.dock"]:has(> .sr-dock)>.tp-dock{width:100%;max-width:none}[data-slot="conversation.input.dock"]:has(> .sr-dock)>.sr-dock{grid-column:2}[data-slot="conversation.input.dock"]:has(> .sr-dock)>.wi-dock{grid-column:3;width:auto;max-width:none;margin:0;justify-content:flex-start}[data-slot="conversation.input.dock"]:has(> .sr-dock)>.wi-dock .wi-pill{white-space:nowrap;flex:none}@keyframes sr-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}@keyframes sr-exit{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(4px)}}@media (prefers-reduced-motion:reduce){.sr-card.sr-enter,.sr-card.sr-exit{animation:none}}`;
    const idCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', jsonSchema: { type: 'string', minLength: 1 }, create: () => ({ parse(value) { if (typeof value !== 'string' || !value) throw new Error('Invalid session'); return value; } }) };
    const resultCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-skill-mcp-router#Recommendation', jsonSchema: {}, create: () => ({ parse: value => value }) };
    const contribution = { package: '@dsh-workbench/dsh-skill-mcp-router', descriptors: [{ id: '@dsh-workbench/dsh-skill-mcp-router#routerRecommendationUi/latest', namespace: 'routerRecommendationUi', method: 'latest', service: 'routerRecommendationUi', invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' }, parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec }], cancellation: { parameter: 'signal' }, result: resultCodec }] };

    function RouterDock({ sessionId, useSession, load }) {
      const running = typeof useSession === 'function' ? useSession(s => s.running) : false;
      const fetcher = typeof load === 'function' ? load : (signal => activeCtx?.get?.('remote.routerRecommendationUi')?.latest?.(sessionId, signal));
      const [data, setData] = React.useState(null);
      const [dismissed, setDismissed] = React.useState([]);
      const [previous, setPrevious] = React.useState(null);
      const activeSession = React.useRef(sessionId);
      React.useEffect(() => {
        if (activeSession.current !== sessionId) {
          activeSession.current = sessionId;
          setData(null);
          setDismissed([]);
        }
        const controller = new AbortController();
        let timer;
        async function refresh() {
          try {
            const result = await fetcher(controller.signal);
            if (!controller.signal.aborted) setData({ sessionId, value: result?.ok ? result.value : null });
          } catch {}
          if (!controller.signal.aborted) timer = setTimeout(refresh, 1000);
        }
        refresh();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [sessionId, running, load]);
      const value = data?.sessionId === sessionId ? data.value : null;
      const current = Object.fromEntries(['skill', 'mcp'].map(type => [type,
        value?.[type] && !dismissed.includes(`${value.id}:${type}`) ? value : null]));
      React.useEffect(() => {
        const timers = [];
        setPrevious(old => {
          const retained = old?.sessionId === sessionId ? old : {};
          return { sessionId, skill: current.skill || retained.skill || null, mcp: current.mcp || retained.mcp || null };
        });
        if (previous?.sessionId === sessionId) {
          for (const type of ['skill', 'mcp']) {
            if (!current[type] && previous[type]) timers.push(setTimeout(() => setPrevious(old =>
              old?.sessionId === sessionId ? { ...old, [type]: null } : old), 180));
          }
        }
        return () => timers.forEach(clearTimeout);
      }, [sessionId, current.skill?.id, current.mcp?.id, dismissed]);
      const cards = ['skill', 'mcp'].map(type => {
        const active = current[type];
        const card = active || (previous?.sessionId === sessionId ? previous[type] : null);
        if (!card?.[type]) return null;
        const name = type === 'skill' ? 'Skill' : 'MCP';
        const label = `${name}: ${card[type]}`;
        return h('div', { key: `${card.id}:${type}`, className: `sr-card ${active ? 'sr-enter' : 'sr-exit'}`, 'aria-label': `${name} recommendation` },
          h('span', { title: label }, label),
          h('button', { type: 'button', 'aria-label': `Dismiss ${type} recommendation`, onClick: () => setDismissed(ids => [...ids, `${card.id}:${type}`]) }, 'Dismiss'));
      }).filter(Boolean);
      return h('div', { className: 'sr-dock', 'aria-live': 'polite', 'aria-atomic': 'true' }, ...cards);
    }
    return {
      inject: ['slots', 'remote'],
      async apply(ctx) {
        activeCtx = ctx;
        if (RemoteClient && TYPERT && typeof ctx.plugin === 'function') ctx.plugin(class extends RemoteClient { constructor(c) { super(c, 'routerRecommendationUi', TYPERT); } });
        await ctx.get?.('remote')?.$mount?.(contribution);
        const style = document.createElement('style'); style.dataset.plugin = '@dsh-workbench/dsh-skill-mcp-router'; style.textContent = css; document.head.appendChild(style);
        ctx.effect(() => () => style.remove());
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'skill-mcp-router', order: 3,
          inject: sessionId => ({ sessionId, load: signal => ctx.get('remote.routerRecommendationUi').latest(sessionId, signal) }),
        }, RouterDock));
      },
    };
  },
});
