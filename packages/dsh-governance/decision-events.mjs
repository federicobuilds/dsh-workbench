import { randomUUID } from 'node:crypto';
import { WORKER_FAMILIES } from './policy.mjs';
import { redactText } from './gates.mjs';

const TIERS = new Set(['cheap', 'default', 'max', 'easy', 'hard']);
const RISKS = new Set(['low', 'normal', 'high', 'UNSURE']);
const SEATS = new Set(Object.values(WORKER_FAMILIES).flat());
const REASONS = {
  'operation-not-approved': 'Judge operation lacks operator authorization.',
  'unknown-decision': 'Judge could not establish a supported risk/tier decision.',
  'uncertain-risk': 'Judge was uncertain about the risk of the work.',
  'required-tier-or-risk-mismatch': 'Judge requires a different tier or a higher declared risk.',
  'tier-mismatch': 'Judge requires a different worker tier.',
  'declared-risk-too-low': 'Judge requires the brief to declare a higher risk.',
  'invalid-output-or-model': 'Judge response failed the configured model or answer validation.',
  'outage-or-invalid-output': 'Judge transport or response failed validation.',
  'timeout-or-canceled': 'Judge request timed out or was cancelled.',
  'invalid-input-or-binding': 'Judge request or configured backend binding is invalid.',
  'judge-refused': 'Judge did not approve this dispatch.',
  'worker-access-off': 'Worker track is Off; no worker may start.',
  'seat-outside-selected-family': 'Requested worker is outside the selected track.',
  'route-admission-refused': 'Requested worker model or effort violates the configured seat.',
  'brief-refused': 'Dispatch brief is missing or has invalid required fields.',
  'review-floor-refused': 'Persistent review escalation requires a higher worker tier.',
  'governance-unavailable': 'Required governance state is unavailable.',
  'ancestry-refused': 'Session ancestry or track could not be verified.',
  'caller-not-coordinator': 'Only a coordinator may dispatch or record a review.',
  'no-agent-context': 'Operation has no verified calling agent.',
  'no-worker-preset': 'No supported preset is registered for this worker.',
  'activation-refused': 'Native worker activation failed.',
  'decision-log-unavailable': 'Required decision log is unavailable; action was not started.',
  'decision-log-write-failed': 'Decision could not be recorded; worker was not started.',
  'track-changed-during-admission': 'Worker track or ancestor policy changed during admission; worker was not started.',
  'invalid-review-text': 'Review is not one valid, correctly bound REVIEW verdict.',
  'no-admission-for-unit': 'There is no recorded dispatch for this review unit.',
  'stale-or-duplicate-review': 'Review is stale or already applied.',
};

/** Whitelist decision metadata. Never copy brief, detail, wire answers, prompts,
 * tool output or arbitrary error messages into the transparency feed. */
export function decisionEvent(kind, exec, receipt, { unit, seat, judge } = {}) {
  if (!['judge', 'dispatch', 'review'].includes(kind)) throw new Error('Invalid decision kind');
  const status = ['requested', 'decision', 'refused', 'dispatched', 'applied', 'not-applied'].includes(receipt.status) ? receipt.status : 'refused';
  const code = Object.hasOwn(REASONS, receipt.reason) ? receipt.reason : receipt.reason ? 'unclassified-refusal' : null;
  const event = { v: 1, id: randomUUID(), ts: Date.now(), kind,
    session: exec?.agent?.session?.id ?? null,
    decision: status, tool: kind === 'review' ? 'dsh_review' : 'dsh_dispatch',
    reason: code ? (REASONS[code] ?? 'Operation refused; inspect the operation receipt.') : status === 'dispatched' ? 'Worker activation accepted.' : status === 'applied' ? 'Bound review applied.' : 'Decision evaluation recorded.',
    permissionGranted: false };
  if (code) event.reasonCode = code;
  const chosenUnit = unit ?? receipt.unit;
  if (typeof chosenUnit === 'string' && /^[A-Z0-9][\w.-]{0,119}$/.test(chosenUnit)) event.unit = redactText(chosenUnit).text;
  const chosenSeat = seat ?? receipt.seat;
  if (SEATS.has(chosenSeat)) event.seat = chosenSeat;
  if (['clef-flash', 'jev'].includes(judge ?? receipt.judge)) event.judge = judge ?? receipt.judge;
  if (TIERS.has(receipt.tier)) event.tier = receipt.tier;
  if (TIERS.has(receipt.requestedTier)) event.requestedTier = receipt.requestedTier;
  if (RISKS.has(receipt.risk)) event.risk = receipt.risk;
  if (RISKS.has(receipt.declaredRisk)) event.declaredRisk = receipt.declaredRisk;
  if (typeof receipt.childId === 'string' && receipt.childId.length <= 120) event.childId = redactText(receipt.childId).text;
  if (['cheap', 'default', 'max'].includes(receipt.floor)) event.floor = receipt.floor;
  return Object.freeze(event);
}

export async function recordDecision(store, event) {
  if (!store || typeof store.record !== 'function') return false;
  try { await store.record(event); return true; }
  catch { return false; }
}

/** Preserve actual action outcome if a post-action log write fails. It cannot
 * truthfully be rewritten as an action denial after a worker has started. */
export function withLogOutcome(receipt, recorded) {
  return Object.freeze({ ...receipt, decisionLog: recorded ? 'recorded' : 'write-failed',
    ...(recorded ? {} : { diagnostic: 'Decision log write failed; action outcome is unchanged.' }) });
}
