/**
 * Judge registry (2026-10-28, JUDGE-REGISTRY): the one source of judge definitions and lane routes for the
 * harness plugin. judges.json beside this module is canonical; DSH_JUDGE_CONFIG may name another absolute
 * path for a user or test override. Nothing is read at import, so policy clients (Node, Bun, TUI, VS Code)
 * load even when the file is broken; every resolve reads the file again, so an edit applies to the next call.
 * The resolved settings win over inherited JUDGE_*, JEV_* and TYPESAFE_* variables: the plugin passes the
 * registry choice, while a direct judge.py run keeps its own environment behavior. A key file is a path
 * reference only and is never opened here; judge.py reads it when it makes the request.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { legacyEnv } from "./legacy.mjs"

export { legacyEnv }

export const CONFIG_ENV = "DSH_JUDGE_CONFIG"
export const DEFAULT_CONFIG = fileURLToPath(new URL("./judges.json", import.meta.url))
export const ROUTES = ["free", "simple", "advanced", "off"]
const FIELDS = ["displayName", "endpoint", "model", "keyFile", "requestTimeoutS", "deadlineS", "retries", "processTimeoutMs"]
/** Room between judge.py's own deadline and the plugin kill, so judge.py can log a slow call before it is killed. */
const KILL_MARGIN_MS = 2000
const ID = /^[a-z][a-z0-9_-]{0,31}$/
const PRINTABLE = /^[\x20-\x7e]+$/
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Raised for any missing, unreadable or invalid registry; messages name fields, never values or raw errors. */
export class JudgeConfigError extends Error {
  constructor(message) {
    super(`judge config: ${message}`)
    this.name = "JudgeConfigError"
  }
}

const fail = (message) => { throw new JudgeConfigError(message) }
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const exactKeys = (value, keys, where) => {
  if (!isObject(value)) fail(`${where} must be an object`)
  const found = Object.keys(value)
  if (found.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) fail(`${where} must have exactly ${keys.join(", ")}`)
}
const text = (value, max, where) => {
  if (typeof value !== "string" || !value.length || value.length > max || !PRINTABLE.test(value)) fail(`${where} must be 1..${max} printable characters`)
}
const number = (value, min, max, where) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${where} must be a number in ${min}..${max}`)
}

function validateJudge(judge, where) {
  exactKeys(judge, FIELDS, where)
  text(judge.displayName, 40, `${where}.displayName`)
  if (judge.displayName.trim() !== judge.displayName) fail(`${where}.displayName must not start or end with spaces`)
  text(judge.endpoint, 2048, `${where}.endpoint`)
  let url
  try { url = new URL(judge.endpoint) } catch { fail(`${where}.endpoint must be a URL`) }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(`${where}.endpoint must be http or https`)
  if (url.username || url.password) fail(`${where}.endpoint must not embed credentials`)
  text(judge.model, 512, `${where}.model`)
  text(judge.keyFile, 1024, `${where}.keyFile`)
  if (!judge.keyFile.startsWith("/") && !judge.keyFile.startsWith("~/")) fail(`${where}.keyFile must be a path starting with / or ~/`)
  number(judge.requestTimeoutS, 1, 60, `${where}.requestTimeoutS`)
  number(judge.deadlineS, 1, 110, `${where}.deadlineS`)
  if (judge.requestTimeoutS > judge.deadlineS) fail(`${where}.requestTimeoutS must not exceed deadlineS`)
  if (judge.retries !== 0 && judge.retries !== 1) fail(`${where}.retries must be 0 or 1`)
  if (!Number.isInteger(judge.processTimeoutMs)) fail(`${where}.processTimeoutMs must be an integer`)
  number(judge.processTimeoutMs, 1000, 120000, `${where}.processTimeoutMs`)
  if (judge.deadlineS * 1000 + KILL_MARGIN_MS > judge.processTimeoutMs) fail(`${where}.processTimeoutMs must exceed deadlineS by at least ${KILL_MARGIN_MS} ms`)
}

/**
 * Read and validate the registry named by the environment.
 * @param {Record<string, string | undefined>} env environment that may carry DSH_JUDGE_CONFIG
 * @returns {{ version: 1, judges: Record<string, object>, routes: Record<string, string> }}
 */
export function loadJudgeConfig(env = process.env) {
  const path = legacyEnv(CONFIG_ENV, "KILO_JUDGE_CONFIG", env) || DEFAULT_CONFIG
  if (!path.startsWith("/")) fail(`${CONFIG_ENV} must be an absolute path`)
  let raw
  try { raw = readFileSync(path, "utf8") } catch { fail("file is missing or unreadable") }
  let config
  try { config = JSON.parse(raw) } catch { fail("file is not valid JSON") }
  exactKeys(config, ["version", "judges", "routes"], "top level")
  if (config.version !== 1) fail("version must be 1")
  if (!isObject(config.judges) || !Object.keys(config.judges).length) fail("judges must be a non-empty object")
  for (const [id, judge] of Object.entries(config.judges)) {
    if (!ID.test(id)) fail("judge ids must match [a-z][a-z0-9_-]{0,31}")
    validateJudge(judge, `judges.${id}`)
  }
  exactKeys(config.routes, ROUTES, "routes")
  for (const route of ROUTES) {
    if (typeof config.routes[route] !== "string" || !Object.hasOwn(config.judges, config.routes[route])) fail(`routes.${route} names no defined judge`)
  }
  return config
}

/** Lane to route: the former Cheap lane is Simple; any other unknown mode is a config error, never a silent default. */
const routeOf = (mode) => {
  const route = mode === "cheap" ? "simple" : mode
  return ROUTES.includes(route) ? route : fail("unknown lane mode")
}

const expandHome = (value, home) => {
  if (!value.startsWith("~/")) return value
  if (typeof home !== "string" || !home.startsWith("/")) fail("a ~/ path needs an absolute home directory")
  return `${home}${value.slice(1)}`
}

/**
 * Resolve the one judge for a lane: identity, the judge.py environment, and the plugin kill timeout.
 * @param {string} mode lane mode (free, simple, advanced, off; cheap is read as simple)
 * @param {string} home home directory used for ~/ expansion
 * @param {Record<string, string | undefined>} env inherited environment; unrelated variables pass through
 * @returns {{ id: string, displayName: string, endpoint: string, local: boolean, processTimeoutMs: number, env: Record<string, string | undefined> }}
 */
export function resolveJudge(mode, home, env = process.env) {
  const route = routeOf(mode)
  const config = loadJudgeConfig(env)
  const id = config.routes[route]
  const judge = config.judges[id]
  const settings = {
    BASE_URL: judge.endpoint,
    MODEL: expandHome(judge.model, home),
    KEY_FILE: expandHome(judge.keyFile, home),
    TIMEOUT_S: String(judge.requestTimeoutS),
    DEADLINE_S: String(judge.deadlineS),
    RETRIES: String(judge.retries),
  }
  return {
    id,
    displayName: judge.displayName,
    endpoint: judge.endpoint,
    local: LOOPBACK.has(new URL(judge.endpoint).hostname),
    processTimeoutMs: judge.processTimeoutMs,
    env: {
      ...env,
      TYPESAFE_BASE_URL: settings.BASE_URL,
      JEV_MODEL: settings.MODEL,
      JEV_KEY_FILE: settings.KEY_FILE,
      JEV_TIMEOUT_S: settings.TIMEOUT_S,
      JEV_DEADLINE_S: settings.DEADLINE_S,
      JEV_RETRIES: settings.RETRIES,
      JUDGE_BASE_URL: settings.BASE_URL,
      JUDGE_MODEL: settings.MODEL,
      JUDGE_KEY_FILE: settings.KEY_FILE,
      JUDGE_TIMEOUT_S: settings.TIMEOUT_S,
      JUDGE_DEADLINE_S: settings.DEADLINE_S,
      JUDGE_RETRIES: settings.RETRIES,
    },
  }
}
