import { NS, MODES, resolvePolicy } from './policy.mjs';

const PRESET_TRACK = { 'dsh-coordinator-off': 'off', 'dsh-coordinator-free': 'free', 'dsh-coordinator-simple': 'simple', 'dsh-coordinator-advanced': 'advanced' };
const recordSchema = { parse(value) {
  if (!value || typeof value !== 'object' || value.v !== 1 || typeof value.sessionId !== 'string' || !value.sessionId
    || !MODES.includes(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('Invalid worker-track record');
  if (Object.keys(value).some(key => !['v', 'sessionId', 'mode', 'revision'].includes(key))) throw new Error('Unknown worker-track field');
  return Object.freeze({ v: 1, sessionId: value.sessionId, mode: value.mode, revision: value.revision });
} };
export const TRACK_DOMAIN_SPEC = { name: 'dsh_worker_tracks', version: 1, tables: { selections: { valueSchema: recordSchema } } };
const locks = new WeakMap();
export function trackDomain(ctx) { return ctx.get('storageDomain')?.get?.(TRACK_DOMAIN_SPEC.name); }
export function selectedTrack(domain, sessionId) {
  const raw = domain?.table('selections').get(sessionId);
  if (raw === undefined) return null;
  const record = recordSchema.parse(raw);
  if (record.sessionId !== sessionId) throw new Error('Worker-track key/identity mismatch');
  return record;
}

/** Native subagent ancestry only; ordinary seeded forks are independent. Missing
 * ancestry is refused, not silently converted into a root. */
export function trackPolicyReader(ctx, { override } = {}) {
  return sessionId => {
    const session = ctx.get('sessions')?.get?.(sessionId) ?? ctx.get('agents')?.get?.(sessionId)?.session;
    if (!session || session.id !== sessionId || !session.header) throw new Error('Native session ancestry unavailable');
    const header = session.header;
    let parentID = null;
    if (header.origin === 'subagent') {
      if (typeof header.parentSession !== 'string' || !header.parentSession) throw new Error('Subagent creator missing');
      parentID = header.parentSession;
    } // Native origin, not isSeeded/parentSession alone, classifies delegation.
    const record = override?.sessionId === sessionId ? override : selectedTrack(trackDomain(ctx), sessionId);
    const preset = ctx.get('agentPresets')?.presetForSession?.(session) ?? header.agentPreset;
    const mode = record?.mode ?? PRESET_TRACK[preset];
    return Object.freeze({ id: sessionId, parentID,
      metadata: mode ? { [NS]: { v: 1, mode, rev: record ? `dsh-track:${record.revision}` : `dsh-preset:${preset}` } } : undefined });
  };
}

/** Compare-and-set on an owning session. The first-record path also serializes,
 * so two browser windows cannot both commit expected revision zero. */
export async function setTrack(ctx, sessionId, mode, expectedRevision) {
  if (!MODES.includes(mode) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid track/revision');
  const domain = trackDomain(ctx);
  if (!domain) throw new Error('Worker-track store unavailable');
  let perSession = locks.get(domain);
  if (!perSession) { perSession = new Map(); locks.set(domain, perSession); }
  const prior = perSession.get(sessionId) ?? Promise.resolve();
  const action = prior.catch(() => {}).then(async () => {
    const old = selectedTrack(domain, sessionId);
    if ((old?.revision ?? 0) !== expectedRevision) throw new Error('Worker track changed in another window; refresh and retry');
    const next = { v: 1, sessionId, mode, revision: expectedRevision + 1 };
    // Check the receiving session and all currently resolvable real ancestors.
    const effective = resolvePolicy(sessionId, trackPolicyReader(ctx, { override: next }));
    if (effective.state !== 'valid') throw new Error('Worker track is not resolvable');
    if (mode !== 'off' && effective.mode === 'off') throw new Error('Ancestor worker track is Off');
    await domain.table('selections').put(sessionId, next);
    return selectedTrack(domain, sessionId);
  });
  perSession.set(sessionId, action);
  try { return await action; }
  finally { if (perSession.get(sessionId) === action) perSession.delete(sessionId); }
}
