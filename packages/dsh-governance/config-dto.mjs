/** Reviewed-roster -> normalized governance config DTO.
 * Source of record: ROOT/staging/config/role-roster.example.json
 * (schema dsh-role-roster-whitelist/v1, auth values excluded at extraction).
 * This module never reads dsh.jsonc, keys or credentials; a roster lacking the
 * explicit auth_values_excluded markers is refused. Output feeds policy.mjs
 * normalizeConfig, which applies its own strict validation and freezing.
 */
import { WORKER_FAMILIES } from './policy.mjs';

const fail = (message) => { throw new Error(`config-dto: ${message}`); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (v) => typeof v === 'string' && v.trim().length > 0 && v === v.trim();

const SECRETISH = /(key|token|secret|password|credential|authorization|bearer)/i;
const PROVIDER_FIELDS = ['baseURL', 'auth_values_excluded'];

const workerFamilyOf = (seat) => Object.keys(WORKER_FAMILIES).find((family) => WORKER_FAMILIES[family].includes(seat));

/** Split a configured_target 'provider/model/with/slashes' into provider + model. */
export function splitTarget(target) {
  if (!text(target)) fail('configured_target must be a non-empty string');
  const slash = target.indexOf('/');
  if (slash < 1 || slash === target.length - 1) fail(`configured_target must be provider/model: ${target}`);
  return { provider: target.slice(0, slash), model: target.slice(slash + 1) };
}

/** Validate the reviewed whitelist shape and build the normalizeConfig DTO.
 * `revision` overrides the roster-derived revision (roster source_sha256 prefix).
 * Only worker-family seats enter the DTO; primary seats stay primary concerns.
 */
export function buildRosterConfigDTO(roster, { revision } = {}) {
  if (!object(roster)) fail('roster must be a plain object');
  if (roster.schema !== 'dsh-role-roster-whitelist/v1') fail('roster schema must be dsh-role-roster-whitelist/v1');
  if (!Array.isArray(roster.agents) || roster.agents.length === 0) fail('roster.agents must be a non-empty array');
  if (!object(roster.providers) || Object.keys(roster.providers).length === 0) fail('roster.providers must be a non-empty object');
  for (const key of Reflect.ownKeys(roster)) {
    if (typeof key !== 'string' || SECRETISH.test(key)) fail(`roster carries a secret-looking field: ${String(key)}`);
  }

  const providers = Object.create(null);
  for (const [id, p] of Object.entries(roster.providers)) {
    if (!object(p)) fail(`provider ${id} must be an object`);
    for (const key of Reflect.ownKeys(p)) {
      if (typeof key !== 'string' || !PROVIDER_FIELDS.includes(key)) fail(`provider ${id} carries unexpected field ${String(key)} (auth values are forbidden here)`);
    }
    if (p.auth_values_excluded !== true) fail(`provider ${id} must attest auth_values_excluded`);
    if (p.baseURL !== null && !text(p.baseURL)) fail(`provider ${id} baseURL must be null or a trimmed string`);
    providers[id] = { baseURL: p.baseURL };
  }

  const efforts = new Set();
  const seats = Object.create(null);
  for (const agent of roster.agents) {
    if (!object(agent)) fail('roster agent entry must be an object');
    const { seat, enabled, configured_target, configured_effort } = agent;
    if (!text(seat) || workerFamilyOf(seat) === undefined) continue; // primary/auxiliary seats are not worker DTO seats
    if (Object.hasOwn(seats, seat)) fail(`duplicate worker seat ${seat}`);
    if (typeof enabled !== 'boolean') fail(`seat ${seat} enabled flag must be boolean`);
    const { provider, model } = splitTarget(configured_target);
    if (!Object.hasOwn(providers, provider)) fail(`seat ${seat} targets unconfigured provider ${provider}`);
    if (!(configured_effort === null || text(configured_effort))) fail(`seat ${seat} effort must be null or a trimmed string`);
    if (configured_effort !== null) efforts.add(configured_effort);
    seats[seat] = { enabled, route: { provider, model, effort: configured_effort } };
  }
  if (Object.keys(seats).length === 0) fail('roster produced no worker seats');

  const effortVocabulary = efforts.size > 0 ? [...efforts].sort() : null;
  const derived = text(roster.source_sha256) ? `roster-${roster.source_sha256.slice(0, 16)}` : null;
  return {
    revision: text(revision) ? revision : (derived ?? fail('DTO revision must be supplied or derivable from roster source_sha256')),
    providers,
    seats,
    ...(effortVocabulary === null ? {} : { efforts: effortVocabulary }),
  };
}
