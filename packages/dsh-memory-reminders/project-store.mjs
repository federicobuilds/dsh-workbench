import { loadMemoryEngine, readProjectReminders, writeProjectReminders } from '@dsh-workbench/dsh-shared-memory/memory';
import { createReminders, presentReminder, REMINDER_DOMAIN } from './reminders.mjs';

const schema = REMINDER_DOMAIN.tables.reminders.valueSchema;

export async function projectReminders(project, action, input, legacyRecords = []) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { revision, records } = await readProjectReminders(project);
    const entries = new Map(legacyRecords.map(record => [record.id, schema.parse(record)]));
    for (const record of records) entries.set(record.id, schema.parse(record));
    let dirty = false;
    const reminders = createReminders({
      get: id => entries.get(id),
      entries: () => entries.entries(),
      async put(id, record) {
        entries.set(id, schema.parse(record));
        dirty = true;
      },
    });
    const result = await reminders[action](...(Array.isArray(input) ? input : [input]));
    if (!dirty) return result;
    try {
      await writeProjectReminders(project, revision, [...entries.values()]);
      return result;
    } catch (error) {
      if (error.code !== 'MEMORY_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
}

export function documentHashes(snapshot) {
  return Object.fromEntries(snapshot.docs.filter(doc => doc.kind === 'markdown').map(doc => [doc.id, doc.sha256]));
}

export function reminderEvidence(sessionId, source) {
  return `dsh-chat/${sessionId}/${source}`;
}

export function documentsCovering(snapshot, sessionId, source) {
  const evidence = reminderEvidence(sessionId, source);
  if (snapshot.format === 'html') {
    return new Set(snapshot.records.filter(record => record.source === evidence || record.evidence?.includes(evidence)).map(record => record.id));
  }
  return new Set(snapshot.docs.filter(doc =>
    doc.kind === 'markdown' && doc.raw?.includes(`<!-- memory-evidence: ${evidence} -->`),
  ).map(doc => doc.id));
}

export async function recordMemoryEvent(project, event, legacyRecords = [], engine) {
  const { sessionId, source, reason, createdAt = Date.now(), seq, track } = event;
  if (typeof sessionId !== 'string' || !/^[\w.-]{1,256}$/.test(sessionId) ||
      typeof source !== 'string' || !/^[\w:.-]{1,320}$/.test(source) ||
      typeof reason !== 'string' || !reason.trim() || !Number.isSafeInteger(createdAt)) {
    throw new Error('A memory event needs a session ID, stable source ID, and reason.');
  }
  engine ??= await loadMemoryEngine();
  const snapshot = await engine.buildMemorySnapshot(project);
  if (documentsCovering(snapshot, sessionId, source).size && engine.validateSnapshot(snapshot).complete) {
    return { covered: true };
  }
  const record = await projectReminders(project, 'add', {
    projectId: snapshot.projectId, revision: snapshot.sourceHash, sessionId, source, reason,
    createdAt, seq, judge: 'rule', track, requiresEvidence: true, documentHashes: documentHashes(snapshot),
  }, legacyRecords);
  return presentReminder(record);
}

export async function resolveReminder(project, { id, reason, selector, dismiss = false }, legacyRecords) {
  const engine = await loadMemoryEngine();
  const snapshot = await engine.buildMemorySnapshot(project);
  const doc = snapshot.docs.find(doc => doc.kind === 'markdown' && (doc.id === selector || doc.rel === selector));
  const open = (await projectReminders(project, 'list', snapshot.projectId, legacyRecords)).find(row => row.id === id);
  if (!dismiss && open?.requiresEvidence && doc &&
      !documentsCovering(snapshot, open.sessionId, open.source).has(doc.id)) {
    throw new Error('Link the selected record to ' + reminderEvidence(open.sessionId, open.source) + ' before resolving.');
  }
  const record = await projectReminders(project, 'close', {
    projectId: snapshot.projectId, id, decision: dismiss ? 'dismissed' : 'verified', reason,
    ...(!dismiss ? {
      verified: engine.validateSnapshot(snapshot).complete,
      revision: snapshot.sourceHash,
      ...(doc ? { document: { id: doc.id, path: doc.rel, sha256: doc.sha256 } } : {}),
    } : {}),
  }, legacyRecords);
  return presentReminder(record);
}
