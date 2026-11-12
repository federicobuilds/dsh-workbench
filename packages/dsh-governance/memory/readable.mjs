// Plain-language explanation cache (MEMORY-KNOWLEDGE-ELI5, 2026-10-25). memory.readable.json is a derived
// projection authored against exact source bytes; the Markdown stays the only authority. A document entry
// is used only while its sha256 matches the current bytes, so edited, renamed or deleted sources fall back
// to "needs updating" with the original intact instead of silently reusing an old explanation.
export const READABLE_NAME = "memory.readable.json"
export const READABLE_VERSION = 1
// 2026-10-26 (MEMORY-FORMAT-GLOBAL-P1): hard cap mirrored in fsanchor.py READABLE_MAX; 1 MiB could not hold full
// explanations for a large workspace. The text, document and item limits below are unchanged.
export const READABLE_MAX_BYTES = 16 << 20
const MAX_TEXT = 4000
const MAX_DOCS = 2000
const MAX_ITEMS = 20000
const SHA = /^[0-9a-f]{64}$/
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

const MESSAGES = {
  unreadable: "The plain-language file could not be read safely (it is a link, not a regular file, or owned by another user).",
  oversize: "The plain-language file is larger than 16 MiB, so it was not read.",
  malformed: "The plain-language file is not valid JSON.",
  schema: "The plain-language file does not follow version 1 of its format",
  "foreign-project": "The plain-language file was written for a different project.",
  "item-outside-doc": "The plain-language file names a part that does not belong to its note",
}

class Invalid extends Error {
  constructor(code, at) {
    super(code)
    this.code = code
    this.at = at
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Exact key set: unknown keys (including __proto__ or constructor) reject the whole file. */
function shape(value, at, required, optional = []) {
  if (!isRecord(value)) throw new Invalid("schema", at)
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new Invalid("schema", `${at}: unknown field`)
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Invalid("schema", `${at}: missing field`)
}

function text(value, at, { optional = false } = {}) {
  if (value === undefined && optional) return ""
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT || CONTROL.test(value)) throw new Invalid("schema", at)
  return value.trim()
}

function list(value, at) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Invalid("schema", at)
  return value
}

/**
 * Validate the helper's raw read against the current snapshot and return plain explanations keyed by the
 * existing document, section, fact and timeline ids. `redact` is applied to every string before it can
 * reach HTML, the search payload or the model.
 */
export function loadReadable(found, { projectId, docs, model, redact }) {
  const empty = { state: "absent", reason: null, message: null, sha256: null, docs: new Map(), stale: [], orphaned: [], redactions: 0 }
  if (!found || found.status === "absent") return empty
  const fail = (reason, at) => ({ ...empty, state: "invalid", reason, sha256: found.sha256 ?? null, message: at ? `${MESSAGES[reason]} (at ${at}).` : MESSAGES[reason] })
  if (found.status === "oversize") return fail("oversize")
  if (found.status !== "present" || typeof found.content !== "string") return fail("unreadable")
  const bytes = Buffer.from(found.content, "base64")
  if (bytes.length > READABLE_MAX_BYTES) return fail("oversize")
  let data
  try {
    data = JSON.parse(bytes.toString("utf8"))
  } catch {
    return fail("malformed")
  }
  try {
    return { ...empty, state: "ok", sha256: found.sha256, ...validate(data, { projectId, docs, model, redact }) }
  } catch (error) {
    if (error instanceof Invalid) return fail(error.code, error.at)
    throw error
  }
}

function validate(data, { projectId, docs, model, redact }) {
  shape(data, "file", ["version", "project", "docs"])
  if (data.version !== READABLE_VERSION) throw new Invalid("schema", "version")
  if (typeof data.project !== "string" || !SHA.test(data.project)) throw new Invalid("schema", "project")
  if (data.project !== projectId) throw new Invalid("foreign-project")
  const entries = list(data.docs, "docs")
  if (entries.length > MAX_DOCS) throw new Invalid("schema", "docs: too many entries")
  const byRel = new Map(docs.map((doc) => [doc.rel, doc]))
  const owned = (items) => {
    const map = new Map()
    for (const item of items) (map.get(item.docId) ?? map.set(item.docId, new Set()).get(item.docId)).add(item.id ?? item.line)
    return map
  }
  const sectionIds = owned(model.sections)
  const factIds = owned(model.facts)
  const recordLines = owned(model.timeline)
  const seen = new Set()
  const out = new Map()
  const stale = []
  const orphaned = []
  let items = 0
  let redactions = 0
  const clean = (value) => {
    const { text: safe, count } = redact(value)
    redactions += count
    return safe
  }
  entries.forEach((entry, i) => {
    const at = `docs[${i}]`
    shape(entry, at, ["rel", "sha256"], ["title", "explanation", "sections", "facts", "records"])
    if (typeof entry.rel !== "string" || !entry.rel || entry.rel.length > 512 || CONTROL.test(entry.rel)) throw new Invalid("schema", `${at}.rel`)
    if (typeof entry.sha256 !== "string" || !SHA.test(entry.sha256)) throw new Invalid("schema", `${at}.sha256`)
    if (seen.has(entry.rel)) throw new Invalid("schema", `${at}.rel: duplicate`)
    seen.add(entry.rel)
    const title = text(entry.title, `${at}.title`, { optional: true })
    const explanation = text(entry.explanation, `${at}.explanation`, { optional: true })
    const sections = list(entry.sections, `${at}.sections`).map((s, k) => {
      shape(s, `${at}.sections[${k}]`, ["id", "explanation"], ["title"])
      return { id: text(s.id, `${at}.sections[${k}].id`), title: text(s.title, `${at}.sections[${k}].title`, { optional: true }), explanation: text(s.explanation, `${at}.sections[${k}].explanation`) }
    })
    const facts = list(entry.facts, `${at}.facts`).map((f, k) => {
      shape(f, `${at}.facts[${k}]`, ["id", "fact"], ["why", "how"])
      return { id: text(f.id, `${at}.facts[${k}].id`), fact: text(f.fact, `${at}.facts[${k}].fact`), why: text(f.why, `${at}.facts[${k}].why`, { optional: true }), how: text(f.how, `${at}.facts[${k}].how`, { optional: true }) }
    })
    const records = list(entry.records, `${at}.records`).map((r, k) => {
      shape(r, `${at}.records[${k}]`, ["line", "text"])
      if (!Number.isSafeInteger(r.line) || r.line < 1) throw new Invalid("schema", `${at}.records[${k}].line`)
      return { line: r.line, text: text(r.text, `${at}.records[${k}].text`) }
    })
    items += sections.length + facts.length + records.length
    if (items > MAX_ITEMS) throw new Invalid("schema", "docs: too many items")
    for (const [name, values, key] of [["sections", sections, "id"], ["facts", facts, "id"], ["records", records, "line"]]) {
      if (new Set(values.map((v) => v[key])).size !== values.length) throw new Invalid("schema", `${at}.${name}: duplicate`)
    }
    const doc = byRel.get(entry.rel)
    if (!doc) return void orphaned.push(entry.rel)
    if (doc.sha256 !== entry.sha256) return void stale.push(entry.rel)
    for (const [name, values, owners, key] of [["sections", sections, sectionIds, "id"], ["facts", facts, factIds, "id"], ["records", records, recordLines, "line"]]) {
      values.forEach((v, k) => {
        if (!owners.get(doc.id)?.has(v[key])) throw new Invalid("item-outside-doc", `${at}.${name}[${k}]`)
      })
    }
    out.set(doc.id, {
      title: title && clean(title),
      explanation: explanation && clean(explanation),
      sections: new Map(sections.map((s) => [s.id, { title: s.title && clean(s.title), explanation: clean(s.explanation) }])),
      facts: new Map(facts.map((f) => [f.id, { fact: clean(f.fact), why: f.why && clean(f.why), how: f.how && clean(f.how) }])),
      records: new Map(records.map((r) => [r.line, clean(r.text)])),
    })
  })
  return { docs: out, stale, orphaned, redactions }
}

/** Fingerprint part for sourceHash: a cache edit, a validation change or a schema bump republishes. */
export const readableFingerprint = (readable) => [READABLE_VERSION, readable.state, readable.reason, readable.sha256]
