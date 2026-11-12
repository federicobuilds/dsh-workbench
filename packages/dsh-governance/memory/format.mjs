// Project memory format checks (MEMORY-FORMAT-GLOBAL-P1, 2026-10-26). A project's memory is complete only when
// its required Markdown exists, every current note, section, fact and record has an agent-written plain-language
// explanation bound to the note's exact bytes, and memory.html is published for exactly that state. Validation
// is read-only; initialization creates only absent derived files. Neither writes or rolls back source Markdown,
// and neither invents explanations: a hook cannot know what an arbitrary note means.
import { buildMemorySnapshot, createDerivedIfAbsent, OUTPUT_NAME } from "./index.mjs"
import { READABLE_NAME, READABLE_VERSION } from "./readable.mjs"

export const REQUIRED_SOURCES = ["INDEX.md", "changelog.md"]
const MAX_REPORTED = 50

const byDoc = (items, key) => {
  const map = new Map()
  for (const item of items) (map.get(item.docId) ?? map.set(item.docId, []).get(item.docId)).push(item[key])
  return map
}

/** Check one snapshot. Items name paths, ids and fixed reason codes only, never source or error text. */
export function validateSnapshot(snapshot) {
  const missing = []
  const add = (kind, reason, rel, id) => missing.push({ kind, reason, ...(rel ? { rel } : {}), ...(id === undefined ? {} : { id }) })
  const rels = new Set(snapshot.docs.map((doc) => doc.rel))
  for (const rel of REQUIRED_SOURCES) if (!rels.has(rel)) add("source", "missing", rel)
  for (const item of snapshot.census.unavailable) add("source", "unavailable", item.path)
  const { model, readable } = snapshot
  if (readable.state === "absent") add("explanations", "missing", READABLE_NAME)
  else if (readable.state !== "ok") add("explanations", readable.reason ?? "invalid", READABLE_NAME)
  else {
    for (const rel of readable.stale) add("doc", "stale", rel)
    for (const rel of readable.orphaned) add("doc", "orphan", rel)
    const stale = new Set(readable.stale)
    const sections = byDoc(model.sections, "id")
    const facts = byDoc(model.facts, "id")
    const records = byDoc(model.timeline, "line")
    for (const doc of snapshot.docs) {
      if (stale.has(doc.rel)) continue
      const entry = readable.docs.get(doc.id)
      if (!entry?.explanation) add("doc", "uncovered", doc.rel)
      for (const id of sections.get(doc.id) ?? []) if (!entry?.sections.has(id)) add("section", "uncovered", doc.rel, id)
      for (const id of facts.get(doc.id) ?? []) if (!entry?.facts.has(id)) add("fact", "uncovered", doc.rel, id)
      for (const line of records.get(doc.id) ?? []) if (!entry?.records.has(line)) add("record", "uncovered", doc.rel, line)
    }
  }
  const output = snapshot.output
  const marker = `<meta name="memory-source-hash" content="${snapshot.sourceHash}">`
  if (!output) add("publication", "unpublished", OUTPUT_NAME)
  else if (output.mode !== 0o600) add("publication", "unsafe-mode", OUTPUT_NAME)
  else if (!Buffer.from(output.head, "base64").toString("utf8").includes(marker)) add("publication", "stale", OUTPUT_NAME)
  return {
    complete: missing.length === 0,
    project: snapshot.project,
    projectId: snapshot.projectId,
    sourceHash: snapshot.sourceHash,
    counts: { docs: snapshot.docs.length, sections: model.sections.length, facts: model.facts.length, records: model.timeline.length },
    missingCount: missing.length,
    missing: missing.slice(0, MAX_REPORTED),
  }
}

/** Read-only completeness check of the project's current disk state. */
export async function validateMemoryPublication(projectRoot) {
  return validateSnapshot(await buildMemorySnapshot(projectRoot))
}

/**
 * Derived initializer, run only after a permitted source write: creates an empty memory.readable.json bound to
 * this project when none exists. Empty means every note is reported as needing authoring, never as complete.
 */
export async function initializeDerived(projectRoot) {
  const snapshot = await buildMemorySnapshot(projectRoot)
  if (snapshot.readable.state !== "absent") return { created: false }
  const body = `${JSON.stringify({ version: READABLE_VERSION, project: snapshot.projectId, docs: [] }, null, 2)}\n`
  return { created: await createDerivedIfAbsent(snapshot, READABLE_NAME, body) }
}

/** One deterministic sentence for a refusal or an appended status line. */
export function describeIncomplete(result) {
  const kinds = {}
  for (const item of result.missing) kinds[`${item.kind} ${item.reason}`] = (kinds[`${item.kind} ${item.reason}`] ?? 0) + 1
  const first = result.missing.slice(0, 5).map((item) => [item.kind, item.reason, item.rel, item.id].filter((v) => v !== undefined).join(" ")).join("; ")
  return `Project memory at ${result.project} is incomplete: ${result.missingCount} item(s) need work (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}${result.missingCount > result.missing.length ? ", more not listed" : ""}). First: ${first}.`
}
