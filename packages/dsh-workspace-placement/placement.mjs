import { randomUUID } from 'node:crypto';

const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const id = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const refusal = Symbol('placement-refusal');
const fail = reason => { throw Object.assign(new Error(reason), { [refusal]: reason }); };
const keysAre = (value, keys) => Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const placementEventSchema = {
  parse(value) {
    if (!object(value) || value.v !== 1 || typeof value.eventId !== 'string' || !uuid.test(value.eventId) || !Number.isFinite(value.at)) fail('unavailable');
    if (value.op === 'detach') {
      if (!keysAre(value, ['v', 'eventId', 'op', 'targetEventId', 'at']) || typeof value.targetEventId !== 'string' || !uuid.test(value.targetEventId)) fail('unavailable');
    } else if (value.op === 'append' && value.kind === 'workspace') {
      if (!keysAre(value, ['v', 'eventId', 'op', 'kind', 'sessionId', 'workspaceId', 'at']) || !id(value.sessionId) || !id(value.workspaceId)) fail('unavailable');
    } else if (value.op === 'append' && value.kind === 'task') {
      if (!keysAre(value, ['v', 'eventId', 'op', 'kind', 'taskId', 'originalParentSessionId', 'successorSessionId', 'workerSessionId', 'at']) || !id(value.taskId) || !id(value.originalParentSessionId) || !(value.successorSessionId === null || id(value.successorSessionId)) || !(value.workerSessionId === null || id(value.workerSessionId)) || value.successorSessionId === null && value.workerSessionId === null) fail('unavailable');
    } else fail('unavailable');
    return Object.freeze({ ...value });
  },
};

export const PLACEMENT_DOMAIN_SPEC = Object.freeze({ name: 'dsh_session_placement', version: 1, tables: { events: { valueSchema: placementEventSchema } } });
const queues = new WeakMap();

export function createPlacementOperations({ storageDomain, persistence, registry, sessions, agents, activity }) {
  let domainPromise;
  let disposed = false;
  const domain = () => domainPromise ??= Promise.resolve().then(() => storageDomain.get(PLACEMENT_DOMAIN_SPEC.name) ?? storageDomain.open(PLACEMENT_DOMAIN_SPEC));
  function serialize(store, action) {
    const pending = (queues.get(store) ?? Promise.resolve()).catch(() => {}).then(action);
    queues.set(store, pending);
    const clear = () => { if (queues.get(store) === pending) queues.delete(store); };
    pending.then(clear, clear);
    return pending;
  }
  const check = signal => { if (disposed || signal?.aborted) fail('unavailable'); };
  function current(table) {
    const appends = new Map(), detaches = new Set();
    for (const [key, raw] of table.entries()) {
      const event = placementEventSchema.parse(raw);
      if (key !== event.eventId || table.get(key)?.eventId !== key) fail('unavailable');
      if (event.op === 'append') appends.set(key, event);
      else {
        if (detaches.has(event.targetEventId)) fail('unavailable');
        detaches.add(event.targetEventId);
      }
    }
    for (const target of detaches) if (!appends.has(target)) fail('unavailable');
    return [...appends.values()].filter(event => !detaches.has(event.eventId));
  }
  async function saved(sessionId, signal) {
    let snapshot;
    try { snapshot = await persistence.stat(sessionId, { signal }); }
    catch (error) {
      if (error?.name === 'SessionPersistenceNotFoundError' || error?.code === 'ENOENT') fail('missing');
      throw error;
    }
    if (!snapshot) fail('missing');
    if (snapshot.header?.id !== sessionId || !id(snapshot.header.cwd)) fail('unavailable');
    return snapshot.header;
  }
  async function lifecycle(sessionId, signal) {
    check(signal);
    if (!Array.isArray(registry.archivedSessionIds)) fail('unavailable');
    if (registry.archivedSessionIds.includes(sessionId)) fail('archived');
    if (sessions.get(sessionId) !== undefined || agents.get(sessionId) !== undefined) fail('live');
    const work = await activity(sessionId);
    if (!Array.isArray(work)) fail('unavailable');
    if (work.length) fail('active');
    check(signal);
    if (!Array.isArray(registry.archivedSessionIds)) fail('unavailable');
    if (registry.archivedSessionIds.includes(sessionId)) fail('archived');
    if (sessions.get(sessionId) !== undefined || agents.get(sessionId) !== undefined) fail('live');
  }
  function workspace(workspaceId) {
    const found = registry.get(workspaceId);
    if (!found) fail('missing');
    if (!id(found.path)) fail('unavailable');
    return { id: workspaceId, path: found.path };
  }
  const sessionIds = event => event.kind === 'workspace' ? [event.sessionId] : [...new Set([event.originalParentSessionId, event.successorSessionId, event.workerSessionId].filter(Boolean))];
  async function validateTargets(event, signal) {
    if (event.kind === 'workspace') workspace(event.workspaceId);
    for (const sessionId of sessionIds(event)) {
      const header = await saved(sessionId, signal);
      if (event.kind === 'task' && sessionId === event.workerSessionId && (header.origin !== 'subagent' || header.parentSession !== event.originalParentSessionId)) fail('invalid');
    }
    for (const sessionId of sessionIds(event)) await lifecycle(sessionId, signal);
  }
  const equivalent = (a, b) => a.kind === b.kind && (a.kind === 'workspace' ? a.sessionId === b.sessionId && a.workspaceId === b.workspaceId : ['taskId', 'originalParentSessionId', 'successorSessionId', 'workerSessionId'].every(key => a[key] === b[key]));
  async function execute(signal, action) {
    try {
      check(signal);
      const store = await domain();
      check(signal);
      return await serialize(store, async () => { check(signal); return action(store.table('events')); });
    } catch (error) { return { ok: false, reason: error?.[refusal] ?? 'unavailable' }; }
  }
  async function append(fields, signal) {
    return execute(signal, async table => {
      const refs = current(table);
      const event = placementEventSchema.parse({ v: 1, eventId: randomUUID(), op: 'append', ...fields, at: Date.now() });
      await validateTargets(event, signal);
      const existing = refs.find(ref => equivalent(ref, event));
      if (existing) return { ok: true, event: existing, duplicate: true };
      await validateTargets(event, signal);
      check(signal);
      if (table.get(event.eventId) !== undefined) fail('unavailable');
      await table.put(event.eventId, event);
      return { ok: true, event, duplicate: false };
    });
  }
  return {
    moveSessionReference(sessionId, workspaceId, signal) {
      if (!id(sessionId) || !id(workspaceId)) return Promise.resolve({ ok: false, reason: 'invalid' });
      return append({ kind: 'workspace', sessionId, workspaceId }, signal);
    },
    appendTaskReference(fields, signal) {
      if (!object(fields) || !keysAre(fields, ['taskId', 'originalParentSessionId', 'successorSessionId', 'workerSessionId']) || !id(fields.taskId) || !id(fields.originalParentSessionId) || !(fields.successorSessionId === null || id(fields.successorSessionId)) || !(fields.workerSessionId === null || id(fields.workerSessionId)) || fields.successorSessionId === null && fields.workerSessionId === null) return Promise.resolve({ ok: false, reason: 'invalid' });
      return append({ kind: 'task', ...fields }, signal);
    },
    detachReference(eventId, signal) {
      if (typeof eventId !== 'string' || !uuid.test(eventId)) return Promise.resolve({ ok: false, reason: 'invalid' });
      return execute(signal, async table => {
        const existing = current(table).find(event => event.eventId === eventId);
        if (!existing) fail('missing');
        await validateTargets(existing, signal);
        await validateTargets(existing, signal);
        check(signal);
        const event = placementEventSchema.parse({ v: 1, eventId: randomUUID(), op: 'detach', targetEventId: eventId, at: Date.now() });
        if (table.get(event.eventId) !== undefined) fail('unavailable');
        await table.put(event.eventId, event);
        return { ok: true, event };
      });
    },
    listReferences(signal) {
      return execute(signal, async table => {
        const refs = current(table);
        const references = [];
        for (const event of refs) {
          check(signal);
          const headers = Object.create(null);
          for (const sessionId of sessionIds(event)) {
            try { headers[sessionId] = await saved(sessionId, signal); } catch { headers[sessionId] = null; }
          }
          let target = null;
          if (event.kind === 'workspace') { try { target = workspace(event.workspaceId); } catch {} }
          check(signal);
          const unavailable = Object.values(headers).some(header => !header) || event.kind === 'workspace' && !target || event.kind === 'task' && event.workerSessionId && headers[event.workerSessionId] && (headers[event.workerSessionId].origin !== 'subagent' || headers[event.workerSessionId].parentSession !== event.originalParentSessionId);
          const incomplete = event.kind === 'task' && (!event.successorSessionId || !event.workerSessionId || Boolean(unavailable));
          references.push({ ...event, sourceFolder: headers[event.kind === 'workspace' ? event.sessionId : event.originalParentSessionId]?.cwd ?? null, target, unavailable: Boolean(unavailable), incomplete: Boolean(incomplete), archiveBlock: Boolean(incomplete) });
        }
        return { ok: true, references };
      });
    },
    dispose() { disposed = true; },
  };
}
