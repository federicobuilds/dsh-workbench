import { createHash } from 'node:crypto';
import { redactText } from '@dsh-workbench/dsh-governance/redaction';

const STATUSES = new Set(['open', 'verified', 'dismissed']);
const SHA256 = /^[a-f0-9]{64}$/;

export const REMINDER_DOMAIN = {
  name: 'dsh_memory_reminders',
  version: 1,
  tables: {
    reminders: {
      valueSchema: {
        parse(value) {
          if (!value || !SHA256.test(value.id) || !SHA256.test(value.projectId)
            || !STATUSES.has(value.status) || typeof value.sessionId !== 'string'
            || typeof value.source !== 'string' || typeof value.reason !== 'string'
            || !Number.isSafeInteger(value.createdAt) || !SHA256.test(value.baselineRevision)
            || !value.documentHashes || typeof value.documentHashes !== 'object' || Array.isArray(value.documentHashes)) {
            throw new Error('Invalid memory reminder');
          }
          return value;
        },
      },
    },
  },
};

function idFor(projectId, sessionId, source) {
  return createHash('sha256').update(JSON.stringify([projectId, sessionId, source])).digest('hex');
}

export function memorySignal(event) {
  if (event.type === 'goal/change' && ['complete', 'block'].includes(event.data.operation)) {
    return {
      source: `goal:${event.data.goal.id}:${event.data.goal.revision}`,
      reason: event.data.operation === 'complete'
        ? 'Review the completed goal for a durable outcome.'
        : 'Review the blocked goal for a durable dependency or next action.',
    };
  }
  if (event.type !== 'user/message' || event.data.source?.kind !== 'user') return null;
  const body = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const request = body.trimStart();
  if (!/^(?:(?:please\s+|can you\s+|could you\s+))?(?:(?:save|record|capture|note|write|remember)\b[^.!?\n]{0,180}\b(?:in|to)\s+(?:(?:the|our|shared|project)\s+){0,3}memory\b|update\s+(?:(?:the|our|shared|project)\s+){0,3}memory\b)/i.test(request)) return null;
  return {
    source: `message:${event.data.id ?? event.seq}`,
    reason: 'The user asked to update project memory.',
  };
}

export function createReminders(table) {
  let writes = Promise.resolve();
  function enqueue(operation) {
    const next = writes.then(operation);
    writes = next.catch(() => {});
    return next;
  }

  function list(projectId) {
    return [...table.entries()].map(([, value]) => value)
      .filter(value => value.projectId === projectId && value.status === 'open')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  return {
    list,
    hasSource: (projectId, sessionId, source) => Boolean(table.get(idFor(projectId, sessionId, source))),
    countForSession(sessionId) {
      let count = 0;
      for (const [, value] of table.entries()) {
        if (value.sessionId === sessionId && value.status === 'open') count++;
      }
      return count;
    },
    add({ projectId, revision, sessionId, source, reason, documentHashes, createdAt, seq, judge, preferredJudge, track, category, requiresEvidence, excerpt }) {
      const id = idFor(projectId, sessionId, source);
      return enqueue(async () => {
        const existing = table.get(id);
        if (existing) return existing;
        const value = {
          id, projectId, sessionId, source, status: 'open', baselineRevision: revision,
          reason: redactText(reason).text.slice(0, 400), createdAt,
          documentHashes,
          ...(Number.isSafeInteger(seq) ? { seq } : {}),
          ...(['rule', 'manual', 'clef-flash', 'jev'].includes(judge) ? { judge } : {}),
          ...(['clef-flash', 'jev'].includes(preferredJudge) ? { preferredJudge } : {}),
          ...(['free', 'simple', 'advanced', 'off'].includes(track) ? { track } : {}),
          ...(category ? { category } : {}),
          ...(excerpt ? { excerpt } : {}),
          ...(requiresEvidence ? { requiresEvidence: true } : {}),
        };
        await table.put(id, value);
        return value;
      });
    },
    close({ projectId, id, decision, reason, document, revision, verified }) {
      return enqueue(async () => {
        const record = table.get(id);
        if (record?.projectId !== projectId) throw new Error('Choose an open reminder from this project.');
        if (record.status !== 'open') return record;
        const resolution = redactText(reason).text.trim().slice(0, 400);
        if (!resolution) throw new Error('Give a reason that explains the resolution.');
        if (decision === 'verified') {
          if (!verified || !document || revision === record.baselineRevision) {
            throw new Error('Publish and validate the updated memory record before resolving this reminder.');
          }
          if (record.documentHashes[document.id] === document.sha256) {
            throw new Error('Choose the memory document that changed for this reminder.');
          }
        }
        const next = {
          ...record,
          status: decision,
          resolution,
          closedAt: Date.now(),
          ...(decision === 'verified' ? { revision, document: document.path } : {}),
        };
        await table.put(id, next);
        return next;
      });
    },
    drain: () => writes,
  };
}

export function presentReminder({ documentHashes: _hashes, ...record }) {
  const decisionBy = { rule: 'Rule', manual: 'Lead', 'clef-flash': 'Clef Flash', jev: 'Jev' }[record.judge];
  return { ...record, ...(decisionBy ? { decisionBy } : {}), evidence: `dsh-chat/${record.sessionId}/${record.source}` };
}
