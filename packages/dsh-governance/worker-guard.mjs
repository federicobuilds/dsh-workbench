import { randomUUID } from 'node:crypto';
import { admitResolvedWorker, resolvePolicy, WORKER_FAMILIES } from './policy.mjs';
import { trackPolicyReader, selectedTrack, trackDomain } from './tracks.mjs';
import { createEventStore } from './event-store.mjs';
import { canonicalPresetId } from './legacy.mjs';
import { archiveCwdRefusal, readOnlyToolRefusal } from './worker-scope.mjs';

const STATES = ['pending','active','failed'];
const bindingSchema = { parse(raw) {
  if (!raw || raw.v !== 1 || typeof raw.childId !== 'string' || typeof raw.parentId !== 'string'
      || typeof raw.unit !== 'string' || !Object.values(WORKER_FAMILIES).flat().includes(raw.seat)
      || !['free','simple','advanced'].includes(raw.family) || !STATES.includes(raw.status)
      || typeof raw.configRevision !== 'string' || typeof raw.parentPolicy !== 'string'
      || typeof raw.preset !== 'string' || !raw.route || typeof raw.route.provider !== 'string'
      || typeof raw.route.model !== 'string' || !(raw.route.effort === null || typeof raw.route.effort === 'string')) throw new Error('Invalid worker binding');
  if (raw.reviewAttempt !== undefined && (!Number.isSafeInteger(raw.reviewAttempt) || raw.reviewAttempt < 1)) throw new Error('Invalid review attempt');
  if (raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') throw new Error('Invalid read-only worker constraint');
  if (Object.keys(raw).some(key => !['v','childId','parentId','unit','seat','family','status','configRevision','parentPolicy','preset','route','reviewAttempt','readOnly'].includes(key))
      || Object.keys(raw.route).some(key => !['provider','model','effort'].includes(key))) throw new Error('Unknown worker binding field');
  return JSON.parse(JSON.stringify(raw));
} };
export const WORKER_DOMAIN_SPEC = { name: 'dsh_worker_admissions', version: 1, tables: { workers: { valueSchema: bindingSchema } } };
const equalRoute = (a,b) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;

/** The facade alone receives this Host capability. Model arguments cannot
 * reserve/change admissions. Native child identity is fixed before activation.
 * 2026-11-08: Trusted native Host activation and streams are the boundary, not an OS firewall. */
export function createWorkerGuard(ctx, domain, { compactionRoute } = {}) {
  const table = domain?.table('workers');
  let snapshot = null;
  let snapshotProvider = null;
  const pendingIds = new Set();
  const disposeCreation = ctx.on('agent/created', ({ agent }) => {
    const raw = table?.get(agent?.session?.id);
    if (raw && bindingSchema.parse(raw).readOnly) agent.session.append('sandbox/mode', { mode: 'read-only' });
  });
  const disposeTools = ctx.get('tools')?.guard?.(exec => {
    const cwdProblem = archiveCwdRefusal(exec);
    if (cwdProblem) return cwdProblem;
    const raw = table?.get(exec?.agent?.session?.id);
    if (!raw) return undefined;
    let binding;
    try { binding = bindingSchema.parse(raw); } catch { return 'Worker admission is invalid; tool execution is refused.'; }
    if (!binding.readOnly) return undefined;
    const denied = readOnlyToolRefusal(exec);
    if (denied) { void log(exec.agent.session.id, 'worker-readonly-tool-denied', binding); return denied; }
    const sandbox = exec.agent.ctx?.get?.('sandboxPolicy') ?? ctx.get('sandboxPolicy');
    if (sandbox?.resolve?.({ session: exec.agent.session })?.mode !== 'read-only') return 'Read-only worker sandbox is not ready; tool execution is refused.';
    return undefined;
  });
  async function log(sessionId, code, binding) {
    const events = ctx.get('storageDomain')?.get?.('dsh_governance_events');
    if (!events) return;
    const parentId = binding?.parentId ?? ctx.get('sessions')?.get?.(sessionId)?.header?.parentSession;
    for (const receiver of new Set([sessionId, ...(typeof parentId === 'string' ? [parentId] : [])])) {
      try { await createEventStore(events).record({ v:1, id:randomUUID(), ts:Date.now(), kind:'dispatch', session:receiver,
        decision:'request-denied', reason: `Worker model request refused: ${code}.`, reasonCode:code, tool:'model-request', childId:sessionId,
        ...(binding ? { unit:binding.unit, seat:binding.seat } : {}), permissionGranted:false }); } catch { /* refusal still applies */ }
    }
  }
  function check(sessionId, actual, purpose) {
    if (typeof sessionId !== 'string' || !sessionId) return { allowed:true };
    const session = ctx.get('sessions')?.get?.(sessionId) ?? ctx.get('agents')?.get?.(sessionId)?.session;
    const raw = table?.get(sessionId);
    if (!session) return raw ? { denied:'worker-session-unavailable' } : { allowed:true };
    const header = session.header;
    const preset = canonicalPresetId(ctx.get('agentPresets')?.presetForSession?.(session) ?? header?.agentPreset);
    if (header?.origin !== 'subagent') return raw || preset?.startsWith('dsh-worker-') ? { denied:'worker-origin-mismatch' } : { allowed:true };
    let policy;
    try { policy = resolvePolicy(sessionId, trackPolicyReader(ctx)); }
    catch { return { denied:'worker-ancestry-unavailable' }; }
    if (policy.mode === 'off') return { denied:'worker-track-off' };
    // Preserve ordinary DSH subagents (e.g. native `subagent` / `spawn_teammate` with `standard` preset);
    // an explicit `dsh-worker-*` preset or recorded `dsh_dispatch` worker always requires a governed admission.
    if (!raw && !preset?.startsWith('dsh-worker-')) return { allowed:true };
    try { if (snapshotProvider) snapshot = snapshotProvider(); }
    catch { return { denied:'worker-config-unavailable' }; }
    if (!raw || !snapshot) return { denied:'worker-admission-missing' };
    let binding;
    try { binding = bindingSchema.parse(raw); } catch { return { denied:'worker-admission-corrupt' }; }
    if (binding.childId !== sessionId || binding.parentId !== header.parentSession || canonicalPresetId(binding.preset) !== preset
        || binding.status === 'failed' || (binding.status === 'pending' && !pendingIds.has(sessionId))) return { denied:'worker-identity-binding-mismatch', binding };
    if (binding.configRevision !== snapshot.revision || policy.mode !== binding.family) return { denied:'worker-config-or-track-changed', binding };
    let parentPolicy;
    try { parentPolicy = resolvePolicy(binding.parentId, trackPolicyReader(ctx)); }
    catch { return { denied:'worker-parent-policy-unavailable', binding }; }
    if (JSON.stringify(parentPolicy) !== binding.parentPolicy || selectedTrack(trackDomain(ctx), sessionId)) return { denied:'worker-policy-revision-changed', binding };
    if (purpose === 'compaction') {
      return compactionRoute && equalRoute(actual, compactionRoute) ? { allowed:true } : { denied:'worker-compaction-route-mismatch', binding };
    }
    if (purpose !== undefined) return { denied:'worker-auxiliary-purpose-unapproved', binding };
    if (!equalRoute(actual, binding.route)) return { denied:'worker-actual-route-mismatch', binding };
    try { admitResolvedWorker({ snapshot, policy:parentPolicy, seat:binding.seat, actual }); }
    catch { return { denied:'worker-current-seat-refused', binding }; }
    return { allowed:true };
  }
  const disposeStep = ctx.on('agent/pre-step', async (step, next) => {
    const route = step.modelSelection;
    const outcome = check(step.agent.session.id, { provider:route?.provider, model:route?.model, effort:route?.reasoningEffort ?? null });
    if (!outcome.denied) return next();
    await log(step.agent.session.id, outcome.denied, outcome.binding);
    return { kind:'reject' };
  });
  const disposeStream = ctx.on('llm/stream', (options, next) => (async function* () {
    const outcome = check(options.sessionId, { provider:options.provider, model:options.model, effort:options.reasoningEffort ?? null }, options.purpose);
    if (outcome.denied) {
      await log(options.sessionId, outcome.denied, outcome.binding);
      yield { type:'finish', reason:{ kind:'error', failure:{ code:'UNKNOWN', message:`Worker model request refused: ${outcome.denied}.` } } };
      return;
    }
    yield* next();
  })());
  return {
    setSnapshot(value) { snapshot = value; },
    setSnapshotProvider(value) { snapshotProvider = value; if (!value) snapshot = null; },
    async reserve({ childId, parentId, unit, seat, family, preset, route, policy, configRevision, reviewAttempt, readOnly = false }) {
      if (!table) throw new Error('Worker admission store unavailable');
      if (table.get(childId) !== undefined) throw new Error('Worker identity already admitted');
      const value = { v:1, childId, parentId, unit, seat, family, preset, route, configRevision, parentPolicy:JSON.stringify(policy), status:'pending', ...(reviewAttempt === undefined ? {} : { reviewAttempt }), ...(readOnly ? { readOnly: true } : {}) };
      await table.put(childId, bindingSchema.parse(value));
      pendingIds.add(childId);
    },
    async updatePendingRoute(childId, route) {
      if (!table || !pendingIds.has(childId)) throw new Error('Worker admission is not pending');
      if (snapshotProvider) snapshot = snapshotProvider();
      const binding = bindingSchema.parse(table.get(childId));
      const policy = resolvePolicy(binding.parentId, trackPolicyReader(ctx));
      if (binding.status !== 'pending' || binding.configRevision !== snapshot?.revision || binding.family !== policy.mode || binding.parentPolicy !== JSON.stringify(policy)) throw new Error('Worker admission changed');
      admitResolvedWorker({ snapshot, policy, seat: binding.seat, actual: route });
      await table.update(childId, value => {
        if (value.status !== 'pending' || JSON.stringify(value) !== JSON.stringify(binding)) throw new Error('Worker admission changed');
        return bindingSchema.parse({ ...value, route });
      });
    },
    async settle(childId, status) {
      if (!table || !STATES.includes(status)) throw new Error('Worker admission store unavailable');
      try { await table.update(childId, value => bindingSchema.parse({ ...value, status })); }
      finally { pendingIds.delete(childId); }
    },
    bindingFor(childId) { const raw = table?.get(childId); return raw ? bindingSchema.parse(raw) : null; },
    check,
    dispose() { pendingIds.clear(); disposeStep?.(); disposeStream?.(); disposeCreation?.(); disposeTools?.(); },
  };
}
