/** Durable harness decision/event log on ctx.storageDomain. Every judge decision,
 * MCP-gate block, redaction, and check/resource refusal is recorded here so the
 * transparency UI (and the dsh_governance_events tool) can show "what stopped what,
 * and why." One table `events`, keyed by event id. Reads revalidate records.
 */
import { redactText } from './redaction.mjs';

const EVENT_KINDS = ['judge', 'mcp-gate', 'redaction', 'test-guard', 'check', 'resource', 'dispatch', 'review', 'efficiency', 'info'];

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const EVENTS_DOMAIN_SPEC = Object.freeze({
  name: 'dsh_governance_events',
  version: 1,
  tables: { events: { valueSchema: { parse(raw) {
    if (!plain(raw)) throw new Error('harness-events: record must be an object');
    if (raw.v !== 1) throw new Error('harness-events: v must be 1');
    if (typeof raw.id !== 'string' || !raw.id) throw new Error('harness-events: bad id');
    if (!Number.isSafeInteger(raw.ts)) throw new Error('harness-events: bad ts');
    if (!EVENT_KINDS.includes(raw.kind)) throw new Error('harness-events: bad kind');
    if (typeof raw.decision !== 'string') throw new Error('harness-events: bad decision');
    return raw;
  } } } },
});

/** Build an event record; reason/detail are bounded, never carry command bodies or secrets. */
export function makeEvent({ kind, session, decision, reason, unit, tool }) {
  if (!EVENT_KINDS.includes(kind)) throw new Error('harness-events: invalid kind');
  const rec = { v: 1, id: '', ts: Date.now(), kind, session: session ?? null, decision };
  if (unit !== undefined) rec.unit = redactText(String(unit)).text.slice(0, 120);
  if (tool !== undefined) rec.tool = redactText(String(tool)).text.slice(0, 80);
  if (reason !== undefined) rec.reason = redactText(String(reason)).text.slice(0, 600);
  return rec;
}

export function createEventStore(domain) {
  const table = domain.table('events');
  async function record(event) {
    // id assigned by caller (uuid) before put; table key = event.id.
    const safe = {};
    for (const [key, value] of Object.entries(event)) {
      if (value !== null && typeof value === 'object') throw new Error('Event log accepts flat metadata only');
      // Native identity fields select the record/session; never rewrite them.
      safe[key] = typeof value === 'string' && !['id', 'session'].includes(key) ? redactText(value).text : value;
    }
    await table.put(safe.id, safe);
    return safe;
  }
  function recent(limit = 50) {
    const out = [];
    for (const [id, rec] of table.entries()) out.push(rec);
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, Math.max(1, limit));
  }
  return Object.freeze({ record, recent });
}
