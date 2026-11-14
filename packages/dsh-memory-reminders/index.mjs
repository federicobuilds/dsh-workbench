import { redactText } from '@dsh-workbench/dsh-governance/redaction';
import { resolvePolicy } from '@dsh-workbench/dsh-governance/policy';
import { trackPolicyReader } from '@dsh-workbench/dsh-governance/tracks';
import { loadMemoryEngine, resolveSessionProject } from '@dsh-workbench/dsh-shared-memory/memory';
import { memorySignal, presentReminder, REMINDER_DOMAIN } from './reminders.mjs';
import { documentHashes, documentsCovering, projectReminders, recordMemoryEvent, resolveReminder } from './project-store.mjs';

export const name = 'dsh-memory-reminders';
export const inject = ['tools', 'storageDomain', 'dshJudge'];

export async function apply(ctx) {
  const domain = await ctx.get('storageDomain').open(REMINDER_DOMAIN);
  const legacy = domain.table('reminders');
  const knownProjects = new Map();
  const legacyFor = projectId => [...legacy.entries()].map(([, record]) => record).filter(record => record.projectId === projectId);
  const operate = (project, projectId, action, input) =>
    projectReminders(project, action, input, legacyFor(projectId));
  const pending = new Map();
  const active = new Set();
  const judge = ctx.get('dshJudge');
  const recent = new Map();
  const categories = {
    decision: 'Review this decision, approval, or reversal for project memory.',
    correction: 'Review this durable correction for project memory.',
    blocker: 'Review this dependency and its next action for project memory.',
    outcome: 'Review this verified milestone for project memory.',
  };
  const lifetime = new AbortController();

  function trackOf(session) {
    const policy = resolvePolicy(session.id, trackPolicyReader(ctx));
    return policy.state === 'valid' ? policy.mode : 'off';
  }

  async function projectOf(session, signal) {
    const engine = await loadMemoryEngine();
    const project = await resolveSessionProject(session, undefined, engine, signal);
    return { engine, project };
  }

  async function add(session, signal, source, reason, createdAt, seq) {
    const { engine, project } = await projectOf(session, signal);
    if (!project) return null;
    const snapshot = await engine.buildMemorySnapshot(project);
    signal?.throwIfAborted();
    return recordMemoryEvent(project, { sessionId: session.id, source, reason, createdAt, seq, track: trackOf(session) },
      legacyFor(snapshot.projectId), engine);
  }

  ctx.effect(() => async () => {
    lifetime.abort();
    recent.clear();
    await Promise.allSettled([...active]);
    knownProjects.clear();
    await domain.close();
  });

  function track(key, run) {
    if (pending.has(key)) return;
    const job = Promise.resolve().then(run);
    pending.set(key, job);
    active.add(job);
    job.catch(error => {
      if (!lifetime.signal.aborted) ctx.logger?.('dsh-memory-reminders')?.warn?.('Could not evaluate a project memory reminder', error);
    }).finally(() => {
      pending.delete(key);
      active.delete(job);
    });
  }

  async function evaluate(session, turn, event) {
    const signal = lifetime.signal;
    const { engine, project } = await projectOf(session, signal);
    if (!project || signal.aborted) return;
    const snapshot = await engine.buildMemorySnapshot(project);
    const source = 'event:' + turn.seq;
    if (await operate(project, snapshot.projectId, 'hasSource', [snapshot.projectId, session.id, source])) return;
    if (documentsCovering(snapshot, session.id, source).size) return;
    const track = trackOf(session);
    const result = await judge.decide({
      operation: 'memory-reminder',
      family: track,
      state: {
        evidence: redactText(turn.text).text,
        memoryTopics: snapshot.docs.filter(doc => doc.kind === 'markdown')
          .slice(0, 25).map(doc => redactText(doc.title || doc.rel).text.slice(0, 120)),
        recentReminders: (await operate(project, snapshot.projectId, 'list', snapshot.projectId)).slice(0, 8).map(item => ({
          reason: item.reason, excerpt: item.excerpt ?? '',
        })),
      },
    }, { signal, sessionId: session.id, callId: source });
    if (signal.aborted || !Object.hasOwn(categories, result.decision)) return;
    await operate(project, snapshot.projectId, 'add', {
      projectId: snapshot.projectId, revision: snapshot.sourceHash, sessionId: session.id,
      source, seq: turn.seq, reason: categories[result.decision], createdAt: event.time,
      excerpt: redactText(turn.userText || turn.text).text.slice(0, 400),
      judge: result.judge, preferredJudge: result.preferredJudge, track, category: result.decision, requiresEvidence: true,
      documentHashes: documentHashes(snapshot),
    });
  }

  async function checkVerification(session, since = 0) {
    const ledger = ctx.get('storageDomain')?.get?.('dsh_verification');
    if (!ledger) return;
    for (const [, result] of ledger.table('latest').entries()) {
      if (result.sessionId !== session.id || result.status !== 'pass' || result.at < since || result.pending) continue;
      await add(session, lifetime.signal, 'verification:' + result.id,
        'Record the verified result for ' + result.target + '.', result.at);
    }
  }

  ctx.on('session/event', (session, event) => {
    if (session.header?.origin === 'subagent' || !session.header?.cwd || lifetime.signal.aborted) return;
    const suggestion = memorySignal(event);
    if (suggestion) {
      track(session.id + ':' + suggestion.source, () =>
        add(session, lifetime.signal, suggestion.source, suggestion.reason, event.time, event.seq));
    }
    if (event.type === 'turn/end') {
      track(session.id + ':verification', () => checkVerification(session, event.time - 300000));
    }
    if (!judge.routingEnabled) return;
    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text.trim()) recent.set(session.id, { text: text.slice(0, 1800), userText: text.slice(0, 400), seq: event.seq, explicit: Boolean(suggestion) });
    }
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const prior = recent.get(session.id);
      if (text.trim() && !prior?.explicit) recent.set(session.id, {
        text: [prior?.text ?? '', text.slice(-1800)].join('\n').slice(-3600),
        userText: prior?.userText, seq: prior?.seq ?? event.seq,
      });
    }
    if (event.type === 'turn/end') {
      const evidence = recent.get(session.id);
      recent.delete(session.id);
      if (!evidence || evidence.explicit || !['completed', 'blocked'].includes(event.data.reason?.kind)) return;
      track(session.id + ':event:' + evidence.seq, () => evaluate(session, evidence, event));
    }
  });

  ctx.on('agent/disposed', ({ agent }) => { recent.delete(agent.session.id); knownProjects.delete(agent.session.id); });

  ctx.get('systemPrompt')?.context({
    name: 'dsh-memory-reminders:open',
    order: 9_200,
    interpolate: false,
    async text({ agent }) {
      if (!agent || agent.session.header?.origin === 'subagent') return '';
      try {
        let known = knownProjects.get(agent.session.id);
        if (!known) {
          const { engine, project } = await projectOf(agent.session, lifetime.signal);
          if (!project) return '';
          const snapshot = await engine.buildMemorySnapshot(project);
          known = { project, id: snapshot.projectId };
          knownProjects.set(agent.session.id, known);
        }
        const records = await operate(known.project, known.id, 'list', known.id);
        return records.length ? `This project has ${records.length} open memory reminder(s). Review them using memory_reminders before a handoff.` : '';
      } catch {
        return '';
      }
    },
  });

  ctx.get('tools').register({
    name: 'memory_reminders',
    description: 'List open reminders for this project. Suggest a reminder only for a durable decision, correction, or verified milestone. At handoff, resolve it with a published and validated changed memory document, or dismiss it with the reason recorded by the lead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'suggest', 'milestone', 'handoff', 'resolve', 'dismiss'] },
        id: { type: 'string', description: 'Reminder ID, or a stable event ID for a milestone or handoff.' },
        reason: { type: 'string' },
        selector: { type: 'string', description: 'Exact memory document ID or path for a verified resolution.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ action = 'list', id, reason, selector }, { agent, callId, signal }) {
      const session = agent?.session;
      if (!session || session.header?.origin === 'subagent') throw new Error('Use Memory Reminders from the lead project session.');
      const operationSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const job = execute(session, callId, operationSignal, { action, id, reason, selector });
      active.add(job);
      try {
        return await job;
      } finally {
        active.delete(job);
      }
    },
  });

  async function execute(session, callId, signal, { action, id, reason, selector }) {
    await Promise.allSettled([...pending].filter(([key]) => key.startsWith(`${session.id}:`)).map(([, job]) => job));
    const { engine, project } = await projectOf(session, signal);
    if (!project) throw new Error('This session has no existing project memory.');
    const snapshot = await engine.buildMemorySnapshot(project);
    signal.throwIfAborted();
    if (action === 'list') {
      const open = await operate(project, snapshot.projectId, 'list', snapshot.projectId);
      return { openCount: open.length, reminders: open.slice(0, 30).map(presentReminder) };
    }
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 400) throw new Error('Give a reason of 1 to 400 characters.');
    if (action === 'milestone' || action === 'handoff') {
      if (typeof id !== 'string' || !id.trim()) throw new Error('Give this event a stable ID.');
      return add(session, signal, action + ':' + id, reason, Date.now());
    }
    if (action === 'suggest') {
      const record = await operate(project, snapshot.projectId, 'add', {
        projectId: snapshot.projectId, revision: snapshot.sourceHash, sessionId: session.id,
        source: `tool:${callId}`, reason, judge: 'manual', track: trackOf(session), documentHashes: documentHashes(snapshot), createdAt: Date.now(),
      });
      return presentReminder(record);
    }
    if (!['resolve', 'dismiss'].includes(action) || typeof id !== 'string') throw new Error('Choose a reminder and resolution action.');
    return resolveReminder(project, { id, reason, selector, dismiss: action === 'dismiss' }, legacyFor(snapshot.projectId));
  }
}
