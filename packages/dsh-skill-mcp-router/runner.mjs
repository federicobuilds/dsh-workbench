import { randomUUID } from 'node:crypto';
import { routerInput, routerNote } from './router.mjs';
import { constrainRecommendation, validateRoutingConfig } from './routing-policy.mjs';

async function visibleCatalog(ctx, agent, signal) {
  const registry = ctx.get('skills');
  if (!registry) return {};
  const cwd = await ctx.get('workingDirectory')?.ensure?.(agent, signal);
  const lookup = { cwd, scope: agent, signal };
  const snapshot = await registry.snapshot(lookup);
  const entries = snapshot.skills.filter(skill => skill.invocation?.modelInvocable === true);
  if (entries.length > 200) throw new Error('Skill catalog exceeds routing budget');
  const catalog = {};
  for (const summary of entries) {
    const description = typeof summary.description === 'string' ? summary.description : '';
    catalog[summary.name] = { description, body: description.slice(0,2000), path: typeof summary.path === 'string' ? summary.path : '', refs: {} };
  }
  return catalog;
}

function explicitSkill(message, skills) {
  const text = message.toLowerCase();
  let longest = 0;
  let selected = null;
  for (const skill of Object.keys(skills)) {
    const name = skill.toLowerCase();
    for (const alias of new Set([name, name.replace(/[-_]/g, ' ')])) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of text.matchAll(new RegExp(`\\b${escaped}\\b`, 'g'))) {
        const prefix = text.slice(Math.max(0, match.index - 80), match.index);
        if (/(?:do not|don't|avoid|skip|without)\b[^.!?,;\n]*$/.test(prefix)) continue;
        if (match[0].length > longest) {
          longest = match[0].length;
          selected = skill;
        }
      }
    }
  }
  return selected;
}

export function applyRouter(ctx, { createUserMessage, resolvePolicy, trackPolicyReader, createEventStore, redactText, routingConfig = {} }) {
  validateRoutingConfig(routingConfig);
  const seen = new Map();
  const skipped = new Map();
  const latest = new Map();
  const timestamps = new Map();
  async function record(session, requestId, result, skills) {
    const picked = result?.decision;
    const pack = typeof picked === 'string' ? picked.split('/')[0] : '';
    const skill = !result?.unavailable && !['none', 'UNSURE'].includes(picked) && Object.hasOwn(skills, pack) ? pack : null;
    const mcp = !result?.unavailable && typeof result?.mcp === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(result.mcp) ? result.mcp : null;
    const domain = ctx.get('storageDomain')?.get?.('dsh_governance_events');
    if (!domain) return { skill, mcp };
    const ts = Math.max(Date.now(), (timestamps.get(session) ?? 0) + 1);
    timestamps.set(session, ts);
    try { await createEventStore(domain).record({ v: 1, id: randomUUID(), ts, kind: 'judge', session,
      decision: result?.unavailable ? 'unavailable' : skill || mcp ? 'recommendation' : 'no-recommendation',
      tool: 'dsh_decision', reason: `Original judge skill: ${redactText(picked ?? 'none').text.slice(0,100)}`,
      router: 'skill-mcp-router', requestId, skill, mcp, permissionGranted: false }); } catch {}
    return { skill, mcp };
  }
  const dispose = ctx.on('agent/pre-step', async (step, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    if (step.agent?.session?.header?.origin === 'subagent') return decision;
    const judge = ctx.get('dshJudge');
    const input = routerInput(step);
    const session = step.agent.session.id;
    const message = [...(step.messages ?? [])].reverse().find(m => m.role === 'user' && m.source?.kind === 'user');
    if (message?.id) latest.set(session, message.id);
    if (typeof judge?.decide !== 'function' || !input) {
      if (message?.id && skipped.get(session) !== message.id) {
        skipped.set(session, message.id);
        await record(session, message.id, null, {});
      }
      return decision;
    }
    if (seen.get(session) === input.id) return decision;
    seen.set(step.agent.session.id, input.id);
    try {
      const skills = await visibleCatalog(ctx, step.agent, step.signal);
      const explicit = explicitSkill(input.state.message, skills);
      const state = { ...input.state, message: redactText(input.state.message).text, ...(input.state.task ? { task: redactText(input.state.task).text } : {}) };
      const policy = resolvePolicy(step.agent.session.id, trackPolicyReader(ctx));
      const family = policy.state === 'valid' && policy.mode !== 'off' ? policy.mode : 'simple';
      const rawResult = explicit ? { decision: explicit } : await judge.decide({ operation: 'skill', family, state, skills }, { signal: step.signal });
      const result = constrainRecommendation(rawResult, input.state.message, skills, routingConfig);
      const rec = latest.get(session) === input.id ? await record(session, input.id, result, skills) : { skill: null, mcp: null };
      if (result.unavailable) return decision;
      const note = routerNote(result, skills);
      if (!note || step.signal?.aborted) return decision;
      const summary = [rec?.skill ? `Skill: ${rec.skill}` : null, rec?.mcp ? `MCP: ${rec.mcp}` : null].filter(Boolean).join(' · ');
      return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: 'dsh-judge-router', form: 'notice', ...(summary ? { summary } : {}), requestId: input.id } })] };
    } catch {
      if (latest.get(session) === input.id) await record(session, input.id, { unavailable: true }, {});
      return decision;
    }
  });
  const cleanup = () => { seen.clear(); skipped.clear(); latest.clear(); timestamps.clear(); dispose?.(); };
  ctx.effect?.(() => cleanup);
  return cleanup;
}
