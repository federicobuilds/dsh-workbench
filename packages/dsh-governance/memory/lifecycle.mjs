// Owned live-preview lifecycle shared by the CLI and the harness plugin (MEMORY-FORMAT-GLOBAL-P1, 2026-10-26).
// One private state file per canonical project records the capability URL of the preview this harness owns.
// A preview is reused only when it answers on that exact loopback capability URL with this project's identity
// and the current renderer version; an older owned preview is replaced only through its authenticated stop.
// Nothing here looks up, signals or kills a process by PID, and a URL that is not ours is never contacted.
import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectIdOf, RENDER_VERSION } from "./index.mjs"

const STATE_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/([A-Za-z0-9_-]{32})\/$/
const MAX_STATE = 4096
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

/** The per-user state directory: created 0700, refused when it is a link, foreign-owned or group/world accessible. */
export async function stateDir() {
  const dir = join(tmpdir(), `dsh-memory-preview-${process.getuid()}`)
  await mkdir(dir, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
  const info = await lstat(dir)
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error(`memory: preview state directory ${dir} is not private`)
  return dir
}

export const stateFileOf = async (project) => join(await stateDir(), `${projectIdOf(project).slice(0, 24)}.json`)

/** Read and validate this project's state; anything unexpected is treated as no state. */
export async function readPreviewState(project) {
  const file = await stateFileOf(project)
  let handle
  try {
    handle = await open(file, READ_FLAGS)
  } catch {
    return null
  }
  let state
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > MAX_STATE) return null
    const buffer = Buffer.alloc(MAX_STATE + 1)
    const { bytesRead } = await handle.read(buffer, 0, MAX_STATE + 1, 0)
    if (bytesRead > MAX_STATE) return null
    state = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
  } catch {
    return null
  } finally {
    await handle.close()
  }
  if (!state || typeof state !== "object" || typeof state.url !== "string") return null
  const match = state.url.match(STATE_URL)
  if (!match) return null
  const port = Number(match[1])
  const projectId = projectIdOf(project)
  if (!Number.isInteger(state.port) || state.port !== port || port < 1 || port > 65535) return null
  if (state.project !== project || state.projectId !== projectId) return null
  return { project, projectId, port, url: `http://127.0.0.1:${port}/${match[2]}/` }
}

/** Atomic 0600 write through an exclusive, no-follow temporary file in the private directory. */
export async function writePreviewState(project, { port, url }) {
  const file = await stateFileOf(project)
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  const handle = await open(temp, CREATE_FLAGS, 0o600)
  try {
    await handle.writeFile(JSON.stringify({ project, projectId: projectIdOf(project), port, url }))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, file)
}

/** Remove the state only while it still names the given URL, so a newer owner's record survives. */
export async function clearPreviewState(project, url) {
  const state = await readPreviewState(project)
  if (state && state.url === url) await unlink(await stateFileOf(project)).catch(() => {})
}

/** Alive means: our capability URL answers 200 with this project's identity. Returns its renderer version. */
export async function probePreview(state) {
  try {
    const response = await fetch(state.url, { method: "HEAD", redirect: "manual" })
    if (response.status !== 200 || response.headers.get("x-memory-project") !== state.projectId) return { alive: false }
    return { alive: true, version: response.headers.get("x-memory-version") }
  } catch {
    return { alive: false }
  }
}

/** Authenticated stop: capability URL plus project identity; returns the HTTP status, or null when nothing answered. */
export async function requestStop(state) {
  try {
    return (await fetch(`${state.url}stop`, { method: "POST", headers: { "x-memory-project": state.projectId }, redirect: "manual" })).status
  } catch {
    return null
  }
}

/**
 * Decide reuse before starting a preview: reuse a matching live owned preview, replace an owned one running an
 * older renderer through its authenticated stop, and clear only our own stale record when nothing answers.
 */
export async function acquirePreview(project) {
  const state = await readPreviewState(project)
  if (!state) return { reuse: null, replaced: false }
  const probe = await probePreview(state)
  if (!probe.alive) {
    await clearPreviewState(project, state.url)
    return { reuse: null, replaced: false }
  }
  if (probe.version === RENDER_VERSION) return { reuse: state, replaced: false }
  if ((await requestStop(state)) !== 200) throw new Error("memory: the owned preview with an older renderer refused to stop; not starting a second one")
  // 2026-10-26 (F3): a 200 acknowledgement is not proof of exit. Only a checked HEAD that no longer answers
  // with this identity clears the record; otherwise the old viewer and its state are kept and no new one starts.
  for (let i = 0; i < 50; i++) {
    if (!(await probePreview(state)).alive) {
      await clearPreviewState(project, state.url)
      return { reuse: null, replaced: true }
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error("memory: the older owned preview acknowledged stop but is still answering; replacement refused and its state kept")
}
