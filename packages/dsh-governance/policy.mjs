/** Pure DSH governance reimplementation; no runtime, filesystem, environment or source imports.
 * Attribution: dsh-workbench's preserved harness selection.mjs, agent-access.mjs,
 * roles/registry.mjs and server/harness.ts. Exact provenance/changes in README.md.
 * All config/history/review bindings MUST originate in a future trusted adapter.
 * These predicates provide necessary restrictions, NEVER human authorization.
 */
const fail = (message) => { throw new Error(message); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (v) => typeof v === 'string' && v.trim().length > 0 && v === v.trim();
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const keys = (v, allowed, required = []) => {
  if (!object(v)) fail('expected plain object');
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail(`unknown field ${String(key)}`);
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d || !('value' in d)) fail('accessor fields forbidden');
  }
  for (const key of required) if (!Object.hasOwn(v, key)) fail(`missing field ${key}`);
};
const freeze = (v) => {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
};
export const PROVENANCE = freeze({
  selection: '41a5e80425e3095041c952cad8d6dc7a95b2ce1dcbb27ffe286ba8afc90fc614',
  access: 'edddb3321a910f2ad4f826c1c427d34791229b91f345207a67cad9c08f7034e2',
  registry: 'e80c3c55e3aa026b923c4f25999397d71999de3439756f1b3894437b18e36ccf',
  server: '3b845a4eaf490b6488beb2a1e8810f871c45131da66135fce5ac8a3d0f34320a',
});
export const NS = 'dsh-workbench.agent-access';
export const MODES = freeze(['off', 'free', 'simple', 'advanced']);
export const normalizeMode = (m) => m === 'cheap' ? 'simple' : m;
const suffixes = {
  executor: { advanced: ['-cheap', '', '-max'], simple: ['-s-cheap', '-s', '-s-max'], free: ['-f-cheap', '-f', '-f-strong'] },
  reviewer: { advanced: ['', '-max'], simple: ['-s', '-s-max'], free: ['-f', '-f-max'] },
};
const specialists = (family) => ['video-assistant', 'motion-vfx', 'audiovisual-review'].flatMap(
  (role) => suffixes[role === 'audiovisual-review' ? 'reviewer' : 'executor'][family].map((suffix) => role + suffix));
export const WORKER_FAMILIES = freeze({
  free: ['executor-f-cheap', 'executor-f', 'executor-f-strong', 'critic-f', 'critic-f-max', 'auditor-f', 'auditor-f-max', 'reviewer-f', 'reviewer-f-max', 'deep-researcher-f', ...specialists('free')],
  simple: ['executor-s-cheap', 'executor-s', 'executor-s-max', 'critic-s', 'critic-s-max', 'auditor-s', 'auditor-s-max', 'reviewer-s', 'reviewer-s-max', 'deep-researcher', 'explore', ...specialists('simple')],
  advanced: ['executor-cheap', 'executor', 'executor-max', 'critic', 'critic-max', 'auditor', 'auditor-max', 'reviewer', 'reviewer-max', 'deep-researcher', 'explore', ...specialists('advanced')],
});
const tierSeats = {};
for (const family of ['free', 'simple', 'advanced']) {
  for (const role of ['executor', 'video-assistant', 'motion-vfx']) {
    suffixes.executor[family].forEach((suffix, i) => { tierSeats[role + suffix] = ['tier', ['cheap', 'default', 'max'][i]]; });
  }
  const suffix = family === 'advanced' ? '' : family === 'free' ? '-f' : '-s';
  tierSeats['auditor' + suffix] = ['auditor-tier', 'easy'];
  tierSeats['auditor' + suffix + '-max'] = ['auditor-tier', 'hard'];
}
export const TIER_SEATS = freeze(tierSeats);
export const SEATS = TIER_SEATS;
export const FREE_HOSTED = freeze(['openrouter/google/gemma-4-31b-it:free', 'openrouter/z-ai/glm-5.3-flash', 'openrouter/deepseek/deepseek-v4.1-flash-1017']);
const WORKER_ALIASES = freeze({
  'deepseek/deepseek-v4.1-flash-1017': ['deepseek/deepseek-v4.1-flash', 'google/gemini-3.6-flash'],
  'moonshotai/kimi-k3.1-pro': ['moonshotai/kimi-k3', 'qwen/qwen3.8-2.4t-a95b'],
  'openai/gpt-6.1-terra': ['openai/gpt-6.1-sol', 'qwen/qwen3.8-2.4t-a95b'],
});
const FREE_ALIAS_SEATS = freeze(['executor-f-cheap', 'motion-vfx-f-cheap', 'video-assistant-f-cheap']);

/** Source-compatible namespace, stricter DTO field validation (unknown selection fields refused). */
export function parseSelection(metadata) {
  if (metadata === undefined) return freeze({ state: 'absent' });
  if (!object(metadata)) fail('invalid session metadata');
  if (!Object.hasOwn(metadata, NS)) return freeze({ state: 'absent' });
  const s = metadata[NS];
  keys(s, ['v', 'mode', 'rev'], ['v', 'mode', 'rev']);
  const mode = normalizeMode(s.mode);
  if (s.v !== 1 || !MODES.includes(mode) || !text(s.rev)) fail('invalid selection version/mode/revision');
  return freeze({ state: 'valid', mode, rev: s.rev });
}
const policies = new WeakSet();
/** Synchronous injected reader; adapter supplies stable ancestry snapshot, not live I/O here.
 * Source preserves immediate family conflict refusal even if a later ancestor is Off.
 */
export function resolvePolicy(sessionID, readSession, { maxDepth = 32 } = {}) {
  if (!text(sessionID) || typeof readSession !== 'function' || !integer(maxDepth) || maxDepth < 1 || maxDepth > 32) fail('invalid ancestry input');
  const chain = [], revisions = [];
  let id = sessionID, mode = null;
  while (id) {
    if (chain.includes(id)) fail('ancestry cycle');
    if (chain.length >= maxDepth) fail('ancestry depth exceeded');
    chain.push(id);
    let info;
    try { info = readSession(id); } catch { fail('unreadable ancestry'); }
    if (!object(info) || info.id !== id) fail('invalid/unreadable ancestry identity');
    if (info.parentID !== undefined && info.parentID !== null && !text(info.parentID)) fail('invalid parentID');
    const s = parseSelection(info.metadata);
    if (s.state === 'valid') {
      revisions.push([id, s.rev, s.mode]);
      if (mode === 'off' || s.mode === 'off') mode = 'off';
      else if (mode && mode !== s.mode) fail('worker-family conflict');
      else mode = s.mode;
    }
    id = info.parentID;
  }
  const result = freeze({ state: mode ? 'valid' : 'absent', mode, sessionID, chain, revisions });
  policies.add(result);
  return result;
}
const snapshots = new WeakSet();
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;
const validProvider = (v) => text(v) && !v.includes('/') && !v.includes(' ') && printable.test(v);
const validModel = (v) => text(v) && v.split('/').every((s) => text(s) && printable.test(s));
function routeDTO(v) {
  keys(v, ['provider', 'model', 'effort'], ['provider', 'model', 'effort']);
  if (!validProvider(v.provider) || !validModel(v.model) || !(v.effort === null || text(v.effort))) fail('invalid route/effort');
  return { provider: v.provider, model: v.model, effort: v.effort };
}
const target = (r) => `${r.provider}/${r.model}`;
const equalRoute = (a, b) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;
function loopback(baseURL) {
  try {
    const u = new URL(baseURL);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
      && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname.toLowerCase());
  } catch { return false; }
}
/** Strict, copied, deeply frozen DTO. Branding is NOT an authorization boundary against trusted JS.
 * Input is trusted adapter configuration only. No selfHosted boolean is accepted anywhere.
 * efforts, if present, is an explicitly approved vocabulary; route still exactly binds its one effort.
 */
export function normalizeConfig(input) {
  keys(input, ['revision', 'providers', 'seats', 'efforts'], ['revision', 'providers', 'seats']);
  if (!text(input.revision) || !object(input.providers) || !object(input.seats)) fail('invalid config DTO');
  keys(input.providers, Object.keys(input.providers));
  keys(input.seats, Object.keys(input.seats));
  let efforts = null;
  if (input.efforts !== undefined) {
    if (!Array.isArray(input.efforts) || !input.efforts.length || ![...input.efforts].every(text) || new Set(input.efforts).size !== input.efforts.length) fail('invalid approved effort vocabulary');
    efforts = [...input.efforts];
  }
  const providers = Object.create(null), seats = Object.create(null);
  for (const [id, p] of Object.entries(input.providers)) {
    if (!validProvider(id)) fail('invalid provider ID');
    keys(p, ['baseURL'], ['baseURL']);
    if (p.baseURL !== null && !text(p.baseURL)) fail('invalid provider URL');
    if (p.baseURL !== null) { try { const u = new URL(p.baseURL); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('invalid provider URL'); } catch { fail('invalid provider URL'); } }
    providers[id] = { baseURL: p.baseURL, loopback: p.baseURL !== null && loopback(p.baseURL) };
  }
  for (const [seat, s] of Object.entries(input.seats)) {
    if (!Object.values(WORKER_FAMILIES).some((family) => family.includes(seat))) fail('unknown worker seat');
    keys(s, ['enabled', 'route'], ['enabled', 'route']);
    if (typeof s.enabled !== 'boolean') fail('invalid enabled flag');
    const route = routeDTO(s.route);
    if (!Object.hasOwn(providers, route.provider)) fail('unknown configured provider');
    if (route.effort !== null && (!efforts || !efforts.includes(route.effort))) fail('unknown/unapproved effort');
    seats[seat] = { enabled: s.enabled, route };
  }
  const result = freeze({ revision: input.revision, providers, seats, efforts });
  snapshots.add(result);
  return result;
}
function requireSnapshot(snapshot, policy) {
  if (!snapshots.has(snapshot)) fail('trusted normalized config snapshot required');
  if (!policies.has(policy) || policy.state !== 'valid') fail('trusted current selected policy required');
  if (policy.mode === 'off') fail('worker access Off');
}
function allowedRoute(snapshot, mode, route) {
  const p = snapshot.providers[route.provider];
  if (/^anthropic\//i.test(route.model) || /astra/i.test(route.model)) fail('Anthropic/Astra worker model banned');
  if (!p || (route.provider !== 'openrouter' && !p.loopback)) fail('worker provider not OpenRouter/configured loopback');
  if (mode === 'free' && !p.loopback && !FREE_HOSTED.includes(target(route))) fail('Free hosted exception must match exact ID');
  const owns = WORKER_FAMILIES[mode].some((s) => snapshot.seats[s]?.enabled && equalRoute(snapshot.seats[s].route, route));
  if (!owns) fail('not a current enabled own-family seat route');
}
const admissions = new WeakSet();
/** Worker ONLY. All supplied candidate paths are checked independently, even when overridden.
 * Null/omitted explicit/default/inherited values mean absent; malformed objects fail closed.
 * Resume includes a trusted stored seat+route; changed role/config requires a new admission.
 * Every restricted role+effort binding is an intentional strengthening of DSH tier-seat binding.
 */
export function admitWorker({ snapshot, policy, seat, explicit, defaultRoute, inherited, resume }) {
  requireSnapshot(snapshot, policy);
  if (!WORKER_FAMILIES[policy.mode].includes(seat)) fail('seat outside worker family');
  const s = snapshot.seats[seat];
  if (!s || !s.enabled) fail('worker seat missing/disabled');
  const candidates = [s.route];
  for (const r of [explicit, defaultRoute, inherited]) if (r !== undefined && r !== null) candidates.push(routeDTO(r));
  if (resume !== undefined && resume !== null) {
    keys(resume, ['seat', 'route'], ['seat', 'route']);
    if (resume.seat !== seat) fail('resume role/family binding mismatch');
    candidates.push(routeDTO(resume.route));
  }
  for (const r of candidates) {
    allowedRoute(snapshot, policy.mode, r);
    if (!equalRoute(r, s.route)) fail('restricted worker exact role/model/effort binding mismatch');
  }
  const result = freeze({ snapshot, policy, seat, route: { ...s.route }, status: 'admitted-not-completed' });
  admissions.add(result);
  return result;
}

export function workerAliasRoutes({ snapshot, policy, seat }) {
  const { route } = admitWorker({ snapshot, policy, seat });
  if (route.provider !== 'openrouter') return [];
  let models = WORKER_ALIASES[route.model] ?? [];
  if (policy.mode === 'free') {
    models = FREE_ALIAS_SEATS.includes(seat) && route.model === 'deepseek/deepseek-v4.1-flash-1017'
      ? ['z-ai/glm-5.3-flash', 'google/gemma-4-31b-it:free'] : [];
  }
  return models.map(model => ({ provider: route.provider, model, effort: route.effort }));
}

export function admitResolvedWorker({ snapshot, policy, seat, actual }) {
  const admission = admitWorker({ snapshot, policy, seat });
  const route = routeDTO(actual);
  if (equalRoute(route, admission.route)) return admission;
  if (!workerAliasRoutes({ snapshot, policy, seat }).some(alias => equalRoute(alias, route))) fail('worker alias not approved for seat');
  if (policy.mode === 'free' && !FREE_HOSTED.includes(target(route))) fail('Free hosted exception must match exact ID');
  const result = freeze({ snapshot, policy, seat, route, status: 'admitted-not-completed' });
  admissions.add(result);
  return result;
}
/** Call again at actual outbound boundary with REVISED CURRENT trusted snapshot/policy.
 * Any config snapshot replacement or ancestry revision drift forces fresh admission.
 * Adapter must prevent TOCTOU between this predicate and request construction/transport.
 */
export function checkFinalWorkerRoute(admission, { snapshot, policy, actual }) {
  if (!admissions.has(admission)) fail('trusted admission required');
  requireSnapshot(snapshot, policy);
  if (admission.snapshot !== snapshot) fail('stale config snapshot; re-admit');
  if (JSON.stringify(admission.policy) !== JSON.stringify(policy)) fail('revised current policy; re-admit');
  admitResolvedWorker({ snapshot, policy, seat: admission.seat, actual });
  if (!equalRoute(routeDTO(actual), admission.route)) fail('actual route differs');
  return true;
}

export const RISK_RANK = freeze({ low: 0, normal: 1, high: 2 });
const requiredBrief = ['unit', 'objective', 'scope', 'acceptance', 'risk', 'changes'];
const briefFields = [...requiredBrief, 'constraints', 'evidence', 'remaining_work', 'override_reason'];
/** Preserved fence/blockquote/inline example filtering; prose values keep inline code. */
export function declarationText(brief, stripInline = true) {
  const prefix = String.raw`^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*`;
  const fenceRe = new RegExp(`${prefix}(\x60{3,}|~{3,})`);
  const closeRe = new RegExp(`${prefix}(\x60{3,}|~{3,})[ \\t]*$`);
  const quoteRe = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*>/;
  const kept = [];
  let fence = '';
  for (const line of brief.split('\n')) {
    if (fence) { const close = closeRe.exec(line)?.[1] ?? ''; if (close && close[0] === fence[0] && close.length >= fence.length) fence = ''; continue; }
    const run = fenceRe.exec(line)?.[1] ?? '';
    if (run) fence = run;
    else if (!quoteRe.test(line)) kept.push(line);
  }
  const value = kept.join('\n');
  return stripInline ? value.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, '') : value;
}
function jsonRecord(raw, allowed) {
  // Top-level duplicate keys including escaped spellings, before JSON.parse drops them.
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const seen = new Set();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '{' || t === '[') depth++;
    else if (t === '}' || t === ']') depth--;
    else if (depth === 1 && t.startsWith('"') && tokens[i + 1] === ':') { const k = JSON.parse(t); if (seen.has(k)) fail(`duplicate field ${k}`); seen.add(k); }
  }
  const value = JSON.parse(raw);
  keys(value, allowed);
  return value;
}
function statedRisk(raw) {
  const levels = [...new Set([...declarationText(raw).matchAll(/(?:^|[.;!?|][ \t]+)[ \t#*_>-]*RISK[*_]*[ \t]*[:=-]?[*_]*[ \t]*(low|normal|high)\b/gim)].map((m) => m[1].toLowerCase()))];
  if (levels.length > 1) fail('conflicting RISK declarations');
  return levels[0];
}
function dispatchFields(raw, legacyProseChanges) {
  if (typeof raw !== 'string' || raw.length > 12000) fail('brief invalid/exceeds 12000 characters');
  if (raw.trim().startsWith('{')) return jsonRecord(raw, briefFields);
  const aliases = { goal: 'objective', task: 'objective', files: 'scope', targets: 'scope', 'acceptance criteria': 'acceptance', verify: 'acceptance', verification: 'acceptance' };
  const fields = Object.create(null);
  let field = '';
  for (const line of declarationText(raw, false).split('\n')) {
    const m = /^\s*(?:#{1,6}\s*)?(UNIT|OBJECTIVE|GOAL|TASK|SCOPE|FILES|TARGETS|ACCEPTANCE(?: CRITERIA)?|VERIFY|VERIFICATION|CHANGES|RISK|CONSTRAINTS|EVIDENCE|REMAINING_WORK)\s*(?::\s*|$)(.*)$/i.exec(line);
    if (m) {
      field = aliases[m[1].toLowerCase()] ?? m[1].toLowerCase();
      if (Object.hasOwn(fields, field)) fail(`duplicate brief field ${field}`);
      fields[field] = m[2].trim();
    } else {
      // Enhancement: reject unknown all-uppercase labels rather than swallowing them as scope.
      if (/^\s*[A-Z][A-Z_ ]*:\s*/.test(line) && !/^OVERRIDE:/.test(line)) fail('unknown prose field');
      if (field && !/^OVERRIDE:/.test(line)) fields[field] += `\n${line}`;
    }
  }
  if (!fields.unit) {
    const ids = [...new Set([...declarationText(raw).matchAll(/\bunit:?\s+([A-Z0-9][\w.-]*)/gi)].map((m) => m[1].toUpperCase()))];
    if (ids.length === 1) fields.unit = ids[0];
  }
  const risk = statedRisk(raw), fieldRisk = fields.risk?.split('\n', 1)[0].trim();
  if (risk && fieldRisk && fieldRisk !== risk) fail('conflicting RISK declarations');
  if (risk) fields.risk = risk;
  if (legacyProseChanges && !Object.hasOwn(fields, 'changes')) fields.changes = 'unspecified in legacy prose; inspect the stated scope';
  return fields;
}
const nonempty = (v) => typeof v === 'string' && !!v.trim();
const stringValue = (v) => nonempty(v) || (Array.isArray(v) && v.length > 0 && v.every(nonempty));
function validateBrief(fields) {
  const result = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!stringValue(v)) fail(`missing or invalid brief field ${k}`);
    result[k] = (Array.isArray(v) ? v.join('\n') : v).trim();
  }
  for (const k of requiredBrief) if (!result[k]) fail(`missing or invalid brief field ${k}`);
  result.unit = result.unit.toUpperCase();
  if (!/^[A-Z0-9][\w.-]*$/.test(result.unit)) fail('unit must be one stable identifier');
  if (!Object.hasOwn(RISK_RANK, result.risk)) fail('risk must be low, normal or high');
  if (result.override_reason !== undefined && result.override_reason.length < 5) fail('override_reason needs a specific missed fact');
  if (JSON.stringify(result).length > 12000) fail('structured brief exceeds 12000 characters');
  return freeze(result);
}
/** originalOwnedUser is selected by CALLER from earliest original-owned USER record only.
 * Core checks shape/ownership, cannot authenticate records or select historical messages.
 * Partial resumes keep original unit/risk floor. Complete resumes may lower declared risk.
 */
export function parseDispatchBrief(raw, { originalOwnedUser, ownerSessionID, legacyProseChanges = false } = {}) {
  if (typeof legacyProseChanges !== 'boolean') fail('invalid compatibility option');
  const current = dispatchFields(raw, legacyProseChanges);
  let original;
  if (originalOwnedUser !== undefined) {
    keys(originalOwnedUser, ['role', 'sessionID', 'text'], ['role', 'sessionID', 'text']);
    if (originalOwnedUser.role !== 'user' || !text(ownerSessionID) || originalOwnedUser.sessionID !== ownerSessionID) fail('resume original must be caller-owned user record');
    original = validateBrief(dispatchFields(originalOwnedUser.text, legacyProseChanges));
    if (current.unit !== undefined && (!stringValue(current.unit) || String(Array.isArray(current.unit) ? current.unit.join('\n') : current.unit).trim().toUpperCase() !== original.unit)) fail('resume cannot change unit identity');
  }
  const complete = requiredBrief.every((k) => stringValue(current[k]));
  if (!complete && original) {
    const fields = { ...original, ...current, remaining_work: raw.trim() };
    // A legacy prose placeholder is not an explicit update to original changes.
    if (!raw.trim().startsWith('{') && !/^\s*(?:#{1,6}\s*)?CHANGES\s*(?::\s*|$)/im.test(declarationText(raw, false))) fields.changes = original.changes;
    const risk = Array.isArray(fields.risk) ? fields.risk.join('\n').trim() : fields.risk?.trim();
    if (Object.hasOwn(RISK_RANK, risk) && RISK_RANK[original.risk] > RISK_RANK[risk]) fields.risk = original.risk;
    return validateBrief(fields);
  }
  return validateBrief(current);
}
/** Raw quoted/fenced OVERRIDE has no effect. Factual reason is NOT permission. */
export function overrideReason(raw, brief) {
  if (brief?.override_reason) return brief.override_reason;
  const m = /^OVERRIDE:[ \t]*(\S.{4,})$/m.exec(declarationText(raw));
  return m?.[1].trim();
}
/** Judge opinion only: deterministic route/brief/floor and human permissions remain separate.
 * The adapter must explicitly approve the exact scoped factual reason; model text cannot self-approve.
 */
export function checkJudge({ raw, brief, seat, judge, approvedOverrideReason }) {
  const binding = TIER_SEATS[seat];
  if (!binding) return true; // source: reviewer/critic are not tier-checked
  const reason = overrideReason(raw, brief);
  if (reason && reason === approvedOverrideReason) return true;
  const tiers = binding[0] === 'tier' ? ['cheap', 'default', 'max'] : ['easy', 'hard'];
  if (!object(judge) || judge.unavailable || !tiers.includes(judge.tier) || judge.tier !== binding[1]) fail('judge unavailable/unknown/mismatched tier');
  if (binding[0] === 'tier') {
    if (!Object.hasOwn(RISK_RANK, judge.risk)) fail('judge unknown risk');
    if (RISK_RANK[judge.risk] > RISK_RANK[brief.risk]) fail('judge risk raises declared risk floor');
  }
  return true;
}

const tiers = ['cheap', 'default', 'max'];
const reviewStates = new WeakSet();
function normalizeReviewState(input) {
  keys(input, ['v', 'units'], ['v', 'units']);
  if (input.v !== 1 || !object(input.units)) fail('invalid review state');
  keys(input.units, Object.keys(input.units));
  const units = Object.create(null), admissionIDs = new Set(), reviewIDs = new Set();
  for (const [unit, e] of Object.entries(input.units)) {
    if (!/^[A-Z0-9][\w.-]*$/.test(unit)) fail('invalid review unit');
    keys(e, ['family', 'role', 'tier', 'floor', 'attempt', 'failed_reviews', 'reviewed_attempt', 'seen', 'admissions'], ['family', 'role', 'tier', 'floor', 'attempt', 'failed_reviews', 'reviewed_attempt', 'seen', 'admissions']);
    if (!Object.hasOwn(WORKER_FAMILIES, e.family) || !['executor', 'video-assistant', 'motion-vfx'].includes(e.role) || !tiers.includes(e.tier) || !tiers.includes(e.floor) || e.floor !== e.tier
      || !integer(e.attempt) || e.attempt < 1 || !integer(e.failed_reviews) || e.failed_reviews > e.attempt || !integer(e.reviewed_attempt) || e.reviewed_attempt > e.attempt
      || !Array.isArray(e.seen) || !e.seen.every(text) || new Set(e.seen).size !== e.seen.length
      || !Array.isArray(e.admissions) || e.admissions.length !== e.attempt) fail('corrupt review unit');
    const admissions = e.admissions.map((a, i) => {
      keys(a, ['id', 'tier', 'attempt'], ['id', 'tier', 'attempt']);
      if (!text(a.id) || !tiers.includes(a.tier) || a.attempt !== i + 1
        || (i > 0 && tiers.indexOf(a.tier) < tiers.indexOf(e.admissions[i - 1].tier))) fail('corrupt admission history');
      return { ...a };
    });
    if (new Set(admissions.map((a) => a.id)).size !== admissions.length || admissions.at(-1).tier !== e.tier) fail('corrupt admission history');
    for (const a of admissions) { if (admissionIDs.has(a.id)) fail('cross-unit admission ID conflict'); admissionIDs.add(a.id); }
    for (const id of e.seen) { if (reviewIDs.has(id)) fail('cross-unit review ID conflict'); reviewIDs.add(id); }
    units[unit] = { ...e, seen: [...e.seen], admissions };
  }
  const result = freeze({ v: 1, units });
  reviewStates.add(result);
  return result;
}
/** Serialization/reload validation ONLY, not persistence or a concurrency lock. */
export const restoreReviewState = (input) => normalizeReviewState(input);
export const emptyReviewState = () => normalizeReviewState({ v: 1, units: {} });
function stateRequired(state) { if (!reviewStates.has(state)) fail('validated immutable review state required'); }
export function requiredReviewTier(state, unit) {
  stateRequired(state);
  const e = state.units[unit];
  return e ? (e.failed_reviews >= 2 ? tiers[Math.min(tiers.indexOf(e.tier) + 1, 2)] : e.floor) : 'cheap';
}
/** Pure admission reducer: idempotent admission IDs, NOT actual completion evidence.
 * floors never decrease; after two distinct failed reviewed attempts require next same-role/family tier.
 */
export function reduceAdmission(state, { id, unit, seat }) {
  stateRequired(state);
  if (!text(id) || !/^[A-Z0-9][\w.-]*$/.test(unit) || TIER_SEATS[seat]?.[0] !== 'tier') fail('invalid admission binding');
  const family = Object.keys(WORKER_FAMILIES).find((f) => WORKER_FAMILIES[f].includes(seat));
  const role = seat.replace(/-(cheap|max|strong)$/, '').replace(/-(s|f)$/, '');
  const tier = TIER_SEATS[seat][1], e = state.units[unit];
  for (const [u, entry] of Object.entries(state.units)) {
    const priorAdmission = entry.admissions.find((a) => a.id === id);
    if (priorAdmission) {
      if (u !== unit || entry.family !== family || entry.role !== role || priorAdmission.tier !== tier) fail('admission ID binding conflict');
      return state;
    }
  }
  if (e && (e.family !== family || e.role !== role)) fail('review unit family/role conflict');
  if (tiers.indexOf(tier) < tiers.indexOf(requiredReviewTier(state, unit))) fail('review floor/escalation requires higher tier');
  const next = {
    family, role, tier, floor: e && tiers.indexOf(e.floor) > tiers.indexOf(tier) ? e.floor : tier,
    attempt: (e?.attempt ?? 0) + 1, failed_reviews: e?.tier === tier ? e.failed_reviews : 0,
    reviewed_attempt: e?.tier === tier ? e.reviewed_attempt : 0, seen: e?.seen ?? [],
    admissions: [...(e?.admissions ?? []), { id, tier, attempt: (e?.attempt ?? 0) + 1 }],
  };
  return normalizeReviewState({ v: 1, units: { ...state.units, [unit]: next } });
}
/** Exactly one start-column unquoted/unfenced REVIEW JSON; no legacy VERDICT.
 * Unknown/duplicate fields rejected (strengthening); fail maps to revise as in source.
 */
export function reviewVerdict(raw, unit) {
  if (typeof raw !== 'string' || raw.length > 12000) return undefined;
  const lines = declarationText(raw, false).split('\n').filter((l) => l.startsWith('REVIEW:'));
  if (lines.length !== 1) return undefined;
  try {
    const v = jsonRecord(lines[0].slice(7).trim(), ['unit', 'verdict', 'evidence']);
    if (typeof v.unit !== 'string' || v.unit.toUpperCase() !== unit || !['pass', 'revise', 'fail'].includes(v.verdict) || !nonempty(v.evidence)) return undefined;
    return v.verdict === 'pass' ? 'pass' : 'revise';
  } catch { return undefined; }
}
/** Caller supplies trusted pending call binding. Default preserves older same-tier results when
 * reviewed_attempt < attempt <= current attempt. Newer applied result makes older result stale.
 * exact-current is an opt-in strengthening, not source compatibility.
 */
export function reduceReview(state, { id, unit, family, role, tier, attempt, raw }, { mode = 'same-tier-pending' } = {}) {
  stateRequired(state);
  if (!['same-tier-pending', 'exact-current'].includes(mode)) fail('unknown review ordering mode');
  if (!text(id) || !integer(attempt) || attempt < 1 || !tiers.includes(tier) || !Object.hasOwn(WORKER_FAMILIES, family) || !['executor', 'video-assistant', 'motion-vfx'].includes(role)) fail('invalid pending review binding');
  const e = state.units[unit];
  const verdict = reviewVerdict(raw, unit);
  if (!e || !verdict || e.family !== family || e.role !== role || e.tier !== tier || e.seen.includes(id) || attempt > e.attempt || attempt <= e.reviewed_attempt || (mode === 'exact-current' && attempt !== e.attempt)) return state;
  for (const entry of Object.values(state.units)) if (entry.seen.includes(id)) fail('review ID unit binding conflict');
  return normalizeReviewState({ v: 1, units: { ...state.units, [unit]: { ...e, reviewed_attempt: attempt, seen: [...e.seen, id], failed_reviews: verdict === 'pass' ? 0 : e.failed_reviews + 1 } } });
}
