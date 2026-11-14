import { Remote, RemoteError, principalOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolvePolicy } from '@dsh-workbench/dsh-governance/policy';
import { redactText } from '@dsh-workbench/dsh-governance/redaction';
import { trackPolicyReader } from '@dsh-workbench/dsh-governance/tracks';
import { TYPERT } from './remote.mjs';
import { buildEvidence, taskPrompt } from './evidence.mjs';

export const name = 'dsh-task-organization';
export const inject = ['typert', 'dshJudge'];
const initializers = [];

function messageText(message) {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function safeText(text, limit) {
  return redactText(text).text.slice(0, limit);
}

class TaskOrganizationService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'dshTaskOrganization');
    for (const initialize of initializers) initialize.call(this);
  }

  async suggest(agent, draft, candidates, signal) {
    if (!this.ctx.invocation || principalOf(this.ctx.invocation) !== undefined) {
      throw new RemoteError('gateway/bad-request', 'Only the owner can ask the Judge to organize a draft.');
    }
    signal?.throwIfAborted();
    const recentUserMessages = agent.session.deriveMessages()
      .filter(message => message.role === 'user' && message.source?.kind === 'user');
    let objective;
    try { objective = this.ctx.get('goals')?.get(agent)?.objective; } catch { /* Goal state is optional. */ }
    objective ||= messageText(recentUserMessages[0]);
    const policy = resolvePolicy(agent.session.id, trackPolicyReader(this.ctx));
    const track = policy.state === 'valid' ? policy.mode : 'off';
    if (!objective.trim()) return { action: 'stay', track, judge: 'rule' };
    const result = await this.ctx.get('dshJudge').decide({
      operation: 'task-organization',
      family: track,
      state: {
        objective: safeText(objective, 1200),
        recent: recentUserMessages.slice(-3).map(message => safeText(messageText(message), 650)),
        draft: safeText(draft, 6000),
        candidates: candidates.map(title => safeText(title, 160)),
      },
    }, { signal, sessionId: agent.session.id });
    signal?.throwIfAborted();
    const decision = { track, ...(result.judge ? { judge: result.judge } : {}),
      ...(result.preferredJudge ? { preferredJudge: result.preferredJudge } : {}) };
    if (result.unavailable) return { ...decision, action: 'unavailable', reason: result.why ?? 'Judge is unavailable.' };
    const match = /^existing_([0-7])$/.exec(result.decision);
    if (match && Number(match[1]) < candidates.length) return { ...decision, action: 'existing', candidate: Number(match[1]) };
    if (result.decision === 'stay') return { ...decision, action: 'stay' };
    const events = agent.session.snapshotEvents();
    const evidence = buildEvidence(agent.session.id, events, draft, safeText);
    const context = {
      parentBoundary: events.at(-1)?.seq ?? null,
      title: draft.trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 72),
      sources: evidence.ranges.map(({ messages: _messages, ...range }) => range),
      sourceText: taskPrompt(draft, evidence),
    };
    if (result.decision === 'new') return { ...decision, action: 'new', ...context };
    return { ...decision, action: 'split', ...context };
  }
}

Remote(TaskOrganizationService.prototype.suggest, {
  kind: 'method', name: 'suggest', static: false, private: false,
  addInitializer(initialize) { initializers.push(initialize); },
});

export function apply(ctx) {
  ctx.get('typert').register(TYPERT);
  new TaskOrganizationService(ctx);
}
