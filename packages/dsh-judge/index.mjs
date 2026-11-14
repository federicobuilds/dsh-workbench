import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolvePolicy } from '@dsh-workbench/dsh-governance/policy';
import { trackPolicyReader } from '@dsh-workbench/dsh-governance/tracks';
import { createEventStore } from '@dsh-workbench/dsh-governance/events';
import { redactText } from '@dsh-workbench/dsh-governance/redaction';
import { createOriginalJudge, OPERATIONS } from './runner.mjs';
import { routerInput, routerNote } from './router.mjs';
export const name = 'dsh-judge';
export const inject = ['tools'];

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
    const loaded = await registry.get(summary.name, lookup);
    if (!loaded || loaded.invocation?.modelInvocable !== true) continue;
    let body = typeof loaded.content === 'string' ? loaded.content : '';
    // Remove only the common DSH execution-contract prefix from the judge's
    // relevance excerpt; the model still loads the complete original skill.
    const heading = body.search(/^# [^\n]+/m);
    if (heading >= 0) body = body.slice(heading);
    catalog[summary.name] = { description: summary.description, body: body.slice(0,20000), path: typeof summary.path === 'string' ? summary.path : '', refs: {} };
  }
  return catalog;
}
function familyOf(ctx, agent) {
  const policy = resolvePolicy(agent.session.id, trackPolicyReader(ctx));
  return policy.state === 'valid' ? policy.mode : 'off';
}
function approved(config, scope) { return scope.external ? config.allowExternalInference === true : config.allowLocalInference === true; }

async function record(ctx, sessionId, result, operation, callId, track) {
    const domain = ctx.get('storageDomain')?.get?.('dsh_governance_events');
    if (!domain) return;
    try { await createEventStore(domain).record({ v: 1, id: randomUUID(), ts: Date.now(), kind: 'judge', session: sessionId,
      decision: result.unavailable ? 'unavailable' : result.decision === 'UNSURE' ? 'uncertain' : result.decision === 'none' ? 'no-recommendation' : 'recommendation',
      ...(track ? { track } : {}),
      ...(result.preferredJudge ? { preferredJudge: result.preferredJudge } : {}),
      tool: 'dsh_decision', actor: 'advisory-router',
      ...(['clef-flash', 'jev'].includes(result.judge) ? { judge: result.judge } : {}),
      ...(typeof result.model === 'string' && /^(?:clef-flash|jev-[0-9.]+)$/.test(result.model) ? { model: result.model } : {}),
      ...(typeof callId === 'string' && /^[\w:.-]{1,160}$/.test(callId) ? { callId } : {}),
      reason: `Advisory judge ${operation}: ${redactText(result.decision).text.slice(0,100)}`, permissionGranted: false }); } catch { /* advisory does not waive/refuse task */ }
  }
class OriginalJudgeService extends Service {
  constructor(ctx, config) {
    super(ctx, 'dshJudge'); this.context = ctx; this.runner = createOriginalJudge({ authorizeOperation: scope => approved(config, scope) });
    this.routingEnabled = config.allowLocalInference === true || config.allowExternalInference === true;
    this.lifetime = new AbortController(); ctx.effect(() => () => this.lifetime.abort());
  }
  async decide(input, options = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    const result = await this.runner.decide(input, { signal });
    if (options.sessionId && input.operation !== 'skill-index' && !signal.aborted) {
      await record(this.context, options.sessionId, result, input.operation, options.callId, input.family);
    }
    return result;
  }
}

export function apply(ctx, config = {}) {
  const judge = new OriginalJudgeService(ctx, config);
  const seen = new Map();
  ctx.effect(() => () => seen.clear());
  if (config.disableBundledRouter !== true) ctx.on('agent/pre-step', async (step, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    // Without inference authorization the router can only answer UNSURE; skip the call and the log noise.
    if (config.allowLocalInference !== true && config.allowExternalInference !== true) return decision;
    const input = routerInput(step);
    if (!input || seen.get(step.agent.session.id) === input.id) return decision;
    seen.set(step.agent.session.id, input.id);
    try {
      const skills = await visibleCatalog(ctx, step.agent, step.signal);
      const state = { ...input.state, message: redactText(input.state.message).text, ...(input.state.task ? { task: redactText(input.state.task).text } : {}) };
      const result = await judge.decide({ operation: 'skill', family: familyOf(ctx, step.agent), state, skills }, { signal: step.signal, sessionId: step.agent.session.id, callId: input.id });
      const note = result.unavailable ? 'Router status: unavailable. Continue without advisory suggestions; this grants no permission.' : routerNote(result, skills);
      if (!note || step.signal?.aborted) return decision;
      return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: 'dsh-judge-router', requestId: input.id } })] };
    } catch {
      return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: 'Router status: unavailable. Continue without advisory suggestions; this grants no permission.' }], source: { kind: 'dsh-judge-router', requestId: input.id } })] };
    }
  });
  ctx.get('tools').register({ name: 'dsh_decision', description: 'Use the original DSH judge decision modes. Advisory only: never grants permission or dispatches. Inference requires configured operator authorization; skill-index is local metadata.',
    parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
      operation: { type: 'string', enum: OPERATIONS }, input: { type: 'string', description: 'Original decision input text or JSON; at most 12000 characters.' },
    } }, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      if (!exec.agent || (args.input?.length ?? 0) > 12000) return { decision: 'UNSURE', unavailable: true, why: 'Caller/input unavailable', permissionGranted: false };
      const skills = ['skill','skill-index'].includes(args.operation) ? await visibleCatalog(ctx, exec.agent, exec.signal) : {};
      const result = await judge.decide({ operation: args.operation, family: familyOf(ctx, exec.agent), state: args.input ?? '', skills }, { signal: exec.signal, sessionId: exec.agent.session.id, callId: exec.callId });
      if (args.operation === 'skill') return { ...result, hint: routerNote(result, skills) };
      return result;
    } });
}
