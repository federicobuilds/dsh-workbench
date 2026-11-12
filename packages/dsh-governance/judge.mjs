import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolveJudge } from './judge-config.mjs';
import { parseDispatchBrief, checkJudge, TIER_SEATS, WORKER_FAMILIES } from './policy.mjs';

export const name = 'dsh-judge-integration';
export const inject = ['tools'];
const TIERS = ['cheap', 'default', 'max'];
const MODES = ['free', 'simple', 'advanced', 'off'];
const RISK = ['low', 'normal', 'high'];
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function fields(v, allowed, required = allowed) {
  if (!plain(v) || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !allowed.includes(k)
    || !('value' in Object.getOwnPropertyDescriptor(v, k))) || required.some(k => !Object.hasOwn(v, k))) throw new Error('invalid-input');
}
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const band = p => p >= 0.70 ? 'yes' : p <= 0.30 ? 'no' : 'unsure';
// Exact question instructions/criteria copied from preserved judge.py risk_questions/tier_questions.
const Q = (instructions, criteria) => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });
const riskQuestions = {
  irreversible: Q('Does this brief call for an action that cannot be undone, such as deleting data, dropping a table, or a destructive command on a live system?'),
  auth: Q('Does this brief change authentication or login?'),
  secrets: Q('Does the proposed work in `brief` require accessing or handling credentials?', {
    true: 'The work reads, stores, transmits, rotates, or modifies passwords, API keys, or authentication tokens.',
    false: 'The work does not access those credentials. Merely forbidding credential access or mentioning a credential-related path is not handling credentials.' }),
  permissions: Q('Does this brief change access permissions or user roles?'),
  money: Q('Does this brief handle payments, billing, or other money?'),
  production: Q('Does this brief change production infrastructure, a live service, or a database migration?'),
  executes: Q('Does the work in `brief` create or modify executable code, scripts or application behavior?', {
    true: 'The deliverable adds or changes code, scripts or software behavior.',
    false: 'The task invokes an already installed program with specified arguments, or reads data, without modifying that program. Running an existing tool is not writing executable code.' }),
  docs_only: Q('Does this brief change only documentation, prose, comments, or configuration values that nothing executes?'),
  read_only: Q('Is the work in `brief` limited to reading, searching or comparing existing information and reporting the findings?', {
    true: 'Only observations and findings are produced; source files, accounts and services are not changed. A report of the findings is allowed.',
    false: 'The task changes source data, software, configuration, permissions or running services, or does not specify its actions clearly enough.' }),
  reproducible_outputs: Q('Does `brief` only use existing tools to create new reproducible data or media outputs while preserving all originals?', {
    true: 'Specified downloads, conversions, copies or metadata are written to new destinations; originals remain intact and the installed environment is not changed.',
    false: 'The task overwrites or deletes originals, installs software, changes a live service, or leaves the output effects unspecified.' }),
};
const tierQuestions = {
  docs_only: Q('Is the deliverable only prose or data/media produced with already specified methods, rather than new software or an unresolved design?', {
    true: 'Documentation, reports, CSV, downloaded files, resized images or converted videos. Existing tools and required output formats are specified; no new program or design is required.',
    false: 'The executor must implement software or choose an unresolved architecture, interface, policy or transformation method. A report accompanying that implementation does not make it data-only work.' }),
  quick: Q('Could an experienced engineer who has this brief finish the hands-on work in under 15 minutes, excluding unattended download, render or command execution time?'),
  long: Q('Does this brief require more than 4 hours of hands-on engineering, excluding unattended download, render or command execution time?'),
  open: Q('Does `brief` leave an unresolved design choice that the executor must decide?', {
    true: 'The executor must choose architecture, interfaces, policy or a substantive trade-off that the brief has not settled.',
    false: 'The task supplies the required outputs, constraints and methods. Routine use of existing tools, checking their help or filling command arguments is not an unresolved design decision.' }),
  coupled: Q('Must several parts be changed together so that they stay consistent with each other?'),
  checkable: Q('Can every acceptance criterion in the brief be checked by running a command?'),
  rare: Q('Does the task need specialized knowledge that neither the brief nor common engineering practice supplies?'),
};
export const QUESTIONS = freeze(Object.fromEntries([
  ...Object.entries(riskQuestions).map(([k, v]) => ['risk_' + k, v]),
  ...Object.entries(tierQuestions).map(([k, v]) => ['tier_' + k, v]),
]));
export const AUDIT_QUESTIONS = freeze({
  scope_clear: Q('Does `scope` identify the evidence to inspect and the question to answer? Judge the task description, not a requested seat, model or tier.', {
    true: 'The brief identifies the evidence source and the fact or output to obtain. For a bounded search, a named source and topic are enough; exact files, commands or a predetermined answer are not required.',
    false: 'The evidence source or the question/output is missing, so the auditor must guess what to inspect or produce.' }),
  causal_diagnosis: Q('Must the auditor discover the cause of an unexplained failure in `scope`?', {
    true: 'The cause is unknown and this audit must establish why the failure occurs.',
    false: 'The audit collects specified facts or checks a stated fix. Mentioning a failure with an already established cause is not diagnosis.' }),
  conflicting_evidence: Q('Must the auditor reconcile contradictory evidence to answer `scope`?', {
    true: 'Conflicting observations or claims must be explained, not merely listed.',
    false: 'The audit gathers facts or reports differences without needing to explain a contradiction.' }),
  unknown_interaction: Q('Must the auditor reason about an unresolved interaction between components to answer `scope`?', {
    true: 'The audit must trace behavior across components to resolve an unknown interaction.',
    false: 'The brief supplies the interaction and asks for specified checks. Several files, live hosts or services alone do not require this reasoning.' }),
});
const ALL_TIERS = ['cheap', 'default', 'max', 'easy', 'hard'];
function binding(family) {
  if (!MODES.includes(family)) throw new Error('invalid-family');
  // Explicit empty env: model, endpoint, key and registry overrides never come from tool arguments/environment.
  const selected = resolveJudge(family, homedir(), {});
  const expected = family === 'free' || family === 'simple' ? ['clef-flash', 'clef-flash', 'http://127.0.0.1:8043']
    : ['jev', 'jev-1.13.0', 'https://api.typesafe.ai'];
  const keyPath = homedir() + (expected[0] === 'clef-flash' ? '/.config/kilo/harness/judge/local-key' : '/.config/kilo/secrets/typesafe');
  if (selected.id !== expected[0] || selected.env.JUDGE_MODEL !== expected[1] || selected.endpoint !== expected[2]
    || selected.env.JUDGE_KEY_FILE !== keyPath) throw new Error('registry-binding');
  return selected;
}
function input(args) {
  fields(args, ['family', 'brief', 'seat'], ['family', 'brief']);
  if (!MODES.includes(args.family)) throw new Error('invalid-family');
  const brief = parseDispatchBrief(args.brief);
  if (args.seat !== undefined && (!WORKER_FAMILIES[args.family]?.includes(args.seat) || !['tier', 'auditor-tier'].includes(TIER_SEATS[args.seat]?.[0]))) throw new Error('wrong-family');
  return brief;
}
function history(value) {
  if (value === undefined) return { current: null, failed_reviews: 0, floor: null };
  fields(value, ['current', 'failed_reviews', 'floor']);
  if (!TIERS.includes(value.current) || !TIERS.includes(value.floor) || !Number.isSafeInteger(value.failed_reviews) || value.failed_reviews < 0) throw new Error('invalid-history');
  return { ...value }; // Caller supplies trusted attained-tier history, never public tool arguments.
}
function compose(answers, h) {
  const p = {}, r = {}, t = {};
  for (const key of Object.keys(QUESTIONS)) {
    const a = answers[key];
    if (!plain(a) || a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw new Error('invalid-output');
    p[key] = a.noul;
    (key.startsWith('risk_') ? r : t)[key.slice(5)] = band(a.noul);
  }
  const high = ['irreversible', 'auth', 'secrets', 'permissions', 'money', 'production'];
  const risk = high.some(k => r[k] === 'yes') ? 'high' : high.some(k => r[k] === 'unsure') ? 'UNSURE'
    : r.executes === 'yes' ? 'normal' : r.executes === 'no' && ['docs_only', 'read_only', 'reproducible_outputs'].some(k => r[k] === 'yes') ? 'low' : 'UNSURE';
  let tier = h.failed_reviews >= 2 ? TIERS[Math.min(TIERS.indexOf(h.current) + 1, 2)]
    : t.long === 'yes' && [t.open, t.rare].includes('yes') ? 'max'
    : [t.open, t.rare, t.long, t.coupled].includes('yes') || ['open', 'rare', 'coupled', 'long'].some(k => t[k] === 'unsure') ? 'default'
    : [t.docs_only, t.quick, t.checkable].includes('yes') ? 'cheap' : 'default';
  if (h.floor && TIERS.indexOf(tier) < TIERS.indexOf(h.floor)) tier = h.floor;
  return { tier, risk, probabilities: p };
}
function composeAuditor(answers, brief) {
  const p = {}, b = {};
  for (const key of Object.keys(AUDIT_QUESTIONS)) {
    const a = answers[key];
    if (!plain(a) || a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw new Error('invalid-output');
    p[key] = a.noul;
    b[key] = band(a.noul);
  }
  const hard = ['causal_diagnosis', 'conflicting_evidence', 'unknown_interaction'].filter(k => b[k] === 'yes');
  const unknown = ['causal_diagnosis', 'conflicting_evidence', 'unknown_interaction'].filter(k => b[k] === 'unsure');
  const tier = hard.length ? 'hard' : (unknown.length || b.scope_clear !== 'yes') ? 'UNSURE' : 'easy';
  return { tier, risk: brief.risk ?? 'low', probabilities: p };
}
// One bounded attempt; no automatic retry or health probe (unlike hosted judge.py retry policy).
async function liveTransport({ selected, body, signal }) {
  signal.throwIfAborted();
  let key = await readFile(selected.env.JUDGE_KEY_FILE, { encoding: 'utf8', signal });
  key = key.trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('key-unavailable');
  signal.throwIfAborted();
  const response = await fetch(selected.endpoint + '/v1/systemone', {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  key = undefined;
  if (!response.ok || !response.body) throw new Error('transport-unavailable');
  // Bound even streamed responses; errors and server bodies are never logged/returned.
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 65536) throw new Error('oversize-output'); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
export function readyStatus(family) {
  try { const s = binding(family); return freeze({ status: 'configured-not-probed', family, judge: s.id,
    protocol: 'systemone/v1', requestsRequireApproval: true, delegationImplemented: false }); }
  catch { return freeze({ status: 'unavailable', family: MODES.includes(family) ? family : null, delegationImplemented: false }); }
}
/** Trusted JS seams only. Neither transport nor authorization can be supplied by model tool JSON. */
export function createJudgeClient({ transport = liveTransport, authorizeOperation = () => false, timeoutMs } = {}) {
  if (typeof transport !== 'function' || typeof authorizeOperation !== 'function'
    || (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 80000))) throw new Error('invalid-client-options');
  return Object.freeze({ readyStatus, async decide(args, { signal, reviewHistory } = {}) {
    let brief, selected, h;
    const refused = (reason, details = {}) => freeze({ schema: 'dsh.judge-decision/v1', status: 'refused', reason,
      unavailable: true, requiredDecisionSatisfied: false, permissionGranted: false, delegationImplemented: false, ...details });
    try { brief = input(args); h = history(reviewHistory); selected = binding(args.family); }
    catch { return refused('invalid-input-or-binding'); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const budget = Math.min(timeoutMs ?? Number(selected.env.JUDGE_DEADLINE_S) * 1000,
      Number(selected.env.JUDGE_TIMEOUT_S) * 1000, selected.processTimeoutMs);
    let timer, rejectAbort;
    const canceled = new Promise((_, reject) => { rejectAbort = () => reject(new Error('canceled')); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
    timer = setTimeout(abort, budget);
    const scope = freeze({ family: args.family, judge: selected.id, unit: brief.unit, briefDigest: hash(brief),
      operation: 'systemone-dispatch', external: !selected.local });
    try {
      controller.signal.throwIfAborted();
      const approved = await Promise.race([Promise.resolve().then(() => authorizeOperation(scope, controller.signal)), canceled]);
      if (approved !== true) return refused('operation-not-approved');
      controller.signal.throwIfAborted();
      const isAuditor = TIER_SEATS[args.seat]?.[0] === 'auditor-tier';
      const qset = isAuditor ? AUDIT_QUESTIONS : QUESTIONS;
      const body = { state: isAuditor ? { scope: brief } : { brief }, model: selected.env.JUDGE_MODEL, questions: qset };
      const wire = await Promise.race([Promise.resolve().then(() => transport({ selected, body, signal: controller.signal })), canceled]);
      controller.signal.throwIfAborted();
      if (!plain(wire) || wire.model !== body.model || !plain(wire.answers)) return refused('invalid-output-or-model');
      let result;
      if (isAuditor && Object.keys(AUDIT_QUESTIONS).every(k => Object.hasOwn(wire.answers, k)) && Object.keys(wire.answers).length === Object.keys(AUDIT_QUESTIONS).length) {
        result = composeAuditor(wire.answers, brief);
      } else if (Object.keys(QUESTIONS).every(k => Object.hasOwn(wire.answers, k)) && Object.keys(wire.answers).length === Object.keys(QUESTIONS).length) {
        result = compose(wire.answers, h);
        if (isAuditor) result = { ...result, tier: result.tier === 'max' ? 'hard' : 'easy' };
      } else {
        return refused('invalid-output-or-model');
      }
      const decisionFacts = { judge: selected.id, unit: brief.unit, tier: result.tier, risk: result.risk, declaredRisk: brief.risk,
        ...(args.seat ? { seat: args.seat, requestedTier: TIER_SEATS[args.seat][1] } : {}) };
      if (!ALL_TIERS.includes(result.tier) || !RISK.includes(result.risk)) return refused('unknown-decision', decisionFacts);
      if (args.seat) {
        try { checkJudge({ raw: args.brief, brief, seat: args.seat, judge: result }); }
        catch { return refused('required-tier-or-risk-mismatch', decisionFacts); }
      }
      return freeze({ schema: 'dsh.judge-decision/v1', status: 'decision', ...scope, seat: args.seat ?? null,
        ...result, declaredRisk: brief.risk, reviewHistoryDigest: hash(h), requiredDecisionSatisfied: !!args.seat,
        permissionGranted: false, delegationImplemented: false });
    } catch { return refused(controller.signal.aborted ? 'timeout-or-canceled' : 'outage-or-invalid-output'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort); }
  } });
}
export function toolDefinition(client = createJudgeClient()) {
  return {
    name: 'dsh_judge', description: 'Get configured-not-probed judge readiness or canonical risk/tier evidence. Never grants human permission, route waivers, or delegation.',
    parameters: { type: 'object', additionalProperties: false, required: ['action', 'family'], properties: {
      action: { type: 'string', enum: ['ready-status', 'dispatch'] }, family: { type: 'string', enum: MODES },
      brief: { type: 'string', maxLength: 12000 }, seat: { type: 'string' },
    } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    async execute(args, toolContext) {
      try {
        fields(args, ['action', 'family', 'brief', 'seat'], ['action', 'family']);
        if (!MODES.includes(args.family) || !['ready-status', 'dispatch'].includes(args.action)) throw new Error('invalid-input');
        if (args.action === 'ready-status') {
          if (args.brief !== undefined || args.seat !== undefined) throw new Error('invalid-input');
          return JSON.stringify(client.readyStatus(args.family));
        }
        return JSON.stringify(await client.decide({ family: args.family, brief: args.brief,
          ...(args.seat === undefined ? {} : { seat: args.seat }) }, { signal: toolContext?.signal }));
      } catch { return JSON.stringify({ status: 'refused', reason: 'invalid-input', permissionGranted: false, delegationImplemented: false }); }
    },
  };
}
// Plugin activation registers only; no key read, request, probe, process, or server startup.
export function apply(ctx) { ctx.tools.register(toolDefinition()); }
