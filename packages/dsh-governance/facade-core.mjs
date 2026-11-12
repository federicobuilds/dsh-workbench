/** DSH governance facade — DSH Host plugin.
 *
 * Wires the tested governance-core policy predicates and the SystemOne judge
 * client into real coordinator delegation: two coordinator-only tools
 * (dsh_dispatch, dsh_review), durable review-floor state on ctx.storageDomain,
 * and a monotonic denial guard for the dispatch tool family.
 *
 * Trust seams (session reader, judge operation authorization, optional judge
 * transport) are injected by trusted Host JavaScript only; defaults fail closed:
 * no reader -> ancestry refused; no authorization -> judge refuses before any
 * network work. Tool arguments can never supply these seams.
 *
 * Scope: delegation + review floors + route guard. No universal outbound
 * firewall, no check evidence, no resource ledger, no memory publication.
 */
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  NS, WORKER_FAMILIES, TIER_SEATS,
  normalizeConfig, resolvePolicy, admitWorker, admitResolvedWorker, workerAliasRoutes, parseDispatchBrief,
  emptyReviewState, requiredReviewTier, reduceAdmission, reviewVerdict,
} from './policy.mjs';
import { createJudgeClient } from './judge.mjs';
import { buildRosterConfigDTO } from './config-dto.mjs';
import { REVIEW_DOMAIN_SPEC, createReviewStore } from './review-store.mjs';
import { decisionEvent, recordDecision, withLogOutcome } from './decision-events.mjs';
import { trackPolicyReader } from './tracks.mjs';
import { getSessionRole, roleModelOverrides, selectionFor, unknownModel } from './bindings.mjs';
import { applyModelOverrides } from './model-overrides.mjs';
import { ownedWorker, deriveSessionMessages, publicMessage } from './worker-messages.mjs';
import { canonicalPresetId } from './legacy.mjs';
import { briefIsReadOnly, nativeWorkingDirectory } from './worker-scope.mjs';

export const name = 'dsh-governance-facade';
// Only `tools` is required at activation. Runtime services (agents, agentPresets,
// subagents, storageDomain) are resolved from the Host context when a dispatch or
// review actually runs; every access is guarded and fails closed if unavailable.
export const inject = ['tools'];

export const COORDINATOR_PRESETS = Object.freeze([
  'dsh-coordinator-off', 'dsh-coordinator-free', 'dsh-coordinator-simple', 'dsh-coordinator-advanced',
  'dsh-agent-orchestrator-custom',
]);
/** DSH coordinator preset -> DSH lane family. The coordinator's preset is the
 *  source of the selected family in DSH (DSH stored it in session metadata). */
export const COORDINATOR_FAMILY = Object.freeze({
  'dsh-coordinator-off': 'off',
  'dsh-coordinator-free': 'free',
  'dsh-coordinator-simple': 'simple',
  'dsh-coordinator-advanced': 'advanced',
});
const DISPATCH_TOOL_RE = /^dsh_dispatch(?:[-_.].*)?$/;
const UNIT_RE = /^[A-Z0-9][\w.-]*$/;
const BRIEF_LIMIT = 12000;
const DEFAULT_ROSTER = new URL('./role-roster.example.json', import.meta.url);
const DEFAULT_WORKER_PATTERNS = new URL('./worker-patterns.json', import.meta.url);
const RECEIPT_SCHEMA = 'dsh.dispatch-receipt/v1';
const REVIEW_RECEIPT_SCHEMA = 'dsh.review-receipt/v1';
const reviewDomains = new WeakMap();

export async function resolveWorkerSelection(routes, start, resolveModelInfo) {
  for (let index = start; index < routes.length; index++) {
    const route = routes[index];
    try {
      const selection = await selectionFor({ target: `${route.provider}/${route.model}`, variant: route.effort }, resolveModelInfo);
      return { index, route, selection };
    } catch (error) {
      if (!unknownModel(error) || index === routes.length - 1) throw error;
    }
  }
  throw new Error('No worker model candidate');
}

async function acquireReviewDomain(facility) {
  let lease = reviewDomains.get(facility);
  if (lease?.closing) { await lease.closing; return acquireReviewDomain(facility); }
  if (!lease) {
    lease = { users: 0, owned: false };
    lease.promise = (async () => {
      const existing = facility.get?.(REVIEW_DOMAIN_SPEC.name);
      if (existing) return existing;
      const domain = await facility.open(REVIEW_DOMAIN_SPEC);
      lease.owned = true;
      return domain;
    })();
    reviewDomains.set(facility, lease);
  }
  lease.users++;
  try { return { lease, domain: await lease.promise }; }
  catch (error) { if (--lease.users === 0 && reviewDomains.get(facility) === lease) reviewDomains.delete(facility); throw error; }
}

async function releaseReviewDomain(facility, lease) {
  if (--lease.users !== 0) return;
  if (!lease.owned) { reviewDomains.delete(facility); return; }
  lease.closing = (async () => { await (await lease.promise).close?.(); })();
  try { await lease.closing; }
  finally { if (reviewDomains.get(facility) === lease) reviewDomains.delete(facility); }
}

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (v) => typeof v === 'string' && v.trim().length > 0 && v === v.trim();
const refusal = (schema, reason, extra = {}) => Object.freeze({ schema, status: 'refused', reason, delegated: false, permissionGranted: false, ...extra });
/** Resolve a Host service whether it is injected as a ctx property or reachable
 *  only through ctx.get. Returns undefined when absent so callers fail closed.
 *  ctx is a Cordis Context instance (not a plain object), so only null-check it. */
const svc = (ctx, name) => {
  if (ctx === undefined || ctx === null) return undefined;
  if (typeof ctx.get === 'function') return ctx.get(name);
  return ctx[name];
};

/** Seat -> worker-pattern role. Mirrors the governance-core role derivation;
 * deep-researcher rides the researcher pattern. Explore has no reviewed pattern.
 */
export function patternRoleOfSeat(seat) {
  const role = seat.replace(/-(cheap|max|strong)$/, '').replace(/-(s|f)$/, '');
  return role === 'deep-researcher' ? 'researcher' : role === 'explore' ? 'auditor' : role;
}

const readJsonFile = async (path, label) => {
  const raw = await readFile(typeof path === 'string' ? path : path, { encoding: 'utf8' });
  const value = JSON.parse(raw);
  if (!object(value) && !Array.isArray(value)) throw new Error(`${label} must contain JSON`);
  return value;
};

async function loadWorkerPatterns(path) {
  const doc = await readJsonFile(path, 'worker-patterns');
  if (doc.schema !== 'dsh-functional-worker-patterns/v1' || !Array.isArray(doc.patterns)) throw new Error('worker-patterns schema mismatch');
  const map = new Map();
  for (const pattern of doc.patterns) {
    if (!object(pattern) || !text(pattern.role) || !text(pattern.plannedPresetId)) throw new Error('invalid worker pattern entry');
    if (map.has(pattern.role)) throw new Error(`duplicate worker pattern role ${pattern.role}`);
    map.set(pattern.role, pattern.plannedPresetId);
  }
  if (map.size === 0) throw new Error('worker-patterns has no patterns');
  return map;
}

function workerPrompt(brief, seat, family, decision) {
  const lines = [
    `DSH governed dispatch. Unit ${brief.unit}. Seat ${seat}. Family ${family}.`,
    `Judge evidence: tier ${decision.tier}; declared risk ${decision.declaredRisk}; judge risk ${decision.risk}. Judge evidence is not human permission.`,
    'You cannot read the coordinator conversation; this brief is complete and self-contained.',
    '',
    `UNIT: ${brief.unit}`,
    `OBJECTIVE: ${brief.objective}`,
    `SCOPE: ${brief.scope}`,
    `ACCEPTANCE: ${brief.acceptance}`,
    `RISK: ${brief.risk}`,
    `CHANGES: ${brief.changes}`,
  ];
  for (const field of ['constraints', 'evidence', 'remaining_work']) {
    if (brief[field] !== undefined) lines.push(`${field.toUpperCase()}: ${brief[field]}`);
  }
  return lines.join('\n');
}

/** Build the facade from trusted injections. Every omitted seam fails closed. */
export function createGovernanceFacade(injections = {}) {
  if (!object(injections)) throw new Error('governance-facade: injections must be a plain object');
  const coordinatorDefaultOnStandard = injections.coordinatorDefaultOnStandard === true;
  const isCoordinatorPreset = preset => COORDINATOR_PRESETS.includes(preset) || (coordinatorDefaultOnStandard && preset === 'standard');
  const readSession = injections.readSession !== undefined ? injections.readSession
    : () => { throw new Error('no trusted session reader installed'); };
  const authorizeOperation = injections.authorizeOperation !== undefined ? injections.authorizeOperation : () => false;
  if (typeof readSession !== 'function' || typeof authorizeOperation !== 'function'
    || (injections.judgeTransport !== undefined && typeof injections.judgeTransport !== 'function')
    || (injections.judgeTimeoutMs !== undefined && (!Number.isInteger(injections.judgeTimeoutMs) || injections.judgeTimeoutMs < 1 || injections.judgeTimeoutMs > 80000))
    || (injections.roster !== undefined && !object(injections.roster))
    || (injections.rosterPath !== undefined && typeof injections.rosterPath !== 'string')
    || (injections.effortVocabulary !== undefined && injections.effortVocabulary !== null
      && (!Array.isArray(injections.effortVocabulary) || !injections.effortVocabulary.every(text)))) {
    throw new Error('governance-facade: invalid trusted injection');
  }

  async function apply(ctx) {
    const tools = svc(ctx, 'tools');
    if (!tools || typeof tools.register !== 'function') {
      throw new Error('governance-facade: ctx.tools registry is required');
    }
    const decisionStore = injections.decisionStore ?? null;
    const requireDecisionLog = injections.requireDecisionLog === true;
    const state = { ready: false, reasons: [], snapshot: null, patterns: null, judge: null, store: null, domain: null, domainFacility: null, domainLease: null, readSession };
    const warn = (message) => { try { ctx.logger?.warn?.(`dsh-governance-facade: ${message}`); } catch { /* logging is best-effort */ } };

    let sourceRoster;
    let lastOverrides;
    const currentSnapshot = () => {
      const overrides = roleModelOverrides(ctx);
      if (state.snapshot && overrides === lastOverrides) return state.snapshot;
      const roster = overrides ? applyModelOverrides(sourceRoster, {}, overrides.config).roster : sourceRoster;
      const dto = buildRosterConfigDTO(roster, { revision: injections.configRevision });
      if (injections.effortVocabulary !== undefined) {
        if (injections.effortVocabulary === null) delete dto.efforts;
        else dto.efforts = [...injections.effortVocabulary];
      }
      if (overrides) dto.revision = overrides.revision;
      const snapshot = normalizeConfig(dto);
      state.snapshot = snapshot;
      lastOverrides = overrides;
      injections.workerGuard?.setSnapshot?.(snapshot);
      return snapshot;
    };
    // 1. Trusted normalized config snapshot from the reviewed roster whitelist.
    try {
      sourceRoster = injections.roster
        ?? await readJsonFile(injections.rosterPath ?? DEFAULT_ROSTER, 'role roster');
      currentSnapshot();
      injections.workerGuard?.setSnapshotProvider?.(currentSnapshot);
    } catch (error) { state.reasons.push('config-snapshot-unavailable'); warn(`config snapshot refused: ${error?.message}`); }

    // 2. Worker preset map from the reviewed worker patterns.
    try { state.patterns = await loadWorkerPatterns(injections.workerPatternsPath ?? DEFAULT_WORKER_PATTERNS); }
    catch (error) { state.reasons.push('worker-patterns-unavailable'); warn(`worker patterns refused: ${error?.message}`); }

    // 3. Judge client: authorization seam is injected, default deny.
    try {
      state.judge = createJudgeClient({
        ...(injections.judgeTransport !== undefined ? { transport: injections.judgeTransport } : {}),
        authorizeOperation,
        ...(injections.judgeTimeoutMs !== undefined ? { timeoutMs: injections.judgeTimeoutMs } : {}),
      });
    } catch (error) { state.reasons.push('judge-unavailable'); warn(`judge client refused: ${error?.message}`); }

    // 4. Durable review-floor aggregates. Missing/corrupt state fails closed.
    try {
      const storageDomain = svc(ctx, 'storageDomain');
      if (!storageDomain || typeof storageDomain.open !== 'function') throw new Error('ctx.storageDomain unavailable');
      const acquired = await acquireReviewDomain(storageDomain);
      state.domain = acquired.domain;
      state.domainFacility = storageDomain;
      state.domainLease = acquired.lease;
      state.store = createReviewStore(state.domain);
      state.store.readState(); // validate stored aggregates before admitting anything
    } catch (error) { state.reasons.push('durable-state-unavailable'); warn(`durable review state refused: ${error?.message}`); state.store = null; }

    state.ready = Boolean(state.snapshot && state.patterns && state.judge && state.store);
    if (!state.ready) warn(`governance NOT ready (${state.reasons.join(', ') || 'unknown'}); tools register fail-closed`);

    const coordinatorPresetOf = (session) => {
      try { return canonicalPresetId(getSessionRole(session?.id, svc(ctx, 'agentPresets')?.presetForSession?.(session) ?? session?.header?.agentPreset ?? null)); } catch { return null; }
    };
    const whenCoordinator = ({ agent } = {}) => {
      try { return Boolean(agent?.session) && isCoordinatorPreset(coordinatorPresetOf(agent.session)); }
      catch { return false; }
    };
    const requireCoordinator = (exec) => {
      const agent = exec?.agent;
      if (!agent || typeof agent.id !== 'string' || !agent.session || typeof agent.session.id !== 'string') return 'no-agent-context';
      if (!isCoordinatorPreset(coordinatorPresetOf(agent.session))) return 'caller-not-coordinator';
      return null;
    };

    async function dispatch(args, exec) {
      try {
        if (requireDecisionLog && (!decisionStore || typeof decisionStore.record !== 'function')) return refusal(RECEIPT_SCHEMA, 'decision-log-unavailable');
        if (!state.ready) return refusal(RECEIPT_SCHEMA, 'governance-unavailable', { components: [...state.reasons] });
        const admissionRevision = currentSnapshot().revision;
        const denied = requireCoordinator(exec);
        if (denied) return refusal(RECEIPT_SCHEMA, denied);
        if (exec.signal?.aborted) return refusal(RECEIPT_SCHEMA, 'canceled');
        if (typeof args?.brief !== 'string' || args.brief.length === 0 || args.brief.length > BRIEF_LIMIT
          || typeof args?.seat !== 'string' || !Object.values(WORKER_FAMILIES).some((family) => family.includes(args.seat))) {
          return refusal(RECEIPT_SCHEMA, 'invalid-input');
        }

        let brief;
        try { brief = parseDispatchBrief(args.brief); }
        catch (error) { return refusal(RECEIPT_SCHEMA, 'brief-refused', { detail: String(error?.message ?? error) }); }

        const readOnly = briefIsReadOnly(brief) || /^(?:auditor|reviewer|critic|explore)(?:-|$)/.test(args.seat);
        let cwd;
        try {
          const directory = svc(ctx, 'workingDirectory');
          const proposed = typeof directory?.ensure === 'function'
            ? await directory.ensure(exec.agent, exec.signal)
            : directory?.get?.(exec.agent.session) ?? exec.agent.session.header?.cwd;
          cwd = await (injections.nativeWorkingDirectory ?? nativeWorkingDirectory)(proposed);
        } catch (error) {
          return refusal(RECEIPT_SCHEMA, 'invalid-working-directory', { detail: String(error?.message ?? error) });
        }
        if (readOnly && typeof svc(ctx, 'sandboxPolicy')?.resolve !== 'function') return refusal(RECEIPT_SCHEMA, 'read-only-sandbox-unavailable');

        let policy;
        try { policy = resolvePolicy(exec.agent.session.id, state.readSession); }
        catch (error) { return refusal(RECEIPT_SCHEMA, 'ancestry-refused', { detail: String(error?.message ?? error) }); }
        if (policy.state !== 'valid') return refusal(RECEIPT_SCHEMA, 'no-selected-family');
        if (policy.mode === 'off') return refusal(RECEIPT_SCHEMA, 'worker-access-off');
        if (!WORKER_FAMILIES[policy.mode].includes(args.seat)) return refusal(RECEIPT_SCHEMA, 'seat-outside-selected-family', { family: policy.mode });

        let admission;
        try { admission = admitWorker({ snapshot: state.snapshot, policy, seat: args.seat }); }
        catch (error) { return refusal(RECEIPT_SCHEMA, 'route-admission-refused', { detail: String(error?.message ?? error) }); }

        const patternRole = patternRoleOfSeat(args.seat);
        const workerPreset = state.patterns.get(patternRole);
        if (!workerPreset) return refusal(RECEIPT_SCHEMA, 'no-worker-preset', { role: patternRole });
        const subagents = svc(ctx, 'subagents');
        const presets = svc(ctx, 'agentPresets');
        const llm = svc(ctx, 'llm');
        const backend = subagents?.getProvider?.('spawn');
        if (!injections.workerGuard || typeof subagents?.startActivation !== 'function' || !backend?.prepareContinuable
          || backend.inheritsParentContext || !backend.capabilities?.agentPreset || !backend.capabilities?.agentOptions) {
          return refusal(RECEIPT_SCHEMA, 'delegation-unavailable');
        }
        let resolved, routes;
        try {
          const registered = await presets.resolve(workerPreset);
          if (registered.id !== workerPreset || registered.broken) throw new Error('worker preset is unavailable');
          routes = [admission.route, ...workerAliasRoutes({ snapshot: state.snapshot, policy, seat: args.seat })];
          resolved = await resolveWorkerSelection(routes, 0, (provider, model) => llm.resolveModelInfo(provider, model, exec.signal));
        } catch (error) { return refusal(RECEIPT_SCHEMA, 'route-verification-refused', { detail: String(error?.message ?? error) }); }

        let reviewState;
        try { reviewState = state.store.readState(); }
        catch (error) { return refusal(RECEIPT_SCHEMA, 'durable-state-unavailable', { detail: String(error?.message ?? error) }); }

        const tierBinding = TIER_SEATS[args.seat];
        const isTierSeat = tierBinding?.[0] === 'tier';
        const isCheckedSeat = Boolean(tierBinding);
        const admissionId = randomUUID();
        let nextState = reviewState;
        if (isTierSeat) {
          try { nextState = reduceAdmission(reviewState, { id: admissionId, unit: brief.unit, seat: args.seat }); }
          catch (error) { return refusal(RECEIPT_SCHEMA, 'review-floor-refused', { detail: String(error?.message ?? error) }); }
        }
        const entry = reviewState.units[brief.unit];
        if (patternRole === 'reviewer' && (!entry || entry.family !== policy.mode || state.store.ownerOf(brief.unit) !== exec.agent.session.id || !injections.workerGuard)) {
          return refusal(RECEIPT_SCHEMA, 'review-binding-unavailable');
        }
        const reviewHistory = isTierSeat && entry
          ? { current: entry.tier, failed_reviews: entry.failed_reviews, floor: entry.floor } : undefined;

        const decision = await state.judge.decide(
          { family: policy.mode, brief: args.brief, ...(isCheckedSeat ? { seat: args.seat } : {}) },
          { ...(exec.signal ? { signal: exec.signal } : {}), ...(reviewHistory ? { reviewHistory } : {}) },
        );
        const judgeRecorded = await recordDecision(decisionStore, decisionEvent('judge', exec,
          decision ?? { status: 'refused', reason: 'unknown-decision' }, { unit: brief.unit, seat: args.seat }));
        if (requireDecisionLog && !judgeRecorded) return refusal(RECEIPT_SCHEMA, 'decision-log-write-failed');
        if (!decision || decision.status !== 'decision') {
          return refusal(RECEIPT_SCHEMA, 'judge-refused', {
            judge: decision ? { status: decision.status, reason: decision.reason, unavailable: decision.unavailable ?? false } : null,
          });
        }
        if (isCheckedSeat && !(decision.requiredDecisionSatisfied && decision.seat === args.seat && decision.tier === tierBinding[1])) {
          return refusal(RECEIPT_SCHEMA, 'judge-decision-incomplete');
        }
        if (exec.signal?.aborted) return refusal(RECEIPT_SCHEMA, 'canceled');

        if (isTierSeat) {
          try { nextState = await state.store.applyAdmission({ id: admissionId, unit: brief.unit, seat: args.seat, owner: exec.agent.session.id }); }
          catch (error) { return refusal(RECEIPT_SCHEMA, 'durable-admission-refused', { detail: String(error?.message ?? error) }); }
        }

        const boundEntry = state.store.readState().units[brief.unit];
        if ((isCheckedSeat || patternRole === 'reviewer') && (!boundEntry || state.store.ownerOf(brief.unit) !== exec.agent.session.id
          || boundEntry.family !== policy.mode || (isTierSeat && boundEntry.attempt !== nextState.units[brief.unit]?.attempt)
          || (patternRole === 'reviewer' && boundEntry.attempt !== entry.attempt))) return refusal(RECEIPT_SCHEMA, 'review-binding-changed');
        const childId = randomUUID();
        const spec = {
          provider: 'spawn', childId, label: `${args.seat}:${brief.unit}`, delivery: 'parent',
          request: {
            parent: exec.agent,
            cwd,
            prompt: [{ type: 'text', text: workerPrompt(brief, args.seat, policy.mode, decision) }],
            agentPreset: workerPreset,
            agentOptions: { ...resolved.selection, reasoningEffort: resolved.selection.reasoningEffort },
          },
          signal: exec.signal ?? new AbortController().signal,
        };
        // A human can change the track while the judge/storage awaits. Recheck
        // the exact revision/ancestor snapshot immediately before activation.
        let currentPolicy;
        try { currentPolicy = resolvePolicy(exec.agent.session.id, readSession); }
        catch { return refusal(RECEIPT_SCHEMA, 'ancestry-refused'); }
        if (JSON.stringify(currentPolicy) !== JSON.stringify(policy)) return refusal(RECEIPT_SCHEMA, 'track-changed-during-admission');
        const reservedChildId = childId;
        if (currentSnapshot().revision !== admissionRevision) return refusal(RECEIPT_SCHEMA, 'config-changed-during-admission');
        {
          try { await injections.workerGuard.reserve({ childId:reservedChildId, parentId:exec.agent.session.id, unit:brief.unit, seat:args.seat,
            family:policy.mode, preset:workerPreset, route:resolved.route, policy, configRevision:state.snapshot.revision, readOnly,
            ...((isCheckedSeat || patternRole === 'reviewer') ? { reviewAttempt:boundEntry.attempt } : {}) }); }
          catch { return refusal(RECEIPT_SCHEMA, 'worker-binding-unavailable'); }
        }
        const lastPolicy = resolvePolicy(exec.agent.session.id, readSession);
        const lastEntry = state.store.readState().units[brief.unit];
        if (JSON.stringify(lastPolicy) !== JSON.stringify(policy) || (boundEntry && (lastEntry?.attempt !== boundEntry.attempt
          || lastEntry?.floor !== boundEntry.floor || lastEntry?.reviewed_attempt !== boundEntry.reviewed_attempt
          || lastEntry?.role !== boundEntry.role || lastEntry?.tier !== boundEntry.tier || lastEntry?.family !== boundEntry.family
          || state.store.ownerOf(brief.unit) !== exec.agent.session.id))) {
          await injections.workerGuard.settle(reservedChildId, 'failed');
          return refusal(RECEIPT_SCHEMA, 'binding-changed-during-admission');
        }
        let activation;
        for (;;) {
          try { activation = await subagents.startActivation(spec); break; }
          catch (error) {
            try {
              if (!unknownModel(error) || resolved.index + 1 >= routes.length || typeof injections.workerGuard.updatePendingRoute !== 'function') throw error;
              if (exec.signal?.aborted || currentSnapshot().revision !== admissionRevision
                || JSON.stringify(resolvePolicy(exec.agent.session.id, readSession)) !== JSON.stringify(policy)
                || JSON.stringify(state.store.readState().units[brief.unit]) !== JSON.stringify(boundEntry)
                || (boundEntry && state.store.ownerOf(brief.unit) !== exec.agent.session.id)) throw new Error('Worker admission changed during activation');
              const next = await resolveWorkerSelection(routes, resolved.index + 1, (provider, model) => llm.resolveModelInfo(provider, model, exec.signal));
              if (exec.signal?.aborted || currentSnapshot().revision !== admissionRevision
                || JSON.stringify(resolvePolicy(exec.agent.session.id, readSession)) !== JSON.stringify(policy)
                || JSON.stringify(state.store.readState().units[brief.unit]) !== JSON.stringify(boundEntry)
                || (boundEntry && state.store.ownerOf(brief.unit) !== exec.agent.session.id)) throw new Error('Worker admission changed during activation');
              await injections.workerGuard.updatePendingRoute(reservedChildId, next.route);
              resolved = next;
              spec.request.agentOptions = { ...resolved.selection, reasoningEffort: resolved.selection.reasoningEffort };
            } catch (failure) {
              if (reservedChildId) try { await injections.workerGuard.settle(reservedChildId, 'failed'); } catch { /* model guard remains fail-closed on unavailable state */ }
              return refusal(RECEIPT_SCHEMA, 'activation-refused', { detail: String(failure?.message ?? failure), admissionRecorded: isTierSeat });
            }
          }
        }
        if (reservedChildId && activation?.childId !== reservedChildId) {
          try { await activation?.dispose?.(); await injections.workerGuard.settle(reservedChildId, 'failed'); } catch { /* exact native handle only */ }
          return refusal(RECEIPT_SCHEMA, 'worker-identity-mismatch');
        }
        let bindingRecorded = false;
        if (reservedChildId) {
          try { await injections.workerGuard.settle(reservedChildId, 'active'); bindingRecorded = true; } catch { /* pending binding stays guarded; diagnostic is explicit */ }
        }

        const unitState = nextState.units[brief.unit];
        return Object.freeze({
          schema: RECEIPT_SCHEMA, status: 'dispatched', delegated: true, permissionGranted: false,
          unit: brief.unit, seat: args.seat, family: policy.mode, role: patternRole,
          workerPreset, childId: activation?.childId ?? null,
          workerBinding: reservedChildId ? (bindingRecorded ? 'active' : 'pending-finalization') : 'not-installed',
          route: { provider: resolved.route.provider, model: resolved.route.model, effort: resolved.route.effort },
          judge: { tier: decision.tier, risk: decision.risk, declaredRisk: decision.declaredRisk },
          admission: isTierSeat
            ? { id: admissionId, attempt: unitState.attempt, floor: unitState.floor, requiredReviewTier: requiredReviewTier(nextState, brief.unit) }
            : { recorded: false, reason: 'review floors track tier-checked worker seats only' },
        });
      } catch (error) { return refusal(RECEIPT_SCHEMA, 'internal-refusal', { detail: String(error?.message ?? error) }); }
    }

    async function resume(args, exec) {
      let observation;
      try {
        if (!state.ready || !injections.workerGuard) return refusal(RECEIPT_SCHEMA, 'governance-unavailable');
        currentSnapshot();
        const denied = requireCoordinator(exec);
        if (denied) return refusal(RECEIPT_SCHEMA, denied);
        if (!text(args?.child_id) || !text(args?.unit) || !text(args?.seat) || !text(args?.followup)
          || args.followup.length > BRIEF_LIMIT) return refusal(RECEIPT_SCHEMA, 'invalid-input');
        if (exec.signal?.aborted) return refusal(RECEIPT_SCHEMA, 'canceled');
        const binding = injections.workerGuard.bindingFor(args.child_id);
        const bindingSnapshot = JSON.stringify(binding);
        const reviewState = state.store.readState();
        const entry = reviewState.units[args.unit];
        const policy = resolvePolicy(exec.agent.session.id, readSession);
        if (!binding || binding.status !== 'active' || binding.parentId !== exec.agent.session.id
          || binding.childId !== args.child_id || binding.unit !== args.unit || binding.seat !== args.seat
          || !entry || binding.reviewAttempt !== entry.attempt || entry.family !== binding.family
          || state.store.ownerOf(args.unit) !== exec.agent.session.id || policy.state !== 'valid'
          || policy.mode !== binding.family || JSON.stringify(policy) !== binding.parentPolicy
          || binding.configRevision !== state.snapshot.revision || state.patterns.get(patternRoleOfSeat(binding.seat)) !== canonicalPresetId(binding.preset)) {
          return refusal(RECEIPT_SCHEMA, 'resume-binding-refused');
        }
        const tier = TIER_SEATS[binding.seat];
        if (tier?.[0] === 'tier' && (entry.role !== patternRoleOfSeat(binding.seat) || entry.tier !== tier[1]
          || ['cheap', 'default', 'max'].indexOf(entry.tier) < ['cheap', 'default', 'max'].indexOf(requiredReviewTier(reviewState, args.unit))
          || entry.reviewed_attempt >= entry.attempt)) return refusal(RECEIPT_SCHEMA, 'resume-review-floor-refused');
        const admitted = admitResolvedWorker({ snapshot: state.snapshot, policy, seat: binding.seat, actual: binding.route });
        const registered = await svc(ctx, 'agentPresets').resolve(binding.preset);
        if (registered.id !== binding.preset || registered.broken) return refusal(RECEIPT_SCHEMA, 'resume-preset-refused');
        await selectionFor({ target: `${admitted.route.provider}/${admitted.route.model}`, variant: admitted.route.effort },
          (provider, model) => svc(ctx, 'llm').resolveModelInfo(provider, model, exec.signal));
        observation = await svc(ctx, 'sessionQuery').observeSession(args.child_id, { signal: exec.signal });
        const descriptors = observation.events.slice(observation.inheritedEventCount).filter(event => event.type === 'subagent/descriptor');
        const descriptor = descriptors[0]?.data;
        const values = observation.projections?.values;
        const live = svc(ctx, 'agents')?.get?.(args.child_id);
        const selected = live?.model?.current?.() ?? values?.modelSelection?.next ?? {
          provider: descriptor?.agentProvider, model: descriptor?.agentModel, reasoningEffort: descriptor?.agentReasoningEffort,
        };
        if (observation.header?.origin !== 'subagent' || observation.header.parentSession !== exec.agent.session.id
          || descriptors.length !== 1 || descriptor?.version !== 3 || descriptor.mode !== 'continuable' || descriptor.provider !== 'spawn'
          || canonicalPresetId(values?.agentPreset) !== canonicalPresetId(binding.preset) || selected?.provider !== binding.route.provider
          || selected?.model !== binding.route.model || (selected?.reasoningEffort ?? null) !== binding.route.effort) {
          return refusal(RECEIPT_SCHEMA, 'resume-restored-route-refused');
        }
        const current = state.store.readState().units[args.unit];
        if (current?.attempt !== entry.attempt || current?.floor !== entry.floor || current?.reviewed_attempt !== entry.reviewed_attempt
          || state.store.ownerOf(args.unit) !== exec.agent.session.id
          || JSON.stringify(injections.workerGuard.bindingFor(args.child_id)) !== bindingSnapshot
          || JSON.stringify(resolvePolicy(exec.agent.session.id, readSession)) !== binding.parentPolicy) {
          return refusal(RECEIPT_SCHEMA, 'resume-binding-changed');
        }
        const subagents = svc(ctx, 'subagents');
        if (typeof subagents?.prompt !== 'function') return refusal(RECEIPT_SCHEMA, 'continuation-unavailable');
        const requestId = randomUUID();
        const result = await subagents.prompt({ requestId, parentSessionId: exec.agent.session.id, childSessionId: args.child_id,
          mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: args.followup }] }, exec.signal);
        return Object.freeze({ schema: RECEIPT_SCHEMA, status: 'continued', childId: args.child_id, requestId, messageId: result.messageId,
          unit: args.unit, attempt: entry.attempt, permissionGranted: false });
      } catch (error) { return refusal(RECEIPT_SCHEMA, 'resume-refused', { detail: String(error?.message ?? error) }); }
      finally { observation?.[Symbol.dispose]?.(); }
    }

    async function review(args, exec) {
      try {
        if (!state.store) return refusal(REVIEW_RECEIPT_SCHEMA, 'durable-state-unavailable', { components: [...state.reasons] });
        const denied = requireCoordinator(exec);
        if (denied) return refusal(REVIEW_RECEIPT_SCHEMA, denied);
        if (typeof args?.unit !== 'string' || !UNIT_RE.test(args.unit) || typeof args?.reviewer_id !== 'string' || !args.reviewer_id) {
          return refusal(REVIEW_RECEIPT_SCHEMA, 'invalid-input');
        }

        let reviewState;
        try { reviewState = state.store.readState(); }
        catch (error) { return refusal(REVIEW_RECEIPT_SCHEMA, 'durable-state-unavailable', { detail: String(error?.message ?? error) }); }
        const entry = reviewState.units[args.unit];
        if (!entry) return refusal(REVIEW_RECEIPT_SCHEMA, 'no-admission-for-unit', { unit: args.unit });
        if (state.store.ownerOf(args.unit) !== exec.agent.session.id) return refusal(REVIEW_RECEIPT_SCHEMA, 'unit-owner-refused');
        let worker, binding, output;
        try {
          worker = ownedWorker(ctx, exec.agent.session.id, args.reviewer_id);
          binding = injections.workerGuard?.bindingFor(args.reviewer_id);
          const preset = canonicalPresetId(svc(ctx, 'agentPresets')?.presetForSession?.(worker) ?? worker.header?.agentPreset);
          if (!binding || binding.status !== 'active' || binding.childId !== worker.id || binding.parentId !== worker.header.parentSession
            || canonicalPresetId(binding.preset) !== preset || patternRoleOfSeat(binding.seat) !== 'reviewer' || binding.unit !== args.unit
            || binding.family !== entry.family || binding.reviewAttempt !== entry.attempt) return refusal(REVIEW_RECEIPT_SCHEMA, 'reviewer-binding-refused');
          const messages = deriveSessionMessages(worker, worker.id);
          const last = messages.filter(message => (message?.info?.role ?? message?.role) === 'assistant').at(-1);
          const publicOutput = last ? JSON.parse(publicMessage(last)) : null;
          if (publicOutput?.error) return refusal(REVIEW_RECEIPT_SCHEMA, 'reviewer-output-unavailable');
          output = publicOutput?.parts?.filter(part => part.type === 'text').map(part => part.text).join('\n');
        } catch { return refusal(REVIEW_RECEIPT_SCHEMA, 'reviewer-ownership-refused'); }
        if (reviewVerdict(output, args.unit) === undefined) return refusal(REVIEW_RECEIPT_SCHEMA, 'invalid-review-text');
        const id = createHash('sha256').update(`${args.unit}\u0000${entry.attempt}\u0000${args.reviewer_id}`).digest('hex');
        let outcome;
        try {
          outcome = await state.store.applyReview({ id, unit: args.unit, owner: exec.agent.session.id, family: entry.family, role: entry.role, tier: entry.tier, attempt: binding.reviewAttempt, raw: output });
        } catch (error) { return refusal(REVIEW_RECEIPT_SCHEMA, 'durable-review-refused', { detail: String(error?.message ?? error) }); }

        const unit = outcome.next.units[args.unit];
        if (!outcome.applied) {
          return Object.freeze({
            schema: REVIEW_RECEIPT_SCHEMA, status: 'not-applied', reason: 'stale-or-duplicate-review', permissionGranted: false,
            unit: args.unit, floor: unit.floor, requiredReviewTier: requiredReviewTier(outcome.next, args.unit),
          });
        }
        return Object.freeze({
          schema: REVIEW_RECEIPT_SCHEMA, status: 'applied', permissionGranted: false,
          unit: args.unit, verdict: reviewVerdict(output, args.unit),
          failedReviews: unit.failed_reviews, floor: unit.floor, attempt: unit.attempt,
          requiredReviewTier: requiredReviewTier(outcome.next, args.unit),
        });
      } catch (error) { return refusal(REVIEW_RECEIPT_SCHEMA, 'internal-refusal', { detail: String(error?.message ?? error) }); }
    }

    async function executeLogged(kind, action, args, exec) {
      if (kind === 'dispatch' && requireDecisionLog) {
        const requested = await recordDecision(decisionStore, decisionEvent(kind, exec, { status: 'requested' }, { seat: args?.seat }));
        if (!requested) return refusal(RECEIPT_SCHEMA, 'decision-log-write-failed');
      }
      const receipt = await action(args, exec);
      const recorded = await recordDecision(decisionStore, decisionEvent(kind, exec, receipt, { seat: args?.seat, unit: args?.unit }));
      return withLogOutcome(receipt, recorded);
    }

    const renderReceipt = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }];
    const disposers = [];
    disposers.push(tools.register({
      name: 'dsh_dispatch',
      description: 'Governed DSH worker dispatch. Coordinator-only. Validates the complete brief, the selected worker family over session ancestry, the exact configured seat route and judge evidence, then activates the fixed-role worker on its admitted route and records the durable admission. Returns a structured receipt; refusals carry a reason. Never grants permission.',
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string', maxLength: BRIEF_LIMIT, description: 'Complete dispatch brief: UNIT, OBJECTIVE, SCOPE, ACCEPTANCE, RISK, CHANGES (JSON or labelled prose).' },
          seat: { type: 'string', description: 'Worker seat from the selected family, e.g. executor-s, reviewer, critic-f.' },
        },
        required: ['brief', 'seat'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderReceipt },
      execute: (args, exec) => executeLogged('dispatch', dispatch, args, exec),
    }, { when: whenCoordinator }));
    disposers.push(tools.register({
      name: 'dsh_review',
      description: 'Governed DSH review intake. Coordinator-only. Reads the recorded output of an owned reviewer bound to the current unit and attempt, and applies at most one verdict.',
      parameters: {
        type: 'object',
        properties: {
          unit: { type: 'string', description: 'Stable unit identifier of the admitted dispatch, e.g. U-1.' },
          reviewer_id: { type: 'string', description: 'Owned governed reviewer session ID whose recorded output contains the REVIEW verdict.' },
        },
        required: ['unit', 'reviewer_id'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderReceipt },
      execute: (args, exec) => executeLogged('review', review, args, exec),
    }, { when: whenCoordinator }));
    disposers.push(tools.register({
      name: 'dsh_resume',
      description: 'Continue an owned, currently admitted worker without starting another child.',
      parameters: { type: 'object', properties: {
        child_id: { type: 'string' }, unit: { type: 'string' }, seat: { type: 'string' }, followup: { type: 'string', maxLength: BRIEF_LIMIT },
      }, required: ['child_id', 'unit', 'seat', 'followup'], additionalProperties: false },
      output: { schema: { type: 'object' }, render: renderReceipt },
      execute: (args, exec) => executeLogged('dispatch', resume, args, exec),
    }, { when: whenCoordinator }));

    // Defense in depth: deny the dispatch tool family while governance state is
    // unavailable. Monotonic: no later listener can turn this denial back into
    // permission. This covers only this facade's dispatch tools; it is NOT a
    // universal delegation firewall.
    if (typeof tools.guard === 'function') {
      disposers.push(tools.guard((call) => {
        try {
          if (typeof call?.name !== 'string' || !DISPATCH_TOOL_RE.test(call.name)) return undefined;
          if (!state.ready) return 'kilo governance state unavailable: dispatch denied (fail closed)';
          return undefined;
        } catch { return 'kilo governance guard failure: dispatch denied (fail closed)'; }
      }));
    } else {
      warn('ctx.tools.guard unavailable; dispatch gating relies on tool-level refusals only');
    }

    return async () => {
      injections.workerGuard?.setSnapshotProvider?.(null);
      for (const dispose of disposers) { try { dispose(); } catch { /* unmount is best-effort */ } }
      try { if (state.domainLease) await releaseReviewDomain(state.domainFacility, state.domainLease); } catch { /* close is best-effort */ }
    };
  }

  return Object.freeze({ apply });
}

// Trusted Host-side seam installation for live wiring (session reader, judge
// operation authorization, optional judge transport/timeout, roster override).
// Model tool JSON can never reach this: it runs in Host JavaScript only.
let trustedSeams = Object.freeze({});
export function installTrustedSeams(seams) {
  if (!object(seams)) throw new Error('governance-facade: seams must be a plain object');
  trustedSeams = Object.freeze({ ...seams });
}

/** Native subagent creator ancestry plus persistent human-selected tracks.
 * Ordinary forks are independent; unavailable ancestors are refused. */
export function buildDefaultReadSession(ctx) {
  return trackPolicyReader(ctx);
}
/** Build the default judge-authorization seam. Local loopback judges are within
 *  the granted migration scope; external (paid/remote) judges need explicit
 *  config approval. Exported for testing. */
export function buildDefaultAuthorizeOperation(config) {
  return (scope) => {
    if (!object(scope)) return false;
    if (scope.external === false) return true;
    return config?.approveExternalJudge === true;
  };
}

/** Plugin entry. YAML plugin config may carry data seams (roster object or
 * rosterPath). Function seams come from installTrustedSeams when provided;
 * otherwise self-contained defaults are derived from public Host services so
 * the bundle works without an external trusted-JS step. With neither wiring nor
 * reachable services the tools register fail-closed.
 */
export async function applyFacade(ctx, config, sharedEvents, workerGuard, { coordinatorDefaultOnStandard } = {}) {
  const cfg = object(config) ? config : {};
  const defaultReadSession = buildDefaultReadSession(ctx);
  const defaultAuthorizeOperation = buildDefaultAuthorizeOperation(cfg);
  return createGovernanceFacade({
    coordinatorDefaultOnStandard,
    decisionStore: sharedEvents,
    requireDecisionLog: true,
    workerGuard,
    readSession: trustedSeams.readSession ?? defaultReadSession,
    authorizeOperation: trustedSeams.authorizeOperation ?? defaultAuthorizeOperation,
    ...(trustedSeams.judgeTransport !== undefined ? { judgeTransport: trustedSeams.judgeTransport } : {}),
    ...(trustedSeams.judgeTimeoutMs !== undefined ? { judgeTimeoutMs: trustedSeams.judgeTimeoutMs } : {}),
    ...(trustedSeams.spawnProvider !== undefined ? { spawnProvider: trustedSeams.spawnProvider } : {}),
    ...(object(cfg.roster) ? { roster: cfg.roster } : {}),
    ...(typeof cfg.rosterPath === 'string' ? { rosterPath: cfg.rosterPath } : {}),
    ...(typeof cfg.effortVocabulary !== 'undefined' ? { effortVocabulary: cfg.effortVocabulary } : {}),
  }).apply(ctx);
}
