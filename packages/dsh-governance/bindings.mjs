import { readFile } from 'node:fs/promises';
import { canonicalPresetId, isLegacyPresetId, isRoleEvent, LEGACY_ROLE_PROJECTION_KEY } from './legacy.mjs';

export const name = 'dsh-role-model-bindings';
export const inject = ['agents', 'agentPresets', 'llm'];
const assignments = JSON.parse(await readFile(new URL('./assignments.json', import.meta.url), 'utf8'));
export const compactionAssignment = assignments['dsh-aux-compaction'];
const profileOverrides = new WeakMap();
const profileRegistry = ctx => ctx?.get?.('agentPresets') ?? ctx?.agentPresets;
export const roleModelOverrides = ctx => {
  const registry = profileRegistry(ctx);
  return registry ? profileOverrides.get(registry) : undefined;
};
export function publishRoleModelOverrides(ctx, config, configuredAssignments, revision) {
  const registry = profileRegistry(ctx);
  if (!registry) throw new Error('Role presets configuration error: profile registry unavailable');
  const publication = Object.freeze({ config, assignments: configuredAssignments, revision });
  profileOverrides.set(registry, publication);
  return () => { if (profileOverrides.get(registry) === publication) profileOverrides.delete(registry); };
}
const assignmentFor = (ctx, presetId) => roleModelOverrides(ctx)?.assignments[canonicalPresetId(presetId)] ?? assignments[canonicalPresetId(presetId)];
const assignmentKey = (presetId, assignment) => `${canonicalPresetId(presetId)}\0${assignment.target}\0${assignment.variant ?? ''}`;
export const CATALOG_MODEL_ALIASES = Object.freeze({
  'deepseek/deepseek-v4.1-flash-1017': Object.freeze(['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v3.2', 'google/gemini-3.6-flash']),
  'moonshotai/kimi-k3.1-pro': Object.freeze(['moonshotai/kimi-k3', 'moonshotai/kimi-k2.5', 'qwen/qwen3.8-2.4t-a95b']),
  'openai/gpt-6.1-terra': Object.freeze(['openai/gpt-6.1-sol']),
});
export const unknownModel = error => error?.code === 'UNKNOWN_MODEL' || /has no configured model/i.test(error?.message ?? '');

const sessionRoleOverrides = new Map();
const pickerListWrapper = Symbol.for('@dsh-workbench/dsh-governance/picker-list');
let roleProjectionReady;
const roleSchema = { parse(value) {
  if (value !== null && (typeof value !== 'string' || !value)) throw new Error('Invalid persisted role');
  return canonicalPresetId(value);
} };
export const ROLE_PROJECTION = {
  key: 'dshActiveRole', stateVersion: 1, stateSchema: roleSchema,
  init: () => null,
  apply: (state, event) => isRoleEvent(event.type) && event.ignorable === true
    ? roleSchema.parse(event.data.roleId) : state,
};
export const LEGACY_ROLE_PROJECTION = { ...ROLE_PROJECTION, key: LEGACY_ROLE_PROJECTION_KEY };

export const PRIMARY_ROLES = Object.freeze([
  { id: 'dsh-coordinator-simple', label: 'Coordinator', target: null, roleFile: 'coordinator.md', coordinator: true },
  { id: 'dsh-coder', label: 'Coder', target: null, roleFile: 'coder.md', coordinator: false },
  { id: 'dsh-researcher', label: 'Deep Researcher', target: null, roleFile: 'researcher.md', coordinator: false },
  { id: 'dsh-reviewer', label: 'Reviewer', target: null, roleFile: 'reviewer.md', coordinator: false },
  { id: 'dsh-auditor', label: 'Auditor', target: null, roleFile: 'auditor.md', coordinator: false },
  { id: 'dsh-teacher', label: 'Teacher', target: null, roleFile: 'teacher.md', coordinator: false },
  { id: 'dsh-advisor', label: 'Advisor', target: null, roleFile: 'advisor.md', coordinator: false },
  { id: 'dsh-video-editor', label: 'Video Editor', target: null, roleFile: 'video-editor.md', coordinator: false },
]);

export function getSessionRole(sessionId, fallbackPreset = null) {
  return canonicalPresetId(sessionRoleOverrides.get(sessionId) ?? fallbackPreset);
}

export async function selectionFor(assignment, resolveModelInfo) {
  const split = assignment.target.indexOf('/');
  if (!/^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(assignment.target)) throw new Error('Invalid assigned model identifier');
  const provider = assignment.target.slice(0, split);
  const model = assignment.target.slice(split + 1);
  const selection = { provider, model };
  const info = await resolveModelInfo(provider, model);
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Assigned role model has no native metadata');
  if (assignment.variant !== null && (provider !== 'degen' || info?.reasoning?.efforts)) {
    if (!info?.reasoning?.efforts?.some(effort => effort.id === assignment.variant)) {
      throw new Error('Assigned role variant has no verified native effort mapping');
    }
    selection.reasoningEffort = assignment.variant;
  }
  return Object.freeze(selection);
}

export async function resolveRouteSelection(assignment, resolveModelInfo, select) {
  const split = assignment.target.indexOf('/');
  const provider = assignment.target.slice(0, split);
  const model = assignment.target.slice(split + 1);
  const aliases = provider === 'openrouter' ? (CATALOG_MODEL_ALIASES[model] ?? []) : [];
  const candidates = [assignment.target, ...aliases.map(alias => `${provider}/${alias}`)];
  let lastError;
  for (const target of candidates) {
    try {
      const selection = await selectionFor({ ...assignment, target }, resolveModelInfo);
      if (select) await select(selection);
      return selection;
    } catch (error) {
      if (!unknownModel(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function selectAssignedModel(agent, assignment, resolveModelInfo) {
  return resolveRouteSelection(assignment, resolveModelInfo, selection => agent.model.select(selection));
}

/** Switch a live session's active role and assigned model in-place mid-session. */
export async function switchSessionRole(ctx, agent, roleId) {
  roleId = canonicalPresetId(roleId);
  const sessionId = agent?.session?.id;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session for role switch');
  const presets = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : ctx?.agentPresets;
  const nativePreset = presets?.presetForSession?.(agent.session) ?? agent.session?.header?.agentPreset ?? null;
  if (nativePreset === 'cordis') throw new Error(`Cannot switch DSH role on non-DSH session preset "${nativePreset}"; select a DSH preset first`);
  const known = PRIMARY_ROLES.find(r => r.id === roleId);
  if (!known && !assignmentFor(ctx, roleId)) throw new Error(`Unknown role "${String(roleId)}"`);
  if (!roleProjectionReady) throw new Error('Session role state unavailable');
  await roleProjectionReady;
  const { appendPluginRecord } = await import('@deepseek-ai/dsh-session');
  const assignment = assignmentFor(ctx, roleId) ?? (known?.target ? { target: known.target, variant: null } : null);
  if (assignment) {
    if (!agent?.model?.select) throw new Error('Agent model selector unavailable');
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm;
    await selectAssignedModel(agent, assignment, async (provider, model) => {
      try { return await llm?.resolveModelInfo?.(provider, model); }
      catch (error) { if (unknownModel(error)) throw error; return null; }
    });
  }
  appendPluginRecord(agent.session, 'plugin:dsh-governance/role', { roleId });
  sessionRoleOverrides.set(sessionId, roleId);
  return { roleId, model: agent?.model?.current?.() ?? null };
}

/** Assign source models on new role sessions; ordinary cold resume keeps its recorded choice. */
export function applyBindings(ctx) {
  const agents = ctx.get('agents');
  const presets = ctx.get('agentPresets');
  const llm = ctx.get('llm');
  if (!agents || !presets || !llm) throw new Error('Role model services unavailable');
  if (typeof presets.list === 'function' && !presets.list[pickerListWrapper]) {
    const origList = presets.list.bind(presets);
    // 2026-11-09: The installed registry has no hidden flag; this is only the picker view, not resolve, mount or register.
    presets.listAll = origList;
    const pickerList = (...args) => {
      const rows = origList(...args);
      const visible = list => list.filter(p => !isLegacyPresetId(p?.id) && !String(p?.id ?? '').startsWith('dsh-worker-') && !['dsh-coordinator-off', 'dsh-coordinator-free', 'dsh-coordinator-advanced'].includes(p?.id));
      return Array.isArray(rows) ? visible(rows) : rows.then(visible);
    };
    pickerList[pickerListWrapper] = true;
    presets.list = pickerList;
  }
  const projections = ctx.get('sessionProjections');
  roleProjectionReady = projections?.register ? Promise.all([projections.register(ROLE_PROJECTION), projections.register(LEGACY_ROLE_PROJECTION)]) : undefined;
  const applied = new WeakMap();
  const pending = new WeakMap();
  async function assign(agent, presetId) {
    presetId = canonicalPresetId(presetId);
    const publication = roleModelOverrides(ctx);
    const assignment = assignmentFor(ctx, presetId);
    if (!assignment) return;
    const key = assignmentKey(presetId, assignment);
    if (applied.get(agent)?.key === key && applied.get(agent)?.publication === publication) return;
    const existing = pending.get(agent);
    if (existing) await existing;
    if (applied.get(agent)?.key === key && applied.get(agent)?.publication === publication) return;
    const operation = (async () => {
      await selectAssignedModel(agent, assignment, (provider, model) => llm.resolveModelInfo(provider, model));
      applied.set(agent, { key, publication });
    })();
    pending.set(agent, operation);
    try { await operation; }
    finally { if (pending.get(agent) === operation) pending.delete(agent); }
  }
  ctx.on('agent/created', async ({ agent, source }) => {
    if (roleProjectionReady) {
      const [projection, legacyProjection] = await roleProjectionReady;
      const role = roleSchema.parse(projection.stateOf(agent.session) ?? legacyProjection.stateOf(agent.session));
      if (role) sessionRoleOverrides.set(agent.session.id, role);
      else sessionRoleOverrides.delete(agent.session.id);
    }
    const presetId = getSessionRole(agent.session.id, presets.presetForSession(agent.session));
    const assignment = assignmentFor(ctx, presetId);
    if (!assignment) return;
    if (source === 'resume' || source === 'compact') {
      applied.set(agent, { key: assignmentKey(presetId, assignment), publication: roleModelOverrides(ctx) });
      return;
    }
    await assign(agent, presetId);
  });
  ctx.on('agent-preset/selected', async (sessionId, presetId) => {
    presetId = canonicalPresetId(presetId);
    sessionRoleOverrides.delete(sessionId);
    const agent = agents.get(sessionId);
    if (agent?.session && roleProjectionReady) {
      await roleProjectionReady;
      const { appendPluginRecord } = await import('@deepseek-ai/dsh-session');
      appendPluginRecord(agent.session, 'plugin:dsh-governance/role', { roleId: null });
    }
    if (agent) await assign(agent, presetId);
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const presetId = getSessionRole(agent.session?.id, presets.presetForSession(agent.session));
    const publication = roleModelOverrides(ctx);
    const assignment = assignmentFor(ctx, presetId);
    if (!assignment) return next();
    const operation = pending.get(agent);
    if (operation) await operation;
    const previous = applied.get(agent);
    if (!publication && previous?.publication && previous.key.split('\0', 1)[0] === presetId) return next();
    if (previous?.key !== assignmentKey(presetId, assignment) || previous?.publication !== publication) {
      await assign(agent, presetId);
      return { kind: 'reject' };
    }
    return next();
  });
}
