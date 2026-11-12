// Project memory viewer (MEMORY-PILOT, 2026-10-24). Markdown under <project>/.kilocode/memory is the only
// source; this module derives a read-only HTML view from it and never writes Markdown.
import { execFile } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { realpathSync, watch } from "node:fs"
import { lstat } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, isAbsolute, join, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { buildKnowledgeModel, MODEL_VERSION } from "./model.mjs"
import { loadReadable, READABLE_VERSION, readableFingerprint } from "./readable.mjs"
import { renderPage, TEMPLATE_HASH } from "./view.mjs"

let MarkdownIt = null
try {
  MarkdownIt = createRequire(import.meta.url)("markdown-it/dist/markdown-it.js")
} catch {
  MarkdownIt = null
}

export const MEMORY_DIR = ".kilocode/memory"
export const OUTPUT_NAME = "memory.html"
// Part of sourceHash: a renderer, schema or template change alone must republish memory.html.
export const RENDER_VERSION = `memory-view-4:${TEMPLATE_HASH}:${MODEL_VERSION}:readable-${READABLE_VERSION}`
const DATED = /(^|[-_])20\d{6}([-_]|$)/

const SECRET_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["api key", /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["aws key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["oauth secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["huggingface token", /\bhf_[A-Za-z0-9]{30,}/g],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
]
const ASSIGNED_SECRET = /\b((?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?)([A-Za-z0-9/+_.-]{16,})/gi

/** Replace secret-shaped strings; the count stays visible in the view. */
export function redact(text) {
  let count = 0
  for (const [kind, pattern] of SECRET_PATTERNS) text = text.replace(pattern, () => (count++, `[REDACTED ${kind}]`))
  text = text.replace(ASSIGNED_SECRET, (_m, prefix) => (count++, `${prefix}[REDACTED secret]`))
  return { text, count }
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const docId = (rel) => `m${sha256(rel).slice(0, 10)}`

/** Resolve and validate the project's memory root; refuse "/", home, and symlinked memory folders. */
export async function memoryRootOf(projectRoot) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw new Error("memory: project root must be an absolute path")
  const project = realpathSync(projectRoot)
  if (project === "/" || project === realpathSync(homedir())) throw new Error(`memory: ${project} is not a project memory root`)
  for (const part of [".kilocode", MEMORY_DIR]) {
    const info = await lstat(join(project, part))
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`memory: ${join(project, part)} is not a real directory`)
  }
  return { project, root: join(project, MEMORY_DIR) }
}

const HELPER = fileURLToPath(new URL("./fsanchor.py", import.meta.url))
function helper(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("python3", [HELPER, ...args], { maxBuffer: 256 * 1024 * 1024, env: { PATH: process.env.PATH, KILO_MEMORY_HELPER_SYNC_FILE: process.env.KILO_MEMORY_HELPER_SYNC_FILE ?? "" } }, (error, stdout) => {
      let result = null
      try {
        result = stdout ? JSON.parse(stdout) : null
      } catch {}
      if (result?.error) return reject(Object.assign(new Error(result.message), { code: result.error }))
      if (error) return reject(Object.assign(new Error(`memory helper failed: ${error.code ?? error.message}`), { code: error.code ?? "EHELPER" }))
      resolve(result)
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Walk the memory root (regular Markdown and status.tsv only) on anchored descriptors; every skip is reported. */
async function scan(root, { meta = false } = {}) {
  const result = await helper(meta ? ["scan", root, "--meta"] : ["scan", root])
  for (const file of result.files) if (file.content !== undefined) file.content = Buffer.from(file.content, "base64")
  return result
}

const projectIdOf = (project) => sha256(`kilo-memory-project:${project}`)

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function makeFallbackRenderer() {
  const esc = escapeHtml
  const validateLink = (url) => {
    const value = url.trim().toLowerCase()
    if (/^[a-z][a-z0-9+.-]*:/.test(value)) return /^(https?|mailto):/.test(value)
    return true
  }
  const plainInline = (text) =>
    String(text ?? "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/(\*\*|__|\*|_)/g, "")

  function renderInline(text, env = {}) {
    const src = String(text ?? "")
    let out = ""
    let i = 0
    while (i < src.length) {
      if (src[i] === "`") {
        const end = src.indexOf("`", i + 1)
        if (end !== -1) {
          out += `<code>${esc(src.slice(i + 1, end))}</code>`
          i = end + 1
          continue
        }
      }
      if (src[i] === "!" && src[i + 1] === "[") {
        const m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(src.slice(i))
        if (m) {
          const alt = m[1]
          const href = m[2]
          const label = `[image: ${esc(alt || basename(href) || "untitled")}]`
          out += /^https?:/i.test(href)
            ? `<a class="image-link" href="${esc(href)}" rel="noopener noreferrer" target="_blank">${label}</a>`
            : `<span class="image-link">${label}</span>`
          i += m[0].length
          continue
        }
      }
      if (src[i] === "[") {
        const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i))
        if (m) {
          const labelHtml = renderInline(m[1], env)
          const href = m[2]
          if (!validateLink(href)) {
            out += labelHtml
          } else if (/^(https?|mailto):/i.test(href)) {
            out += `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${labelHtml}</a>`
          } else if (href.startsWith("#")) {
            out += `<a href="#${esc(env.id ?? "")}">${labelHtml}</a>`
          } else {
            const [path] = href.split("#")
            const target = posix.normalize(posix.join(posix.dirname(env.rel ?? ""), decodeURIComponentSafe(path)))
            const id = env.ids?.get?.(target)
            if (id) {
              out += `<a href="#${esc(id)}" data-doc="${esc(id)}">${labelHtml}</a>`
            } else {
              out += `<a class="dead-link" title="Not in this memory view: ${esc(href)}">${labelHtml}</a>`
            }
          }
          i += m[0].length
          continue
        }
      }
      if (src.startsWith("**", i)) {
        const end = src.indexOf("**", i + 2)
        if (end !== -1) {
          out += `<strong>${renderInline(src.slice(i + 2, end), env)}</strong>`
          i = end + 2
          continue
        }
      }
      out += esc(src[i])
      i++
    }
    return out
  }

  function render(markdown, env = { id: "doc", rel: "", ids: new Map(), headings: [] }) {
    const lines = String(markdown ?? "").split(/\r?\n/)
    const blocks = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) {
        i++
        continue
      }
      const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(line)
      if (fenceMatch) {
        const fence = fenceMatch[1]
        const codeLines = []
        i++
        while (i < lines.length && !new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) {
          codeLines.push(lines[i])
          i++
        }
        if (i < lines.length) i++
        blocks.push(`<pre><code>${esc(codeLines.join("\n"))}\n</code></pre>\n`)
        continue
      }
      const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (atx) {
        const level = atx[1].length
        const rawText = atx[2]
        const id = `${env.id}-h${env.headings.length + 1}`
        env.headings.push({ id, level, text: plainInline(rawText) })
        blocks.push(`<h${level} id="${id}">${renderInline(rawText, env)}</h${level}>\n`)
        i++
        continue
      }
      if (i + 1 < lines.length && /^(?:=+|-+)\s*$/.test(lines[i + 1]) && line.trim() && !/^\s*([-*+]|\d+[.)]|\||>)/.test(line)) {
        const level = lines[i + 1].trim().startsWith("=") ? 1 : 2
        const rawText = line.trim()
        const id = `${env.id}-h${env.headings.length + 1}`
        env.headings.push({ id, level, text: plainInline(rawText) })
        blocks.push(`<h${level} id="${id}">${renderInline(rawText, env)}</h${level}>\n`)
        i += 2
        continue
      }
      if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        const splitRow = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
        const head = splitRow(line)
        i += 2
        const rows = []
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          rows.push(splitRow(lines[i]))
          i++
        }
        const ths = head.map((c) => `<th>${renderInline(c, env)}</th>`).join("")
        const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, env)}</td>`).join("")}</tr>`).join("\n")
        blocks.push(`<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table>\n<thead>\n<tr>${ths}</tr>\n</thead>\n<tbody>\n${trs}\n</tbody>\n</table></div>\n`)
        continue
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line)
        const tag = ordered ? "ol" : "ul"
        const items = []
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const itemText = [lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "")]
          i++
          while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)]|#{1,6}\s|\||>|`{3,}|~{3,})/.test(lines[i])) {
            itemText.push(lines[i].trim())
            i++
          }
          items.push(`<li>${renderInline(itemText.join(" "), env)}</li>`)
          while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1])) {
            i++
          }
        }
        blocks.push(`<${tag}>\n${items.join("\n")}\n</${tag}>\n`)
        continue
      }
      if (/^\s*>/.test(line)) {
        const qLines = []
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          qLines.push(lines[i].replace(/^\s*>\s?/, ""))
          i++
        }
        blocks.push(`<blockquote>\n<p>${renderInline(qLines.join("\n"), env)}</p>\n</blockquote>\n`)
        continue
      }
      const para = [line]
      i++
      while (
        i < lines.length
        && lines[i].trim()
        && !/^(#{1,6}\s|`{3,}|~{3,}|\s*([-*+]|\d+[.)])\s+|\s*>|\s*\|)/.test(lines[i])
        && !(i + 1 < lines.length && /^(?:=+|-+)\s*$/.test(lines[i + 1]))
      ) {
        para.push(lines[i])
        i++
      }
      blocks.push(`<p>${renderInline(para.join("\n"), env)}</p>\n`)
    }
    return blocks.join("")
  }

  return { md: { render, renderInline, utils: { escapeHtml: esc } }, esc }
}

function makeRenderer() {
  if (!MarkdownIt) return makeFallbackRenderer()
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
  const esc = md.utils.escapeHtml
  md.validateLink = (url) => {
    const value = url.trim().toLowerCase()
    if (/^[a-z][a-z0-9+.-]*:/.test(value)) return /^(https?|mailto):/.test(value)
    return true
  }
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const id = `${env.id}-h${env.headings.length + 1}`
    tokens[idx].attrSet("id", id)
    env.headings.push({ id, level: Number(tokens[idx].tag.slice(1)), text: tokens[idx + 1].children.filter((t) => t.type === "text" || t.type === "code_inline").map((t) => t.content).join("") })
    return self.renderToken(tokens, idx, options)
  }
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const href = token.attrGet("href") ?? ""
    if (/^(https?|mailto):/i.test(href)) {
      token.attrSet("rel", "noopener noreferrer")
      token.attrSet("target", "_blank")
    } else if (href.startsWith("#")) {
      token.attrSet("href", `#${env.id}`)
    } else {
      const [path] = href.split("#")
      const target = posix.normalize(posix.join(posix.dirname(env.rel), decodeURIComponentSafe(path)))
      const id = env.ids.get(target)
      token.attrs = token.attrs.filter(([name]) => name !== "href")
      if (id) {
        token.attrSet("href", `#${id}`)
        token.attrSet("data-doc", id)
      } else {
        token.attrSet("class", "dead-link")
        token.attrSet("title", `Not in this memory view: ${href}`)
      }
    }
    return self.renderToken(tokens, idx, options)
  }
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx]
    const src = token.attrGet("src") ?? ""
    const label = `[image: ${esc(token.content || basename(src) || "untitled")}]`
    return /^https?:/i.test(src) ? `<a class="image-link" href="${esc(src)}" rel="noopener noreferrer" target="_blank">${label}</a>` : `<span class="image-link">${label}</span>`
  }
  md.renderer.rules.table_open = () => '<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table>\n'
  md.renderer.rules.table_close = () => "</table></div>\n"
  return { md, esc }
}

function renderStatus(text, esc) {
  const rows = text.split(/\r?\n/).filter((line) => line.length).map((line) => line.split("\t"))
  if (!rows.length) return "<p>Empty status record.</p>"
  const [head, ...body] = rows
  const cells = (row, tag) => row.map((cell) => `<${tag}>${esc(cell)}</${tag}>`).join("")
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Status records"><table><thead><tr>${cells(head, "th")}</tr></thead><tbody>${body.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table></div>`
}

function groupOf(rel) {
  if (!rel.includes("/")) return { group: "Current knowledge", folder: "" }
  const folder = rel.split("/")[0]
  return { group: DATED.test(folder) || folder.toLowerCase() === "archive" ? "Archived history" : "Topic folders", folder }
}

/** Reconcile the current disk state into a complete, redacted, rendered snapshot. */
export async function buildMemorySnapshot(projectRoot) {
  const { project, root } = await memoryRootOf(projectRoot)
  const { files, excluded, otherTypes, unavailable, root: rootId, output, readable: found } = await scan(root)
  const { md, esc } = makeRenderer()
  const ids = new Map(files.map((file) => [file.rel, docId(file.rel)]))
  const docs = []
  for (const file of files) {
    const original = file.content.toString("utf8")
    const { text, count } = redact(original)
    const env = { id: ids.get(file.rel), rel: file.rel, ids, headings: [] }
    const html = file.kind === "markdown" ? md.render(text, env) : renderStatus(text, esc)
    const h1 = env.headings.find((h) => h.level === 1)
    docs.push({
      id: env.id, rel: file.rel, kind: file.kind, ...groupOf(file.rel),
      title: file.kind === "status" ? `Status records · ${posix.dirname(file.rel)}` : h1?.text || basename(file.rel, ".md"),
      bytes: file.size, mtime: new Date(file.mtimeMs).toISOString(), sha256: sha256(file.content),
      html, raw: text, redactions: count, headings: env.headings, hasTitle: Boolean(h1),
    })
  }
  const sum = (kind) => docs.filter((doc) => doc.kind === kind).reduce((acc, doc) => ({ files: acc.files + 1, bytes: acc.bytes + doc.bytes }), { files: 0, bytes: 0 })
  const census = { markdown: sum("markdown"), status: sum("status"), excluded, otherTypes, unavailable, redactions: docs.reduce((n, doc) => n + doc.redactions, 0) }
  const model = buildKnowledgeModel(docs, { md, ids })
  const projectId = projectIdOf(project)
  // The derived plain-language cache is not a source document; only its validated fingerprint reaches sourceHash.
  const readable = loadReadable(found, { projectId, docs, model, redact })
  const sourceHash = sha256(JSON.stringify([RENDER_VERSION, docs.map((doc) => [doc.rel, doc.sha256, doc.mtime]), excluded, otherTypes, unavailable, readableFingerprint(readable)]))
  return { project, projectId, root, rootId, output, name: basename(project), builtAt: new Date().toISOString(), sourceHash, docs, census, model, readable }
}

/** Atomically publish memory.html (0600) through the anchored root; unchanged sources leave the file untouched. */
export async function writeMemoryHtml(snapshot) {
  const target = join(snapshot.root, OUTPUT_NAME)
  const marker = `<meta name="memory-source-hash" content="${snapshot.sourceHash}">`
  const current = snapshot.output
  if (current && current.mode === 0o600 && Buffer.from(current.head, "base64").toString("utf8").includes(marker)) return { path: target, written: false }
  await helper(["publish", snapshot.root, String(snapshot.rootId.dev), String(snapshot.rootId.ino), OUTPUT_NAME], renderPage(snapshot, { mode: "snapshot" }).html)
  return { path: target, written: true }
}

/** Build from current disk and publish; the entry point for open-time and post-write reconciliation. */
export async function refreshMemoryHtml(projectRoot) {
  const snapshot = await buildMemorySnapshot(projectRoot)
  return { snapshot, ...(await writeMemoryHtml(snapshot)) }
}

/** Create a derived root file (0600) only when absent; an existing file is never replaced. */
export async function createDerivedIfAbsent(snapshot, name, body) {
  const result = await helper(["publish", snapshot.root, String(snapshot.rootId.dev), String(snapshot.rootId.ino), name, "--new"], body)
  return Boolean(result?.written)
}

/** Source signature used by the 2 s rescan: census, byte identity of every source, cache bytes and render version. */
async function signature(root) {
  const { files, excluded, otherTypes, unavailable, readable } = await scan(root, { meta: true })
  const parts = files.map((file) => `${file.rel}:${file.ino}:${file.size}:${file.mtimeMs}:${file.sha256}`)
  const cache = [readable.status, readable.ino ?? null, readable.size ?? null, readable.mtimeMs ?? null, readable.sha256 ?? null]
  return sha256(JSON.stringify([RENDER_VERSION, parts, excluded, otherTypes, unavailable, cache]))
}

/**
 * Live preview on 127.0.0.1 with a capability token in the path. No route maps to a file name; the
 * project is bound here and clients cannot choose another root.
 */
export async function startMemoryPreview(projectRoot, { port = 0, intervalMs = 2000, unref = false, nativeWatch = true, onStopRequest = null } = {}) {
  const { project, root } = await memoryRootOf(projectRoot)
  const projectId = projectIdOf(project)
  const token = randomBytes(24).toString("base64url")
  const state = { snapshot: await buildMemorySnapshot(project), version: 1, status: "live", error: null, since: new Date().toISOString(), changed: null, sig: await signature(root) }
  await writeMemoryHtml(state.snapshot)
  const clients = new Set()
  let busy = false
  let again = false
  let watcher = null
  let debounce = null

  const event = () => JSON.stringify({ version: state.version, status: state.status, builtAt: state.snapshot.builtAt, since: state.since, error: state.error, changed: state.changed })
  const broadcast = () => {
    for (const res of clients) res.write(`event: state\ndata: ${event()}\n\n`)
  }

  async function rescan() {
    if (busy) return void (again = true)
    busy = true
    try {
      const sig = await signature(root)
      if (sig === state.sig && state.status === "live") return
      const next = await buildMemorySnapshot(project)
      const before = new Map(state.snapshot.docs.map((doc) => [doc.rel, doc.sha256]))
      const after = new Map(next.docs.map((doc) => [doc.rel, doc.sha256]))
      const recovered = state.status !== "live"
      const changed = next.sourceHash !== state.snapshot.sourceHash
      if (changed) await writeMemoryHtml(next)
      state.sig = sig
      if (recovered) Object.assign(state, { status: "live", error: null, since: new Date().toISOString() })
      if (changed) {
        state.changed = {
          added: [...after.keys()].filter((rel) => !before.has(rel)).length,
          removed: [...before.keys()].filter((rel) => !after.has(rel)).length,
          modified: [...after].filter(([rel, hash]) => before.has(rel) && before.get(rel) !== hash).length,
        }
        state.snapshot = next
        state.version++
        broadcast()
      } else if (recovered) broadcast()
      ensureWatch()
    } catch (error) {
      if (state.status !== "unavailable") Object.assign(state, { status: "unavailable", error: error.code ?? error.message, since: new Date().toISOString(), sig: null })
      broadcast()
    } finally {
      busy = false
      if (again) {
        again = false
        setImmediate(rescan)
      }
    }
  }

  function ensureWatch() {
    if (watcher || !nativeWatch) return
    try {
      watcher = watch(root, { recursive: true }, (_type, name) => {
        if (name && /(^|\/)(memory\.html|\.memory\.html\.[0-9a-f]+\.tmp)$/.test(String(name))) return
        clearTimeout(debounce)
        debounce = setTimeout(rescan, 150)
      })
      watcher.on("error", () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      watcher = null
    }
  }
  const server = createServer((req, res) => handle(req, res))
  await new Promise((done, fail) => {
    server.once("error", fail).listen(port, "127.0.0.1", () => {
      server.off("error", fail)
      done()
    })
  })
  ensureWatch()
  const poll = setInterval(rescan, intervalMs)
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n")
  }, 10000)

  const bound = server.address().port
  const origin = `http://127.0.0.1:${bound}`
  const prefix = Buffer.from(`/${token}/`)
  const base = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "cross-origin-opener-policy": "same-origin", "x-frame-options": "DENY" }
  const deny = (res, code, text) => res.writeHead(code, { ...base, "content-type": "text/plain; charset=utf-8" }).end(text)

  function handle(req, res) {
    if (req.headers.host !== `127.0.0.1:${bound}`) return deny(res, 421, "Misdirected request")
    if (req.headers.origin && req.headers.origin !== origin) return deny(res, 403, "Forbidden origin")
    const site = req.headers["sec-fetch-site"]
    if (site && site !== "same-origin" && site !== "none") return deny(res, 403, "Forbidden cross-site request")
    const url = req.url ?? ""
    if (/%2e|%2f|%5c|\\|\/\.\.?(\/|$)/i.test(url)) return deny(res, 400, "Bad path")
    const path = Buffer.from(url.split("?")[0])
    if (path.length < prefix.length || !timingSafeEqual(path.subarray(0, prefix.length), prefix)) return deny(res, 404, "Not found")
    const rest = path.subarray(prefix.length).toString()
    if (rest === "stop") {
      if (req.method !== "POST") return res.writeHead(405, { ...base, allow: "POST" }).end()
      const claimed = String(req.headers["x-memory-project"] ?? "")
      if (claimed.length !== projectId.length || !timingSafeEqual(Buffer.from(claimed), Buffer.from(projectId))) return deny(res, 403, "Forbidden: project identity does not match this preview")
      res.writeHead(200, { ...base, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ stopped: true, project }))
      setImmediate(() => (onStopRequest ? onStopRequest() : api.stop()))
      return
    }
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405, { ...base, allow: "GET, HEAD" }).end()
    if (rest === "" || rest === "view") {
      const page = renderPage(state.snapshot, { mode: "live", version: state.version, status: state.status })
      return res.writeHead(200, { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": page.csp, "x-memory-project": projectId, "x-memory-version": RENDER_VERSION }).end(req.method === "HEAD" ? undefined : page.html)
    }
    if (rest === "events") {
      res.writeHead(200, { ...base, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" })
      res.write(`retry: 2000\nevent: state\ndata: ${event()}\n\n`)
      clients.add(res)
      req.on("close", () => clients.delete(res))
      return
    }
    deny(res, 404, "Not found")
  }

  if (unref) for (const timer of [poll, heartbeat]) timer.unref()
  if (unref) server.unref()
  let stopped = false
  const api = {
    project,
    projectId,
    version: RENDER_VERSION,
    port: bound,
    url: `${origin}/${token}/`,
    status: () => ({ version: state.version, status: state.status, docs: state.snapshot.docs.length, builtAt: state.snapshot.builtAt }),
    rescan,
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(poll)
      clearInterval(heartbeat)
      clearTimeout(debounce)
      watcher?.close()
      for (const res of clients) res.end()
      clients.clear()
      server.closeAllConnections()
      await new Promise((done) => server.close(() => done()))
    },
  }
  return api
}
export { projectIdOf }
