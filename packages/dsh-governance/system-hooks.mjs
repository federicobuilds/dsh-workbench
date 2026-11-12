import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEventStore } from './event-store.mjs';
import { getSessionRole, PRIMARY_ROLES } from './bindings.mjs';
import { NOZDR_KEY_PATH, isCanonicalFable, applyFableKeyHeader, createCredentialRouter } from './credential-router.mjs';
import { canonicalPresetId } from './legacy.mjs';

export { NOZDR_KEY_PATH, isCanonicalFable, applyFableKeyHeader };

const readAsset = (rel) => {
  try { return readFileSync(new URL(rel, import.meta.url), 'utf8').trim(); }
  catch { return ''; }
};

const RULES_TEXT = [
  readAsset('./rules/bash-discipline.md'),
  readAsset('./rules/git-status-injection.md'),
  readAsset('./rules/karpathy.md'),
].filter(Boolean).join('\n\n---\n\n');

const HUMAN_STYLE = readAsset('./prompts/shared/human-style.md');
const AGENT_WIRE = readAsset('./prompts/shared/agent-wire.md');
const MODEL_NOTES = [
  [/claude-opus-5\.5/i, readAsset('./prompts/models/opus-5.5.md')],
  [/claude-fable-5\.1/i, readAsset('./prompts/models/fable-5.1.md')],
];
const NO_STYLE_PRESETS = new Set(['brilliant-writer', 'dsh-agent-brilliant-writer']);

const HOME = homedir();
const ICLOUD = `${HOME}/Library/Mobile Documents`;
const CLOUD_DOCS = `${ICLOUD}/workspace-project`;
const rootKey = (v) => process.platform === 'darwin' ? String(v).toLowerCase() : String(v);
const BROAD_ROOTS = new Set([
  '/',
  HOME,
  '/Users',
  `${HOME}/Library`,
  ICLOUD,
  `${HOME}/Library/CloudStorage`,
  CLOUD_DOCS,
  `${CLOUD_DOCS}/CLOUD_ARCHIVES`,
].map(rootKey));

export const SCOPE_REFUSAL = 'searches must be scoped: provide a subdirectory path';

/** Check search/read scope against broad roots and unsafe glob patterns. */
export async function checkSearchScope(toolName, args, cwd, { judge, signal } = {}) {
  if (!['grep', 'glob', 'dsh_search_workspace', 'read'].includes(toolName)) return null;
  const rawArg = toolName === 'read'
    ? (args?.file_path ?? args?.filePath ?? '')
    : toolName === 'dsh_search_workspace'
      ? (args?.root ?? '')
      : (args?.path ?? '');
  const raw = String(rawArg ?? '').trim();
  const expanded = raw.replace(/^~(?=\/|$)/, HOME).replace(/^\$HOME(?=\/|$)/, HOME);
  const directory = typeof cwd === 'string' && cwd ? cwd : HOME;
  const targetPath = expanded ? resolve(directory, expanded) : resolve(directory);

  if (toolName === 'read') {
    return BROAD_ROOTS.has(rootKey(targetPath)) ? SCOPE_REFUSAL : null;
  }
  if (toolName === 'grep' || toolName === 'glob') {
    if (BROAD_ROOTS.has(rootKey(targetPath))) return SCOPE_REFUSAL;
  } else if (toolName === 'dsh_search_workspace') {
    if (!raw) {
      const sessKey = rootKey(targetPath);
      if (sessKey === rootKey(ICLOUD) || sessKey.startsWith(`${rootKey(ICLOUD)}/`)) return SCOPE_REFUSAL;
    } else if (BROAD_ROOTS.has(rootKey(targetPath))) {
      return SCOPE_REFUSAL;
    }
  }

  const pattern = String(args?.pattern ?? '');
  if (toolName === 'glob' && (/^[~/$\\]/.test(pattern) || /(^|[/\\])\.\.([/\\]|$)/.test(pattern))) {
    return SCOPE_REFUSAL;
  }
  if (toolName === 'glob' && pattern.includes('**') && judge && typeof judge.decide === 'function') {
    const question = JSON.stringify({ tool: toolName, path: targetPath, pattern });
    const res = await judge.decide({ operation: 'search-scope', family: 'simple', state: question }, { signal });
    if (res && !res.unavailable && res.decision && res.decision !== 'allow' && res.decision !== 'UNSURE') {
      return SCOPE_REFUSAL;
    }
  }
  return null;
}

/** Resolve the static style + rules + model notes for one prompt assembly. */
export function resolvePromptAdditions(assembleCtx, { getPreset, sessionStyles }) {
  const agent = assembleCtx?.agent;
  const session = agent?.session;
  const sessionId = session?.id;
  const modelSel = assembleCtx?.modelSelection ?? agent?.model?.current?.();
  const modelId = `${modelSel?.provider ?? ''}/${modelSel?.model ?? ''}`;

  const parts = [];
  if (RULES_TEXT) parts.push(RULES_TEXT);

  const note = MODEL_NOTES.find(([re]) => re.test(modelId))?.[1];
  if (note) parts.push(note);

  if (sessionId) {
    const basePreset = canonicalPresetId(getPreset?.(session) ?? session?.header?.agentPreset ?? '');
    const effectiveRole = getSessionRole(sessionId, basePreset);
    if (effectiveRole && effectiveRole !== basePreset) {
      const roleEntry = PRIMARY_ROLES.find(r => r.id === effectiveRole);
      if (roleEntry?.roleFile) {
        const rolePrompt = readAsset(`./roles/${roleEntry.roleFile}`);
        if (rolePrompt) parts.push(`# Active Role (${roleEntry.label})\n\n${rolePrompt}`);
      }
    }
    if (!sessionStyles.has(sessionId) || effectiveRole !== basePreset) {
      if (NO_STYLE_PRESETS.has(effectiveRole)) {
        sessionStyles.set(sessionId, '');
      } else {
        const isSubagent = session?.header?.origin === 'subagent';
        sessionStyles.set(sessionId, isSubagent ? AGENT_WIRE : HUMAN_STYLE);
      }
    }
    const style = sessionStyles.get(sessionId);
    if (style) parts.push(style);
  }
  return parts.join('\n\n');
}

export function applySystemHooks(ctx, sharedEvents, config = {}) {
  const disposers = [];
  const sessionStyles = new Map();
  const svc = (name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx?.[name];

  const sysPrompt = svc('systemPrompt');
  if (sysPrompt && typeof sysPrompt.section === 'function') {
    const d = sysPrompt.section({
      name: 'dsh:rules-and-style',
      order: 9500,
      interpolate: false,
      text: (assembleCtx) => resolvePromptAdditions(assembleCtx, {
        getPreset: (s) => svc('agentPresets')?.presetForSession?.(s),
        sessionStyles,
      }),
    });
    if (typeof d === 'function') disposers.push(d);
  }

  if (typeof ctx.on === 'function') {
    if (config.disableBundledCredentialRouter !== true) {
      const router = config.credentialRouter !== undefined ? createCredentialRouter(config.credentialRouter) : applyFableKeyHeader;
      disposers.push(ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
        router(request, headers);
        return typeof next === 'function' ? next() : headers;
      }));
    }
    if (config.disableBundledSearchGuard !== true) disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const toolName = exec?.name;
        if (!['grep', 'glob', 'dsh_search_workspace', 'read'].includes(toolName)) return next();
        const cwd = exec?.agent
          ? (await svc('workingDirectory')?.ensure?.(exec.agent, exec.signal) ?? exec.agent.session?.header?.cwd)
          : undefined;
        const refusal = await checkSearchScope(toolName, exec?.arguments, cwd, {
          judge: svc('dshJudge'),
          signal: exec?.signal,
        });
        if (refusal) {
          const domain = svc('storageDomain')?.get?.('dsh_governance_events');
          const store = sharedEvents ?? (domain ? createEventStore(domain) : null);
          if (store) {
            await store.record({
              v: 1,
              id: randomUUID(),
              ts: Date.now(),
              kind: 'info',
              session: exec?.agent?.session?.id ?? null,
              decision: 'denied',
              tool: toolName,
              reason: refusal,
              permissionGranted: false,
            }).catch(() => {});
          }
          return { kind: 'deny', reason: refusal };
        }
      } catch {
        return { kind: 'deny', reason: 'search scope unavailable: tool denied (fail closed)' };
      }
      return next();
    }));
  }

  return () => {
    sessionStyles.clear();
    for (const d of disposers) { try { d(); } catch {} }
  };
}
