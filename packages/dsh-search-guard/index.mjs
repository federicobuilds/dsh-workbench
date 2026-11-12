import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

export const name = 'dsh-search-guard';
export const inject = ['tools'];
const home = homedir();
const icloud = `${home}/Library/Mobile Documents`;
const cloudDocs = `${icloud}/com~apple~CloudDocs`;
const key = value => process.platform === 'darwin' ? String(value).toLowerCase() : String(value);
const broadRoots = new Set(['/', home, '/Users', `${home}/Library`, icloud, `${home}/Library/CloudStorage`, cloudDocs, `${cloudDocs}/CLOUD_ARCHIVES`].map(key));
const refusal = 'searches must be scoped: provide a subdirectory path';
const names = new Set(['grep', 'glob', 'dsh_search_workspace', 'read']);

function scopePath(tool, args, cwd) {
  const rawArg = tool === 'read' ? (args?.file_path ?? args?.filePath ?? '') : tool === 'dsh_search_workspace' ? (args?.root ?? '') : (args?.path ?? '');
  const raw = String(rawArg ?? '').trim();
  const expanded = raw.replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home);
  if (!cwd && !isAbsolute(expanded)) return null;
  return expanded ? resolve(cwd || home, expanded) : resolve(cwd || home);
}

function basicScope(tool, args, cwd) {
  const targetPath = scopePath(tool, args, cwd);
  if (!targetPath) return null;
  const raw = String(args?.root ?? '').trim();
  if (broadRoots.has(key(targetPath))) return refusal;
  if (tool === 'dsh_search_workspace' && !raw) {
    const sessionKey = key(targetPath);
    if (sessionKey === key(icloud) || sessionKey.startsWith(`${key(icloud)}/`)) return refusal;
  }
  const pattern = String(args?.pattern ?? '');
  if (tool === 'glob' && (/^[~/$\\]/.test(pattern) || /(^|[/\\])\.\.([/\\]|$)/.test(pattern))) return refusal;
  return null;
}

export function apply(ctx) {
  const tools = ctx.get('tools');
  const guard = tools.guard(exec => {
    if (!names.has(exec?.name)) return undefined;
    try { return basicScope(exec.name, exec.arguments, exec.agent?.session?.header?.cwd) ?? undefined; }
    catch { return 'search scope unavailable: tool denied (fail closed)'; }
  });
  const post = ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!names.has(exec?.name)) return next();
      const cwd = exec?.agent ? (await ctx.get('workingDirectory')?.ensure?.(exec.agent, exec.signal) ?? exec.agent.session?.header?.cwd) : undefined;
      let reason = basicScope(exec.name, exec.arguments, cwd || home);
      if (!reason) {
        const target = scopePath(exec.name, exec.arguments, cwd || home);
        const actual = key(await fs.realpath(target));
        const rawRoot = String(exec.arguments?.root ?? '').trim();
        if (broadRoots.has(actual) || (exec.name === 'dsh_search_workspace' && !rawRoot && (actual === key(icloud) || actual.startsWith(`${key(icloud)}/`)))) reason = refusal;
      }
      const pattern = String(exec.arguments?.pattern ?? '');
      const judge = ctx.get('dshJudge');
      if (!reason && exec.name === 'glob' && pattern.startsWith('**') && typeof judge?.decide === 'function') {
        const path = String(exec.arguments?.path ?? '').trim().replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home);
        const state = JSON.stringify({ tool: exec.name, path: resolve(cwd || home, path || '.'), pattern });
        const result = await judge.decide({ operation: 'search-scope', family: 'simple', state }, { signal: exec.signal });
        if (result && !result.unavailable && result.decision && result.decision !== 'allow' && result.decision !== 'UNSURE') reason = refusal;
      }
      if (!reason) return next();
      const domain = ctx.get('storageDomain')?.get?.('dsh_governance_events');
      if (domain) {
        const id = randomUUID();
        await Promise.resolve(domain.table('events').put(id, { v: 1, id, ts: Date.now(), kind: 'info', session: exec?.agent?.session?.id ?? null, decision: 'denied', tool: exec.name, reason, permissionGranted: false })).catch(() => {});
      }
      return { kind: 'deny', reason };
    } catch { return { kind: 'deny', reason: 'search scope unavailable: tool denied (fail closed)' }; }
  });
  const dispose = () => { guard?.(); post?.(); };
  ctx.effect?.(() => dispose);
  return dispose;
}
