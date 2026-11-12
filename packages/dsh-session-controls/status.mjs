import { redactText } from '@dsh-workbench/dsh-governance/redaction';
import { getSessionRole, PRIMARY_ROLES } from '@dsh-workbench/dsh-governance/bindings';
import { resolvePolicy } from '@dsh-workbench/dsh-governance/policy';
import { trackPolicyReader } from '@dsh-workbench/dsh-governance/tracks';

const tracks = { 'dsh-coordinator-off': 'off', 'dsh-coordinator-free': 'free', 'dsh-coordinator-simple': 'simple', 'dsh-coordinator-advanced': 'advanced' };
const safeText = text => typeof text === 'string' ? redactText(text).text.slice(0, 600) : null;
export async function readWorkspaceIndexStatus(ctx, agent, signal) {
  signal?.throwIfAborted();
  const service = ctx.get('dshWorkspaceIndex');
  if (typeof service?.status !== 'function') return { status: 'unavailable' };
  let value;
  try { value = await service.status(agent, signal); }
  catch (error) {
    signal?.throwIfAborted();
    return { status: 'unavailable' };
  }
  signal?.throwIfAborted();
  if (value?.status === 'error' || value?.status === 'corrupt') {
    const result = { status: value.status };
    for (const key of ['reason', 'action', 'root']) if (typeof value[key] === 'string') result[key] = safeText(value[key]);
    return result;
  }
  if (value?.status !== 'ok' || typeof value.indexed !== 'boolean' || typeof value.stale !== 'boolean' ||
      typeof value.dirty !== 'boolean' || typeof value.fingerprintMismatch !== 'boolean') return { status: 'unavailable' };
  return { status: 'ok', ...(value.indexed ? {} : { state: 'ok', label: 'Index: not indexed' }), indexed: value.indexed, stale: value.stale, dirty: value.dirty,
    fingerprintMismatch: value.fingerprintMismatch, lastIndexedAt: value.lastIndexedAt ?? null };
}

/** Reads only the caller's session. Never accepts a file path, opens a domain,
 * invokes a model or returns prompts/tool payloads. */
export function readHarnessStatus(ctx, agent, { isOwner = true } = {}) {
  const sessionId = agent?.session?.id;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('No receiving session');
  const get = name => ctx.get(name);
  const basePreset = get('agentPresets')?.presetForSession?.(agent.session) ?? agent.session?.header?.agentPreset ?? null;
  const activeRole = getSessionRole(sessionId, basePreset);
  const selected = agent.model?.current?.();
  const model = selected ? { provider: safeText(selected.provider), model: safeText(selected.model), effort: safeText(selected.reasoningEffort) } : null;
  const domain = get('storageDomain')?.get?.('dsh_governance_events');
  const tracksDomain = get('storageDomain')?.get?.('dsh_worker_tracks');
  const selection = tracksDomain?.table('selections').get(sessionId);
  if (selection && (selection.sessionId !== sessionId || !['off', 'free', 'simple', 'advanced'].includes(selection.mode) || !Number.isSafeInteger(selection.revision) || selection.revision < 1)) throw new Error('Worker-track state is invalid');

  let effectiveTrack = selection?.mode ?? tracks[activeRole] ?? tracks[basePreset] ?? null;
  let inheritedTrack = null;
  try {
    const policy = resolvePolicy(sessionId, trackPolicyReader(ctx));
    if (policy.state === 'valid') {
      effectiveTrack = policy.mode;
      if (policy.revisions.length > 1 || (policy.revisions.length === 1 && policy.revisions[0][0] !== sessionId)) {
        inheritedTrack = policy.mode;
      }
    }
  } catch { /* fallback to leaf selection/preset */ }

  const decisions = [];
  const counts = { total: 0, blocked: 0, judge: 0, dispatch: 0, check: 0, resource: 0, efficiency: 0, 'mcp-gate': 0, review: 0, redaction: 0 };
  if (domain) {
    for (const [, record] of domain.table('events').entries()) {
      if (record?.session !== sessionId || record.v !== 1) continue;
      const item = {};
      for (const key of ['id', 'kind', 'decision', 'reason', 'reasonCode', 'unit', 'tool', 'seat', 'judge', 'tier', 'requestedTier', 'risk', 'declaredRisk', 'childId']) {
        if (typeof record[key] === 'string') item[key] = safeText(record[key]);
      }
      if (Number.isSafeInteger(record.ts)) item.ts = record.ts;
      decisions.push(item);
      counts.total++;
      if (['refused', 'denied', 'blocked', 'request-denied', 'fail'].includes(item.decision)) counts.blocked++;
      if (Object.hasOwn(counts, item.kind)) counts[item.kind]++;
    }
  }
  decisions.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return {
    schema: 'dsh.ui.status/v1',
    sessionId,
    preset: safeText(activeRole),
    basePreset: safeText(basePreset),
    availableRoles: PRIMARY_ROLES,
    track: effectiveTrack,
    selectedTrack: selection?.mode ?? tracks[activeRole] ?? null,
    inheritedTrack,
    trackRevision: selection?.revision ?? 0,
    model,
    logReady: Boolean(domain),
    counts,
    decisions: decisions.slice(0, 60),
    partial: decisions.length > 60,
    controls: { roleSwitch: Boolean(isOwner), trackSwitch: Boolean(tracksDomain) && Boolean(isOwner) },
    notes: ['Session guard active: track and role controls, decision activity, and secret redaction.'],
  };
}
