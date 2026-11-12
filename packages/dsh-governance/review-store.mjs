/** Durable review-floor state on top of ctx.storageDomain.
 * One aggregate per review unit: table `units`, key = unit id,
 * record = plain JSON { v: 1, unit, entry }. Records validate by rebuilding a
 * single-unit aggregate through governance-core restoreReviewState; the full
 * cross-unit state (admission/review ID conflicts, floors) validates again on
 * every read via restoreReviewState over the assembled map. Any corruption or
 * conflict throws — callers fail closed. Writes are durable-before-memory per
 * storage-domain semantics. 2026-11-08: wrappers sharing a domain serialize
 * the complete read/reduce/write operation; distinct domains need a single writer.
 */
import {
  emptyReviewState, restoreReviewState, reduceAdmission, reduceReview, requiredReviewTier,
} from './policy.mjs';

const UNIT_RE = /^[A-Z0-9][\w.-]*$/;
const fail = (message) => { throw new Error(`review-store: ${message}`); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const plainCopy = (v) => JSON.parse(JSON.stringify(v));

/** Duck-typed record schema for the storage domain: parse() validates and
 * returns plain JSON. A throwing parse fails the domain open (invalid-record),
 * which the facade treats as governance-unavailable (fail closed).
 */
export const unitRecordSchema = {
  parse(raw) {
    if (!object(raw)) fail('record must be an object');
    const keys = Reflect.ownKeys(raw);
    if (keys.some(k => !['v', 'unit', 'entry', 'owner'].includes(k)) || !['v', 'unit', 'entry'].every((k) => raw[k] !== undefined)) fail('invalid record fields');
    if (raw.v !== 1) fail('record v must be 1');
    if (typeof raw.unit !== 'string' || !UNIT_RE.test(raw.unit)) fail('record unit must be a stable identifier');
    if (!object(raw.entry)) fail('record entry must be an object');
    if (raw.owner !== undefined && (typeof raw.owner !== 'string' || !raw.owner)) fail('invalid owner');
    // Full structural validation of the unit aggregate via the tested core.
    try { restoreReviewState({ v: 1, units: { [raw.unit]: raw.entry } }); }
    catch (error) { fail(`record entry is not a valid review aggregate (${error?.message})`); }
    return Object.freeze(plainCopy(raw));
  },
};

/** Plain spec literal consumed by ctx.storageDomain.open(); the facility uses
 * name/version/tables and valueSchema.parse directly (no defineDomain import
 * is possible from a dependency-free local bundle package).
 */
export const REVIEW_DOMAIN_SPEC = Object.freeze({
  name: 'dsh_review_floors',
  version: 1,
  tables: { units: { valueSchema: unitRecordSchema } },
});

const unitRecordOf = (state, unit, owner) => plainCopy({ v: 1, unit, entry: state.units[unit], owner });
const queues = new WeakMap();

/** Rebuild a branded single-unit reducer state from one stored record. */
export function stateFromRecord(record) {
  if (!object(record) || typeof record.unit !== 'string' || !UNIT_RE.test(record.unit) || !object(record.entry)) fail('unreadable unit record');
  try { return restoreReviewState({ v: 1, units: { [record.unit]: record.entry } }); }
  catch (error) { fail(`stored unit ${record.unit} is corrupt (${error?.message})`); }
}

export function createReviewStore(domain) {
  const table = domain.table('units');
  function serialize(action) {
    const pending = (queues.get(domain) ?? Promise.resolve()).catch(() => {}).then(action);
    queues.set(domain, pending);
    const clear = () => { if (queues.get(domain) === pending) queues.delete(domain); };
    pending.then(clear, clear);
    return pending;
  }

  /** Assemble the complete branded state from every stored unit aggregate.
   * Cross-unit ID conflicts, lowered floors or malformed entries throw.
   */
  function readState() {
    const units = Object.create(null);
    for (const [key, record] of table.entries()) {
      const state = stateFromRecord(record);
      const unit = Object.keys(state.units)[0];
      if (unit !== key) fail(`stored unit ${unit} disagrees with its key ${key}`);
      units[unit] = state.units[unit];
    }
    return Object.keys(units).length === 0 ? emptyReviewState() : restoreReviewState({ v: 1, units });
  }

  /** Durable admission record; the reducer runs again inside the write chain.
   * Returns the branded next state (update() itself yields the stored record).
   */
  function applyAdmission({ id, unit, seat, owner }) {
    return serialize(async () => {
      if (typeof owner !== 'string' || !owner) fail('admission owner required');
      const state = readState();
      const record = table.get(unit);
      if (record !== undefined && record.owner !== owner) fail('unit owner unavailable or mismatched');
      const next = reduceAdmission(state, { id, unit, seat });
      if (record === undefined) await table.put(unit, unitRecordOf(next, unit, owner));
      else await table.update(unit, () => unitRecordOf(next, unit, owner));
      return next;
    });
  }

  /** Durable review record; returns { next, applied }. Not-applied (stale,
   * duplicate, malformed) keeps the stored aggregate unchanged.
   */
  function applyReview(binding) {
    return serialize(async () => {
      const { unit, owner, ...review } = binding;
      const state = readState();
      if (!state.units[unit]) fail(`no stored admission for unit ${unit}`);
      if (!owner || table.get(unit)?.owner !== owner) fail('unit owner unavailable or mismatched');
      const next = reduceReview(state, { unit, ...review }, { mode: 'exact-current' });
      const applied = next !== state;
      if (applied) await table.update(unit, () => unitRecordOf(next, unit, owner));
      return { next, applied };
    });
  }

  return Object.freeze({ readState, ownerOf: unit => table.get(unit)?.owner, applyAdmission, applyReview, requiredReviewTier });
}
