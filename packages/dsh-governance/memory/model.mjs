// Knowledge model (MEMORY-VISUAL-STANDARD, 2026-10-24). Derives topics, facts, references, boards and a
// timeline from the redacted Markdown snapshot. Every item carries a source citation; nothing is inferred
// beyond explicit text: edges are Markdown links/path mentions or folder containment, dates come from
// dated changelog/status records, and archived run records stay labelled as history.
import { posix } from "node:path"

export const MODEL_VERSION = "knowledge-model-4"

const DATED = /(^|[-_])(20\d{2})(\d{2})(\d{2})([-_]|$)/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE = /^(```|~~~)/
const ISSUE_HEADING = /\b(known issues?|issues?|constraints?|open questions?|blocked|blockers?|risks?|limitations?|problems?|caveats?|gotchas?)\b/i
const DECISION_HEADING = /\b(decisions?|rules?|preferences?|polic(y|ies)|conventions?|principles?|lessons?|how to apply)\b/i
const CHANGELOG_STAMP = /^\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\]\s*(.*)$/
const CHANGELOG_FIELD = /^(What|Where|Why|How|Effect):\s*(.*)$/
const ISO_TS = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** Human label for a folder name: words from the slug plus the embedded date when present. */
export function humanizeFolder(name) {
  const date = name.match(DATED)
  const words = name.replace(DATED, " ").replace(/[-_]+/g, " ").trim()
  const label = words ? words.replace(/\b([a-z])/g, (c) => c.toUpperCase()) : name
  return date ? `${label} (${date[2]}-${date[3]}-${date[4]})` : label
}

/** Split redacted Markdown into heading-delimited sections; fenced code never counts as a heading. */
function sectionize(doc) {
  const lines = doc.raw.split(/\r?\n/)
  const sections = [{ index: 0, level: 0, heading: doc.title, lines: [], line: 1 }]
  let fenced = false
  lines.forEach((text, i) => {
    if (FENCE.test(text)) fenced = !fenced
    const match = !fenced && text.match(HEADING)
    if (match) sections.push({ index: sections.length, level: match[1].length, heading: match[2].replace(/[*_`]/g, ""), lines: [], line: i + 1 })
    else sections[sections.length - 1].lines.push(text)
  })
  // Renderer heading ids follow document order, so section n maps to anchor `${doc.id}-h${n}`. When the
  // raw heading count disagrees with the renderer (setext or indented headings), sections follow the
  // rendered chunks instead so every rendered body stays covered; line numbers are then unknown.
  const rendered = doc.headings ?? []
  if (sections.length - 1 !== rendered.length) {
    const chunks = doc.html.split(/(?=<h[1-6] id=")/)
    const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim()
    sections.length = 0
    sections.push({ index: 0, level: 0, heading: doc.title, lines: strip(chunks[0] ?? "").split("\n"), line: null })
    rendered.forEach((h, i) => sections.push({ index: i + 1, level: h.level, heading: h.text, lines: strip(chunks[i + 1] ?? "").split("\n"), line: null }))
  }
  return sections.map((section) => ({
    id: section.index === 0 ? doc.id : `${doc.id}-h${section.index}`,
    docId: doc.id,
    level: section.level,
    heading: section.heading,
    line: section.line,
    text: section.lines.join("\n").trim(),
  })).filter((section) => section.text || section.level > 0)
}

/** Paragraphs and list items of one section body, as plain Markdown units with their line offsets. */
function units(section) {
  const out = []
  let current = null
  let fenced = false
  const flush = () => {
    if (current && current.text.trim()) out.push({ text: current.text.trim(), line: current.line })
    current = null
  }
  section.text.split("\n").forEach((text, i) => {
    if (FENCE.test(text)) fenced = !fenced
    if (fenced || FENCE.test(text)) return flush()
    const line = section.line == null ? null : section.line + i + 1
    if (!text.trim()) return flush()
    if (/^\s*([-*+]|\d+[.)])\s+/.test(text)) {
      flush()
      current = { text: text.replace(/^\s*([-*+]|\d+[.)])\s+/, ""), line }
      return
    }
    if (/^\s*(\||>|#)/.test(text)) return flush()
    if (current) current.text += " " + text.trim()
    else current = { text: text.trim(), line }
  })
  flush()
  return out
}

/** Memory record format: "[fact]. Why: [reason]. How to apply: [when]". */
function parseRecord(text) {
  const match = text.match(/^(.*?)(?:\s*\*{0,2}Why\*{0,2}:\*{0,2}\s*(.*?))?(?:\s*\*{0,2}How to apply\*{0,2}:\*{0,2}\s*(.*))?$/s)
  if (!match || (!match[2] && !match[3])) return null
  return { fact: match[1].trim(), why: match[2]?.trim() ?? "", how: match[3]?.trim() ?? "" }
}

function sentenceAround(text, index) {
  const start = Math.max(text.lastIndexOf("\n", index), text.lastIndexOf(". ", index) + 1, 0)
  let end = text.indexOf("\n", index)
  const period = text.indexOf(". ", index)
  if (period !== -1 && (end === -1 || period < end)) end = period + 1
  if (end === -1) end = text.length
  return text.slice(start, end).trim().replace(/\s+/g, " ").slice(0, 240)
}

/** Explicit references: Markdown links to memory files plus bare path or folder mentions. */
function references(doc, sections, ids, folders) {
  const found = []
  const dir = posix.dirname(doc.rel)
  const resolve = (target) => {
    const clean = decodeURIComponentSafe(target.split("#")[0].trim())
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null
    for (const candidate of [posix.normalize(posix.join(dir, clean)), posix.normalize(clean)]) {
      if (ids.has(candidate)) return { kind: "doc", id: ids.get(candidate), rel: candidate }
      if (folders.has(candidate.replace(/\/$/, ""))) return { kind: "folder", id: folders.get(candidate.replace(/\/$/, "")), rel: candidate }
    }
    return null
  }
  for (const section of sections) {
    const text = section.text
    const seen = new Set()
    const push = (hit, index, kind) => {
      if (!hit || hit.id === doc.id || seen.has(hit.id)) return
      seen.add(hit.id)
      found.push({ from: doc.id, to: hit.id, toKind: hit.kind, sectionId: section.id, heading: section.heading, kind, excerpt: sentenceAround(text, index) })
    }
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) push(resolve(match[1]), match.index, "link")
    for (const match of text.matchAll(/(?<![\w/`-])([\w][\w./-]*\.md|[\w][\w./-]*status\.tsv)(?![\w/])/g)) push(resolve(match[1]), match.index, "mention")
    for (const [folder, id] of folders) {
      const pattern = new RegExp(`(?<![\\w/-])${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`)
      const match = text.match(pattern)
      if (match) push({ kind: "folder", id }, match.index, "mention")
    }
  }
  return found
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function changelogEntries(doc, sections) {
  const entries = []
  let current = null
  const flush = () => {
    if (!current) return
    const fields = current.fields
    const summary = fields.What || current.body.join(" ").trim()
    if (summary) entries.push({ ...current, summary: summary.replace(/\s+/g, " ").slice(0, 400), body: current.body.join("\n").trim() })
    current = null
  }
  doc.raw.split(/\r?\n/).forEach((text, i) => {
    const stamp = text.match(CHANGELOG_STAMP)
    if (stamp) {
      flush()
      current = { kind: "changelog", date: stamp[1], time: stamp[2] ?? "", docId: doc.id, rel: doc.rel, line: i + 1, fields: {}, body: stamp[3] ? [stamp[3]] : [] }
      return
    }
    if (!current) return
    const field = text.match(CHANGELOG_FIELD)
    if (field) current.fields[field[1]] = field[2].trim()
    else if (text.trim()) current.body.push(text.trim())
  })
  flush()
  for (const entry of entries) entry.sectionId = sections.filter((s) => s.line <= entry.line).pop()?.id ?? doc.id
  return entries
}

function statusEntries(doc) {
  const rows = doc.raw.split(/\r?\n/).filter((line) => line.length).map((line) => line.split("\t"))
  if (rows.length < 2) return []
  const head = rows[0].map((cell) => cell.trim().toLowerCase())
  const col = (name) => head.indexOf(name)
  const ts = col("ts") !== -1 ? col("ts") : head.findIndex((h) => /time|date|when/.test(h))
  if (ts === -1) return []
  return rows.slice(1).flatMap((row, i) => {
    const value = (row[ts] ?? "").trim()
    if (!ISO_TS.test(value)) return []
    const date = value.slice(0, 10)
    const time = value.length > 10 ? value.slice(11, 16) : ""
    const cell = (name) => (col(name) !== -1 ? (row[col(name)] ?? "").trim() : "")
    const unit = cell("unit") || cell("id") || ""
    const state = cell("state") || cell("status") || ""
    const note = cell("note") || cell("evidence") || row.filter((_, k) => k !== ts).join(" · ")
    return [{ kind: "status", date, time, docId: doc.id, rel: doc.rel, sectionId: doc.id, line: i + 2, unit, state, summary: `${[unit, state].filter(Boolean).join(" · ")}${note ? `: ${note}` : ""}`.slice(0, 400), evidence: cell("evidence"), body: row.join("\t") }]
  })
}

/**
 * Build the model. `md` is the markdown-it instance from the renderer so inline card text keeps the
 * same link and escaping rules as the full articles.
 */
export function buildKnowledgeModel(docs, { md, ids }) {
  const folderNames = [...new Set(docs.filter((doc) => doc.folder).map((doc) => doc.folder))].sort()
  const folders = new Map(folderNames.map((name) => [name, `f${name.replace(/[^A-Za-z0-9]/g, "_")}`]))
  const inline = (doc, text) => md.renderInline(text, { id: doc.id, rel: doc.rel, ids, headings: [] })
  const hub = docs.find((doc) => doc.rel === "INDEX.md") ?? null

  const nodes = []
  const nodeOfDoc = new Map()
  for (const doc of docs) {
    if (doc.folder) {
      nodeOfDoc.set(doc.id, folders.get(doc.folder))
      continue
    }
    nodeOfDoc.set(doc.id, doc.id)
    nodes.push({ id: doc.id, kind: doc === hub ? "hub" : "doc", title: doc.title, rel: doc.rel, group: "current", archived: false, docIds: [doc.id], weight: 1 })
  }
  for (const name of folderNames) {
    const members = docs.filter((doc) => doc.folder === name)
    const archived = DATED.test(name) || name.toLowerCase() === "archive"
    nodes.push({ id: folders.get(name), kind: "folder", title: humanizeFolder(name), rel: `${name}/`, group: archived ? "archive" : "topic", archived, docIds: members.map((doc) => doc.id), weight: members.length })
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  const sections = []
  const facts = []
  const refs = []
  const timeline = []
  const docMeta = new Map()
  for (const doc of docs) {
    const node = nodeById.get(nodeOfDoc.get(doc.id))
    const archived = node?.archived ?? false
    const own = doc.kind === "markdown" ? sectionize(doc) : [{ id: doc.id, docId: doc.id, level: 0, heading: doc.title, line: 1, text: doc.raw }]
    const isChangelog = /(^|\/)changelog\.md$/i.test(doc.rel)
    for (const section of own) {
      sections.push({ ...section, nodeId: node.id, rel: doc.rel, archived })
      // Changelog entries feed the timeline, not the fact boards.
      if (doc.kind !== "markdown" || isChangelog) continue
      const issueHeading = ISSUE_HEADING.test(section.heading)
      const decisionHeading = DECISION_HEADING.test(section.heading)
      // Fallback sections have no physical line, so the one-based unit ordinal keeps fact ids unique (2026-10-26).
      for (const [index, unit] of units(section).entries()) {
        const record = parseRecord(unit.text)
        let kind = null
        if (record) kind = "rule"
        else if (issueHeading) kind = "issue"
        else if (decisionHeading) kind = "decision"
        if (!kind) continue
        const fact = record?.fact || unit.text
        facts.push({
          id: Number.isInteger(unit.line) && unit.line >= 1 ? `${section.id}-l${unit.line}` : `${section.id}-u${index + 1}`, kind, nodeId: node.id, docId: doc.id, sectionId: section.id, heading: section.heading, rel: doc.rel, line: unit.line, archived,
          fact, why: record?.why ?? "", how: record?.how ?? "",
          factHtml: inline(doc, fact), whyHtml: record?.why ? inline(doc, record.why) : "", howHtml: record?.how ? inline(doc, record.how) : "",
        })
      }
    }
    if (doc.kind === "markdown") refs.push(...references(doc, own, ids, folders))
    if (isChangelog) timeline.push(...changelogEntries(doc, own).map((entry) => ({ ...entry, nodeId: node.id, archived })))
    if (doc.kind === "status") timeline.push(...statusEntries(doc).map((entry) => ({ ...entry, nodeId: node.id, archived })))
    docMeta.set(doc.id, { sections: own.length, facts: facts.filter((fact) => fact.docId === doc.id).length })
  }
  for (const entry of timeline) entry.summaryHtml = inline(docs.find((doc) => doc.id === entry.docId), entry.summary)
  timeline.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`) || a.rel.localeCompare(b.rel) || a.line - b.line)

  // Node-level edges aggregate document references; same target cited from several sections of one
  // document counts once per section, never as independent facts.
  const edgeMap = new Map()
  for (const ref of refs) {
    const from = nodeOfDoc.get(ref.from)
    const to = ref.toKind === "folder" ? ref.to : nodeOfDoc.get(ref.to)
    if (!from || !to || from === to) continue
    const key = from < to ? `${from}|${to}` : `${to}|${from}`
    const edge = edgeMap.get(key) ?? { id: `e${edgeMap.size}`, a: from < to ? from : to, b: from < to ? to : from, refs: [] }
    edge.refs.push(ref)
    edgeMap.set(key, edge)
  }
  const edges = [...edgeMap.values()].map((edge) => ({ ...edge, count: edge.refs.length, label: `${edge.refs.length} reference${edge.refs.length === 1 ? "" : "s"}` }))
  for (const node of nodes) {
    node.facts = facts.filter((fact) => fact.nodeId === node.id).length
    node.sections = sections.filter((section) => section.nodeId === node.id).length
    node.degree = edges.filter((edge) => edge.a === node.id || edge.b === node.id).length
  }

  const counts = {
    nodes: nodes.length, edges: edges.length, references: refs.length, sections: sections.length,
    facts: facts.length, rules: facts.filter((f) => f.kind === "rule").length, decisions: facts.filter((f) => f.kind === "decision").length,
    issues: facts.filter((f) => f.kind === "issue").length, timeline: timeline.length,
    changelog: timeline.filter((t) => t.kind === "changelog").length, statusRows: timeline.filter((t) => t.kind === "status").length,
  }
  return { version: MODEL_VERSION, hubId: hub?.id ?? null, nodes, edges, refs, sections, facts, timeline, counts, docMeta: Object.fromEntries(docMeta) }
}
