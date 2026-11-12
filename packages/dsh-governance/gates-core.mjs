/** DSH governance gates for DSH: MCP discipline gate, secret redaction, and a
 * durable decision/event log for transparency. Faithful port of the harness
 * plugin's mcpGate + redact; every refusal/redaction is recorded so the UI and
 * the dsh_governance_events tool can show what stopped what and why.
 * This plugin gates tool behavior only; it never spends, fetches, or dispatches.
 */
import { randomUUID } from 'node:crypto';
import { MCP_SKILL, SHELL_TOOLS, mcpCalls, mcpGateDecision, hasObfuscatedMcpExecutable, passiveInspection, emptySeen, redactText } from './gates.mjs';
import { EVENTS_DOMAIN_SPEC, makeEvent, createEventStore } from './event-store.mjs';
import { loadedMcpRouter, completedDiscovery, redactToolResult } from './tool-result-policy.mjs';

export const name = 'dsh-governance-gates';
export const inject = ['tools'];

const svc = (ctx, n) => { if (ctx == null) return undefined; return typeof ctx.get === 'function' ? ctx.get(n) : ctx[n]; };
const sessionIdOf = (exec) => exec?.agent?.session?.id ?? null;

export async function applyGates(ctx, sharedEvents) {
  const tools = svc(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function' || typeof tools.guard !== 'function') {
    throw new Error('dsh-governance-gates: ctx.tools registry is required');
  }

  const mcpSeen = new Map();
  const grants = new Map();
  const seenFor = (id) => {
    if (!mcpSeen.has(id)) {
      const s = emptySeen();
      if (events) for (const ev of events.recent(500)) {
        if (ev?.session !== id || ev?.kind !== 'info' || ev?.decision !== 'mcp-discovery') continue;
        if (ev.tool === 'skill:mcp-router') s.skill = true;
        else if (ev.tool?.startsWith('server:')) s.servers.add(ev.tool.slice(7));
        else if (ev.tool?.startsWith('tool:')) s.tools.add(ev.tool.slice(5));
      }
      mcpSeen.set(id, s);
    }
    return mcpSeen.get(id);
  };

  // Durable event log (best-effort; gates still work without it). A shared store
  // passed by the consolidated plugin is preferred so all decisions aggregate once.
  let events = sharedEvents ?? null;
  let domain, ownedDomain = false;
  if (!events) {
    try {
      const storageDomain = svc(ctx, 'storageDomain');
      if (storageDomain) {
        const existing = storageDomain.get?.(EVENTS_DOMAIN_SPEC.name);
        domain = existing ?? await storageDomain.open(EVENTS_DOMAIN_SPEC);
        ownedDomain = !existing;
        events = createEventStore(domain);
      }
    } catch { events = null; }
  }
  const record = async (ev) => { if (!events) return; try { ev.id = randomUUID(); await events.record(ev); } catch { /* logging is best-effort */ } };

  try {
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      try {
        const last = [...(messages ?? [])].reverse().find(m => m?.role === 'user' && m.source?.kind === 'user');
        const txt = last?.content?.filter(b => b?.type === 'text').map(b => b.text).join(' ') ?? '';
        if (agent?.session?.id && last) {
          const request = txt.length <= 2000 && txt.trim().match(/^(?:please\s+)?(?:run|execute|invoke|call)\s+(?:mcp2cli\s+)?@([A-Za-z0-9][\w.-]*)\s+([A-Za-z0-9][\w.-]*)[.!]?$/i);
          grants.set(agent.session.id, new Set(request ? [`${request[1]}/${request[2]}`] : []));
        }
      } catch { /* best-effort */ }
      return next();
    });
  } catch { /* event unavailable; maintenance stays strictly refused */ }

  // 1) MCP discipline gate on shell tools (monotonic denial).
  const disposeGuard = tools.guard((exec) => {
    try {
      const toolName = exec?.name;
      if (typeof toolName !== 'string' || !SHELL_TOOLS.has(toolName)) return undefined;
      const command = exec?.arguments?.command;
      if (typeof command !== 'string' || (!command.includes('mcp2cli') && !hasObfuscatedMcpExecutable(command))) return undefined;
      if (passiveInspection(command)) return undefined;
      const sid = sessionIdOf(exec);
      if (!sid) return 'MCP gate: discovery and invocation require a calling session.';
      const seen = seenFor(sid);
      const decision = mcpGateDecision(command, seen, grants.get(sid));
      if (decision.ok) return undefined;
      const reason = `MCP gate [${decision.category}]: ${decision.problems.join('; and ')}.`;
      void record(makeEvent({ kind: 'mcp-gate', session: sid, decision: 'denied', reason: decision.problems.join('; '), tool: toolName }));
      return reason;
    } catch { return 'DSH MCP gate failure: mcp2cli call denied (fail closed)'; }
  });

  // 2) Track discovery + skill read so later calls pass (observed after execution).
  const disposeResult = ctx.on('tools/result', (exec, result) => {
    try {
      const sid = sessionIdOf(exec);
      if (!sid) return;
      const seen = seenFor(sid);
      const toolName = exec?.name;
      if (loadedMcpRouter(exec, result)) {
        seen.skill = true;
        void record(makeEvent({ kind: 'info', session: sid, decision: 'mcp-discovery', tool: 'skill:mcp-router', reason: 'verified mcp-router load' }));
      }
      if (SHELL_TOOLS.has(toolName) && typeof exec?.arguments?.command === 'string') {
        for (const receipt of completedDiscovery(exec, result, seen)) {
          if (receipt.kind === 'server') seen.servers.add(receipt.server);
          else seen.tools.add(`${receipt.server}/${receipt.tool}`);
          void record(makeEvent({ kind: 'info', session: sid, decision: 'mcp-discovery', tool: receipt.kind === 'server' ? `server:${receipt.server}` : `tool:${receipt.server}/${receipt.tool}`, reason: 'verified discovery receipt' }));
        }
      }
    } catch { /* observation is best-effort */ }
  });

  // 3) Secret redaction on tool results (content replacement, presentation policy).
  const disposePost = ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const redacted = redactToolResult(result);
      if (redacted.decision) {
        void record(makeEvent({ kind: 'redaction', session: sessionIdOf(exec), decision: redacted.decision.kind === 'block' ? 'blocked' : 'redacted', reason: `${redacted.hits} detected secret shape(s) removed from the tool result`, tool: exec?.name }));
        return redacted.decision;
      }
      return next();
    } catch {
      return { kind: 'block', feedback: [{ type: 'text', text: 'Tool result withheld: secret redaction could not complete safely.' }] };
    }
  });

  // 4) Transparency: query recent gate/judge/redaction decisions.
  const render = (_a, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }];
  const disposeQuery = tools.register({
    name: 'dsh_governance_events',
    description: 'List recent DSH governance governance events (judge decisions, MCP-gate refusals, secret redactions, check/resource outcomes) with reasons. Read-only transparency; never grants permission.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', description: 'Max events to return (1-200, default 50).' },
      kind: { type: 'string', description: 'Filter by kind: judge, mcp-gate, redaction, test-guard, check, resource, dispatch, review, efficiency, info.' },
    } },
    output: { schema: { type: 'object' }, render },
    execute: async (args) => {
      if (!events) return { status: 'unavailable', reason: 'event store not mounted', events: [] };
      const limit = Number.isInteger(args?.limit) && args.limit >= 1 && args.limit <= 200 ? args.limit : 50;
      let rows = events.recent(limit * 4);
      if (typeof args?.kind === 'string' && args.kind) rows = rows.filter(r => r.kind === args.kind);
      return { status: 'ok', count: rows.length, events: rows.slice(0, limit) };
    },
  }, { when: () => true });

  return async () => {
    for (const d of [disposeGuard, disposeResult, disposePost, disposeQuery]) { try { d?.(); } catch { /* best-effort */ } }
    if (ownedDomain) await domain.close();
  };
}
