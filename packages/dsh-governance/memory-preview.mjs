import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  memoryRootOf,
  refreshMemoryHtml,
  startMemoryPreview,
  buildMemorySnapshot,
  writeMemoryHtml,
} from './memory/index.mjs';
import {
  describeIncomplete,
  initializeDerived,
  validateMemoryPublication,
  validateSnapshot,
} from './memory/format.mjs';
import {
  acquirePreview,
  clearPreviewState,
  readPreviewState,
  requestStop,
  writePreviewState,
} from './memory/lifecycle.mjs';
import { loadReadable, READABLE_NAME, READABLE_VERSION } from './memory/readable.mjs';

export {
  memoryRootOf,
  refreshMemoryHtml,
  startMemoryPreview,
  buildMemorySnapshot,
  writeMemoryHtml,
  describeIncomplete,
  initializeDerived,
  validateMemoryPublication,
  validateSnapshot,
  acquirePreview,
  clearPreviewState,
  readPreviewState,
  requestStop,
  writePreviewState,
  loadReadable,
  READABLE_NAME,
  READABLE_VERSION,
};

const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch']);

const MEMORY_CLAIM = /\bmemory\b.{0,60}?\b(complete|completed|up[ -]to[ -]date|current|updated|published|validated|finished|done)\b/i;
const MEMORY_NEGATED = /\b(not|never|no longer|incomplete|unfinished|pending|stale|missing|uncovered|unpublished)\b|n't\b/i;
const MEMORY_FUTURE = /\b(will|would|shall|should|must|going to|plan(?:s|ned|ning)? to|intend(?:s|ed)? to|aim(?:s|ed)? to|need(?:s|ed)? to|have to|has to|to mark|to be|after|once|until|unless|if|when)\b/i;
const MEMORY_CLAUSE = /(;\s*|(?<=[.!?])\s+|,\s+(?=(?:but|and|yet|though|although|while|however|whereas)\b))/i;

export const memoryClaimClause = (clause) =>
  MEMORY_CLAIM.test(clause)
  && !MEMORY_NEGATED.test(clause)
  && !MEMORY_FUTURE.test(clause)
  && !/\?\s*$/.test(clause);

/** Replace every clause of a line that asserts memory is complete with `status`; null when none does. */
export function supersedeMemoryClaims(line, status) {
  const parts = String(line ?? '').split(MEMORY_CLAUSE);
  let hit = false;
  for (let i = 0; i < parts.length; i += 2) {
    if (memoryClaimClause(parts[i])) {
      parts[i] = status;
      hit = true;
    }
  }
  return hit ? parts.join('') : null;
}

export function classifyMemoryPath(projectRoot, filePath) {
  if (!projectRoot || !filePath) return { matched: false, authoritative: false, path: '' };
  const root = `${resolve(projectRoot)}/.kilocode/memory/`;
  const resolved = resolve(projectRoot, String(filePath));
  if (!resolved.startsWith(root)) return { matched: false, authoritative: false, path: resolved };
  if (resolved === `${root}memory.readable.json`) {
    return { matched: true, authoritative: false, path: resolved };
  }
  const matched = /(\.md|\/status\.tsv)$/i.test(resolved) && !/\/\.kilocode\/memory\/(?:.*\/)?\./.test(resolved);
  const authoritative = matched && /^[^/]+\.md$/i.test(resolved.slice(root.length));
  return { matched, authoritative, path: resolved };
}

const svc = (ctx, name) => {
  if (ctx == null) return undefined;
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
};

function extractTouchedPaths(toolName, args) {
  if (toolName === 'apply_patch') {
    const patchText = String(args?.patchText ?? args?.patch ?? '');
    return [...patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1].trim());
  }
  const p = args?.file_path ?? args?.filePath ?? '';
  return p ? [String(p)] : [];
}

/** Create the `memory_preview` tool handler and memory companion validation/republish hooks. */
export function createMemoryPreview(ctx, config = {}) {
  const memoryPreviews = new Map();
  const memoryRefresh = new Map();
  const memoryOwners = new Set();
  const memoryDirty = new Map();
  const memoryClaimed = new Set();
  const debounceMs = Number.isInteger(config.debounceMs) ? config.debounceMs : 300;

  async function rootOf(exec = {}) {
    for (const candidate of [exec?.worktree, exec?.directory, exec?.root, config.root]) {
      if (typeof candidate === 'string' && isAbsolute(candidate) && candidate !== '/') return candidate;
    }
    const wd = svc(ctx, 'workingDirectory');
    if (wd && typeof wd.ensure === 'function' && exec?.agent) {
      const r = await wd.ensure(exec.agent, exec.signal);
      if (r && r !== '/') return r;
    }
    throw new Error('memory_preview: workspace root unavailable');
  }

  function resolveParentSession(sessionId) {
    const session = svc(ctx, 'sessions')?.get?.(sessionId) ?? svc(ctx, 'agents')?.get?.(sessionId)?.session;
    if (session?.header?.parentSession) return session.header.parentSession;
    if (session?.parentID) return session.parentID;
    return null;
  }

  function delegatedOwnerOf(sessionId) {
    let current = sessionId;
    for (let depth = 0; depth < 16; depth++) {
      if (memoryOwners.has(current)) return current;
      const parent = resolveParentSession(current);
      if (!parent) return current;
      current = parent;
    }
    return current;
  }

  function markMemoryDirty(ownerSessionId, projectRoot) {
    const canon = realpathSync(projectRoot);
    const set = memoryDirty.get(ownerSessionId) ?? new Set();
    set.add(canon);
    memoryDirty.set(ownerSessionId, set);
  }

  async function publishMemory(projectRoot) {
    const canon = realpathSync(projectRoot);
    const live = memoryPreviews.get(canon);
    if (live) {
      await live.rescan();
      return { path: `${canon}/.kilocode/memory/memory.html`, live: true };
    }
    return refreshMemoryHtml(canon);
  }

  async function reconcileMemory(projectRoot, initialize = false) {
    const canon = realpathSync(projectRoot);
    clearTimeout(memoryRefresh.get(canon));
    memoryRefresh.delete(canon);
    if (initialize) await initializeDerived(canon);
    return publishMemory(canon);
  }

  function scheduleMemoryRefresh(projectRoot, initialize = false) {
    let canon;
    try {
      canon = realpathSync(projectRoot);
    } catch {
      return;
    }
    clearTimeout(memoryRefresh.get(canon));
    const timer = setTimeout(async () => {
      memoryRefresh.delete(canon);
      try {
        if (initialize) await initializeDerived(canon);
        await publishMemory(canon);
      } catch { /* best-effort background refresh */ }
    }, debounceMs);
    timer.unref?.();
    memoryRefresh.set(canon, timer);
  }

  async function finalizeMemory(projectRoot, initialize = false) {
    let canon;
    try {
      canon = realpathSync(projectRoot);
    } catch (e) {
      return {
        complete: false,
        project: projectRoot,
        missingCount: 1,
        missing: [{ kind: 'memory', reason: String(e?.code ?? 'unavailable') }],
      };
    }
    clearTimeout(memoryRefresh.get(canon));
    memoryRefresh.delete(canon);
    try {
      if (initialize) await initializeDerived(canon);
      await publishMemory(canon);
      return await validateMemoryPublication(canon);
    } catch (e) {
      return {
        complete: false,
        project: canon,
        missingCount: 1,
        missing: [{ kind: 'memory', reason: String(e?.code ?? 'unavailable') }],
      };
    }
  }

  async function unfinishedMemory(sessionId) {
    const projects = memoryDirty.get(sessionId);
    const problems = [];
    for (const project of projects ?? []) {
      const result = await finalizeMemory(project, memoryOwners.has(sessionId));
      if (result.complete) projects.delete(project);
      else problems.push(describeIncomplete(result));
    }
    return problems;
  }

  async function recordMemoryWrite(sessionId, projectRoot, toolName, args, { immediate = false } = {}) {
    if (!EDIT_TOOLS.has(toolName) || !sessionId || !projectRoot) return false;
    const touched = extractTouchedPaths(toolName, args);
    const classified = touched
      .map((p) => classifyMemoryPath(projectRoot, p))
      .filter((c) => c.matched);
    if (!classified.length) return false;
    const authoritative = classified.some((c) => c.authoritative);
    if (authoritative) memoryOwners.add(sessionId);
    const owner = memoryOwners.has(sessionId) ? sessionId : delegatedOwnerOf(sessionId);
    markMemoryDirty(owner, projectRoot);
    if (immediate || debounceMs <= 0) {
      await reconcileMemory(projectRoot, authoritative);
    } else {
      scheduleMemoryRefresh(projectRoot, authoritative);
    }
    return true;
  }

  async function filterClaimText(sessionId, messageId, text) {
    if (!memoryDirty.get(sessionId)?.size || typeof text !== 'string') return text;
    const lines = text.split('\n');
    const claims = lines.flatMap((line, i) => (supersedeMemoryClaims(line, '') === null ? [] : [i]));
    if (!claims.length) return text;
    const problems = await unfinishedMemory(sessionId);
    if (!problems.length) return text;
    const key = `${sessionId}:${messageId ?? 'msg'}`;
    for (const i of claims) {
      const status = memoryClaimed.has(key)
        ? '[Memory status (harness): a memory-complete claim was removed here; project memory is NOT complete, see the status above.]'
        : `[Memory status (harness, replaced a memory-complete claim after this reply streamed): ${problems.join(' ')} Project memory is NOT complete.]`;
      lines[i] = supersedeMemoryClaims(lines[i], status);
      memoryClaimed.add(key);
    }
    return lines.join('\n');
  }

  async function execute(args = {}, exec = {}) {
    const context = await rootOf(exec);
    const { project } = await memoryRootOf(context);
    const action = args?.action ?? 'start';
    if (!['start', 'status', 'stop'].includes(action)) {
      throw new Error('memory_preview: action must be "start", "status", or "stop".');
    }
    let live = memoryPreviews.get(project);
    if (action === 'status') {
      if (live) {
        const info = { project, owner: 'this harness process', url: live.url, ...live.status() };
        return { status: 'running', ...info, message: JSON.stringify(info) };
      }
      const message = `No memory preview from this harness process is running for ${project}.`;
      return { status: 'stopped', project, message };
    }
    if (action === 'stop') {
      if (live) {
        await live.stop();
        memoryPreviews.delete(project);
        await clearPreviewState(project, live.url);
      } else {
        const state = await readPreviewState(project);
        if (state && (await requestStop(state)) === 200) {
          await clearPreviewState(project, state.url);
        }
      }
      return { status: 'stopped', project, message: 'Memory preview stopped.' };
    }
    let url = live?.url;
    if (!live) {
      const { reuse } = await acquirePreview(project);
      if (reuse) {
        url = reuse.url;
      } else {
        live = await startMemoryPreview(project, {
          unref: true,
          nativeWatch: config.nativeWatch ?? true,
          intervalMs: config.intervalMs ?? 2000,
        });
        memoryPreviews.set(project, live);
        await writePreviewState(project, live);
        url = live.url;
      }
    }
    const snapshotPath = `${project}/.kilocode/memory/memory.html`;
    const message =
      `Live memory preview for ${project}: ${url}\n` +
      `Offline snapshot (not live): ${snapshotPath}\n` +
      'The URL carries a local capability token; keep it private.';
    return {
      status: 'live',
      project,
      url,
      snapshotPath,
      message,
    };
  }

  // Async check: tools.guard is synchronous, so this must be a pre-execute waterfall step.
  const disposeGuard = typeof ctx?.on === 'function'
    ? ctx.on('tools/pre-execute', async (exec, next) => {
        const isCompleteGoal =
          (exec?.name === 'goal_report' && exec.arguments?.status === 'complete')
          || (exec?.name === 'update_goal' && exec.arguments?.action === 'complete');
        if (!isCompleteGoal) return next();
        const sessionId = exec?.agent?.session?.id ?? exec?.sessionID ?? exec?.sessionId;
        if (!sessionId) return next();
        const problems = await unfinishedMemory(sessionId);
        if (problems.length) {
          return { kind: 'deny', reason: `Memory gate: goal_report complete refused. ${problems.join(' ')} Author the missing plain-language explanations in memory.readable.json, let the view republish, then report again.` };
        }
        return next();
      })
    : null;

  const disposeResult = typeof ctx?.on === 'function'
    ? ctx.on('tools/result', async (exec, result) => {
        if (result?.isError || !EDIT_TOOLS.has(exec?.name)) return;
        const sessionId = exec?.agent?.session?.id ?? exec?.sessionID ?? exec?.sessionId;
        if (!sessionId) return;
        let projectRoot;
        try {
          projectRoot = await rootOf(exec);
        } catch {
          return;
        }
        await recordMemoryWrite(sessionId, projectRoot, exec.name, exec.arguments ?? {});
      })
    : null;

  function toolDefinition() {
    return {
      name: 'memory_preview',
      description:
        'Open the read-only HTML view of this project\'s .kilocode/memory. start reuses this project\'s running owned live preview or starts one on ' +
        '127.0.0.1 bound to the current project, after reconciling the Markdown into memory.html (0600); status reports it; stop ends this project\'s preview only. ' +
        'Markdown stays the only source; nothing is edited. memory.html on disk is an offline snapshot, not live.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['start', 'status', 'stop'] },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: typeof value?.message === 'string' ? value.message : JSON.stringify(value) }],
      },
      execute,
    };
  }

  return {
    execute,
    memoryPreview: execute,
    recordMemoryWrite,
    reconcileMemory,
    finalizeMemory,
    unfinishedMemory,
    filterClaimText,
    toolDefinition,
     async dispose() {
      for (const timer of memoryRefresh.values()) clearTimeout(timer);
      memoryRefresh.clear();
      for (const [project, live] of memoryPreviews.entries()) {
        try {
          await live.stop();
          await clearPreviewState(project, live.url);
        } catch { /* best-effort */ }
      }
      memoryPreviews.clear();
      memoryOwners.clear();
      memoryDirty.clear();
      memoryClaimed.clear();
      disposeGuard?.();
      disposeResult?.();
    },
  };
}

export function toolDefinition(ctx, config) {
  return createMemoryPreview(ctx, config).toolDefinition();
}
