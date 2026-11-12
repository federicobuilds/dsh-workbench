import { randomUUID } from 'node:crypto';
import {
  SHIPPED_PRIORS,
  median,
  CALIBRATION_DOMAIN_SPEC,
  emptyWorkspaceProfile,
  initSessionProjectionState,
  applySessionProjectionEvent,
  buildSessionForecast,
} from './engine.js';
import { TYPERT, sessionProjectionStateSchema, sessionProjectionViewSchema } from './remote.js';

export const name = 'task-progress';
export const inject = ['sessionProjections'];

const svc = (ctx, key) => {
  if (!ctx) return undefined;
  return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key];
};

function readKiloSignals(ctx, sessionId, sinceMs) {
  const storageDomain = svc(ctx, 'storageDomain');
  if (!storageDomain || typeof storageDomain.get !== 'function') {
    return { active: false, editRevision: null, recentBlocks: 0, recentReasons: [] };
  }

  const eventsDomain = storageDomain.get('dsh_governance_events');
  const verificationDomain = storageDomain.get('dsh_verification');
  if (!eventsDomain && !verificationDomain) {
    return { active: false, editRevision: null, recentBlocks: 0, recentReasons: [] };
  }

  let editRevision = null;
  try {
    const editRec = verificationDomain?.table?.('edits')?.get?.(sessionId);
    if (editRec && typeof editRec.revision === 'number') {
      editRevision = editRec.revision;
    }
  } catch { /* read-only best effort */ }

  let recentBlocks = 0;
  const recentReasons = [];
  const cutoff = sinceMs ?? (Date.now() - 180000);

  try {
    const table = eventsDomain?.table?.('events');
    if (table && typeof table.entries === 'function') {
      for (const [, rec] of table.entries()) {
        if (!rec || rec.session !== sessionId || typeof rec.ts !== 'number' || rec.ts < cutoff) continue;
        const isBlock = rec.decision === 'blocked'
          || rec.decision === 'denied'
          || rec.decision === 'refused'
          || rec.decision === 'fail';
        if (isBlock && ['check', 'test-guard', 'efficiency', 'mcp-gate', 'judge', 'dispatch'].includes(rec.kind)) {
          recentBlocks += 1;
          if (typeof rec.reason === 'string' && rec.reason && recentReasons.length < 3) {
            recentReasons.push(rec.reason);
          }
        }
      }
    }
  } catch { /* read-only best effort */ }

  return {
    active: true,
    editRevision,
    recentBlocks,
    recentReasons,
  };
}

function hasBackgroundJobs(ctx, sessionId, state) {
  try {
    const jobs = svc(ctx, 'jobs');
    if (jobs && typeof jobs.list === 'function') {
      const list = jobs.list(sessionId);
      if (Array.isArray(list)) return list.some(j => j.owner === sessionId && (j.status === 'running' || j.status === 'stopping'));
    }
  } catch { /* ignore */ }
  return state.activeJobIds.length > 0;
}

function hasBackgroundAgents(ctx, sessionId) {
  try {
    const agents = svc(ctx, 'agents');
    const parent = agents?.get?.(sessionId);
    if (parent && typeof agents.list === 'function' && typeof agents.isOwnedBy === 'function') {
      for (const candidate of agents.list()) {
        if (candidate.id !== sessionId && agents.isOwnedBy(candidate.id, parent) && candidate.status === 'running') {
          return true;
        }
      }
    }
  } catch { /* ignore */ }

  return false;
}

export async function apply(ctx) {
  let calibrationDomain = null;
  const disposers = [];
  let cleanupRef = () => {};
  let disposed = false;

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => cleanupRef(), 'task-progress: lifecycle');
  }

  const storageDomain = svc(ctx, 'storageDomain');
  if (storageDomain) {
    try {
      calibrationDomain = storageDomain.get?.(CALIBRATION_DOMAIN_SPEC.name)
        ?? (await storageDomain.open?.(CALIBRATION_DOMAIN_SPEC));
    } catch {
      calibrationDomain = storageDomain.get?.(CALIBRATION_DOMAIN_SPEC.name) ?? null;
    }
  }

  const readWorkspaceProfile = workspace => {
    const key = workspace || '__default__';
    if (!calibrationDomain) return emptyWorkspaceProfile(key);
    try {
      return calibrationDomain.table('workspaces').get(key) ?? emptyWorkspaceProfile(key);
    } catch {
      return emptyWorkspaceProfile(key);
    }
  };

  const readAllMachineTasks = () => {
    if (!calibrationDomain) return [];
    const all = [];
    try {
      for (const [, prof] of calibrationDomain.table('workspaces').entries()) {
        if (Array.isArray(prof?.completedTasks)) {
          all.push(...prof.completedTasks);
        }
      }
    } catch { /* ignore */ }
    return all.slice(-200);
  };

  const pendingTaskIds = new Set();
  const pendingWorkspaceWrites = new Map();

  const recordCompletedTaskInStore = (workspace, sessionId, taskRecord, state) => {
    if (!calibrationDomain || !sessionId || disposed) return;
    const key = workspace || '__default__';
    const sourceId = JSON.stringify([sessionId, taskRecord.key]);
    if (pendingTaskIds.has(sourceId)) return;
    pendingTaskIds.add(sourceId);
    const previous = pendingWorkspaceWrites.get(key) ?? Promise.resolve();
    const write = previous.then(async () => {
      const table = calibrationDomain.table('workspaces');
      const current = table.get(key) ?? emptyWorkspaceProfile(key);
      const completedTaskSources = current.completedTaskSources ?? [];
      if (completedTaskSources.includes(sourceId)) return;
      const entry = {
        id: `${Date.now()}-${taskRecord.key}`,
        sourceSessionId: sessionId,
        sourceTaskKey: taskRecord.key,
        workspace: key,
        sizeTag: taskRecord.sizeTag,
        explicitTag: taskRecord.explicitTag,
        tokens: taskRecord.tokens.slice(0, 24),
        steps: Math.max(0.5, taskRecord.consumedSteps || 1),
        activeMs: Math.max(1000, taskRecord.consumedActiveMs || 5000),
        completedAt: taskRecord.completedAt ?? Date.now(),
      };
      const completedTasks = [...current.completedTasks, entry].slice(-80);
      const stepDurationSamplesMs = [
        ...current.stepDurationSamplesMs,
        ...(state.stepDurationSamplesMs ?? []).slice(-5),
      ].slice(-80);
      const toolEwmaMs = { ...current.toolEwmaMs, ...(state.toolEwmaMs ?? {}) };

      const stepMed = median(stepDurationSamplesMs) ?? SHIPPED_PRIORS.msPerStep;
      const predictedMs = (taskRecord.units || 2) * SHIPPED_PRIORS.stepsPerUnit * stepMed;
      const naivePredictedMs = stepMed * 3;
      const forecastErrorsMs = [
        ...(current.forecastErrorsMs ?? []),
        {
          predictedMs: Math.round(predictedMs),
          actualMs: Math.round(entry.activeMs),
          naivePredictedMs: Math.round(naivePredictedMs),
          at: Date.now(),
        },
      ].slice(-50);

      await table.put(key, {
        ...current,
        workspace: key,
        completedTasks,
        completedTaskSources: [...completedTaskSources, sourceId],
        toolEwmaMs,
        stepDurationSamplesMs,
        forecastErrorsMs,
        updatedAt: Date.now(),
      });
    }).catch(() => {}).finally(() => {
      pendingTaskIds.delete(sourceId);
      if (pendingWorkspaceWrites.get(key) === write) pendingWorkspaceWrites.delete(key);
    });
    pendingWorkspaceWrites.set(key, write);
  };

  const nudgedBySession = new Map();

  const computeForecastFromState = (state, session, agent) => {
    const sessionId = state.sessionId ?? session?.id ?? agent?.id;
    const workspace = state.workspace ?? session?.header?.cwd ?? '__default__';
    const currentAgent = agent ?? (sessionId ? svc(ctx, 'agents')?.get?.(sessionId) : undefined);

    if (sessionId && Array.isArray(state.tasks)) {
      for (const t of state.tasks) {
        if (t.status === 'completed') recordCompletedTaskInStore(workspace, sessionId, t, state);
      }
    }

    const wsProfile = readWorkspaceProfile(workspace);
    const machineTasks = readAllMachineTasks();
    const activeTask = state.tasks?.find?.(t => t.status === 'in_progress');
    const kiloSignals = sessionId
      ? readKiloSignals(ctx, sessionId, activeTask?.startedAt ?? state.activeTurnStartAt)
      : { active: false, editRevision: null, recentBlocks: 0, recentReasons: [] };

    const running = currentAgent ? currentAgent.status === 'running' : state.activeTurnStartAt !== null;
    const backgroundJobsActive = sessionId ? hasBackgroundJobs(ctx, sessionId, state) : false;
    const backgroundActive = backgroundJobsActive || (sessionId ? hasBackgroundAgents(ctx, sessionId) : false);
    const waitingForUser = !running && !backgroundActive && Array.isArray(state.tasks) && state.tasks.some(t => t.status !== 'completed');

    return { ...buildSessionForecast(state, {
      workspaceProfile: wsProfile,
      machineTasks,
      kiloSignals,
      running,
      backgroundActive,
      waitingForUser,
      now: Date.now(),
    }), backgroundJobsActive };
  };

  // Register the session projection: `wire.view` computes the full calibrated EVM/Analogy/Survival
  // forecast directly so `useProjection('taskProgress')` on the Client receives it immediately!
  const projectionHandle = await ctx.sessionProjections.register({
    key: 'taskProgress',
    stateVersion: 5,
    stateSchema: sessionProjectionStateSchema,
    init: initSessionProjectionState,
    apply: (state, event) => applySessionProjectionEvent(state, event),
    wire: {
      viewSchema: sessionProjectionViewSchema,
      view: state => computeForecastFromState(state, undefined, undefined),
      summary: false,
    },
  });
  disposers.push(() => projectionHandle.dispose());

  const computeSnapshotForSession = (session, agent) => {
    const state = session ? projectionHandle.stateOf(session) : initSessionProjectionState();
    return computeForecastFromState(state, session, agent);
  };

  // Optional Typert & Host Service registration (zero external package imports required)
  const typert = svc(ctx, 'typert');
  if (typert && typeof typert.register === 'function') {
    try {
      const disposeTypert = typert.register(TYPERT);
      if (typeof disposeTypert === 'function') disposers.push(disposeTypert);
    } catch { /* ignore */ }
  }

  const hostService = {
    snapshot(agent, signal) {
      signal?.throwIfAborted?.();
      return computeSnapshotForSession(agent?.session, agent);
    },
    getForecast(sessionOrAgent) {
      const session = sessionOrAgent?.session ?? sessionOrAgent;
      const agent = sessionOrAgent?.session ? sessionOrAgent : svc(ctx, 'agents')?.get?.(session?.id);
      return computeSnapshotForSession(session, agent);
    },
  };

  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('taskProgress', true);
      ctx.taskProgress = hostService;
    } catch { /* ignore */ }
  }

  // Static System Prompt Section (updates only at task boundaries so prompt cache stays warm within a task)
  const sysPrompt = svc(ctx, 'systemPrompt');
  if (sysPrompt && typeof sysPrompt.section === 'function') {
    const disposeSection = sysPrompt.section({
      name: 'task-progress:guide',
      order: 9550,
      interpolate: false,
      text: assembleCtx => {
        const agent = assembleCtx?.agent ?? svc(ctx, 'agents')?.currentInitiator?.();
        const session = agent?.session;
        const sizingRule = 'When calling `todo_write`, append a relative size tag (`[S]`, `[M]`, `[L]`, or `[XL]`) to each item.';
        if (!session) return sizingRule;

        const snap = computeSnapshotForSession(session, agent);
        if (!snap.hasTodos) return sizingRule;

        const activeIdx = snap.tasks.findIndex(t => t.status === 'in_progress');
        const currentTask = activeIdx >= 0 ? snap.tasks[activeIdx] : snap.tasks.find(t => t.status === 'pending');
        if (!currentTask) return sizingRule;

        const idxLabel = activeIdx >= 0 ? activeIdx + 1 : snap.completedCount + 1;
        const plannedSec = Math.round((currentTask.plannedSteps * snap.calibratedStepMs) / 1000);
        return `${sizingRule}\nActive task budget: Task ${idxLabel}/${snap.totalCount} [${currentTask.sizeTag}] · ~${Math.ceil(currentTask.plannedSteps)} steps (~${plannedSec}s) · Scope ${snap.totalCount} tasks.`;
      },
    });
    if (typeof disposeSection === 'function') disposers.push(disposeSection);
  }

  // Transition-Triggered, Deduplicated Advisory Nudge via agent.inject()
  if (typeof ctx.on === 'function') {
    const disposePreStep = ctx.on('agent/pre-step', async ({ agent }, next) => {
      try {
        if (agent && agent.session) {
          const snap = computeSnapshotForSession(agent.session, agent);
          if (snap.hasTodos && (snap.stoplight === 'amber' || snap.stoplight === 'red')) {
            const activeTask = snap.tasks.find(t => t.status === 'in_progress') ?? snap.tasks[0];
            const taskKey = activeTask?.key ?? 'session';
            const dedupKey = `${taskKey}:${snap.stoplight}`;
            let seen = nudgedBySession.get(agent.id);
            if (!seen) {
              seen = new Set();
              nudgedBySession.set(agent.id, seen);
            }
            if (!seen.has(dedupKey) && typeof agent.inject === 'function') {
              seen.add(dedupKey);
              const guidance = snap.stoplight === 'red'
                ? `[Progress Guide · RED · ${snap.stoplightReason}] This task has significantly exceeded its planned budget or hit repeated guard blocks. Prefer the simplest working path or report the concrete blocker to the user in your next reply while preserving required checks.`
                : `[Progress Guide · AMBER · ${snap.stoplightReason}] Pace or scope is slipping (${snap.completedCount}/${snap.totalCount} done, SPI ${snap.spi}). Keep implementation surgical and avoid redundant verification reads when inputs have not changed.`;
              agent.inject({
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: guidance }],
                source: {
                  kind: 'task-progress-guide',
                  form: 'notice',
                  summary: `Progress guide: ${snap.stoplight} (${snap.stoplightReason})`.slice(0, 120),
                },
              });
            }
          }
        }
      } catch { /* never interrupt agent step */ }
      return next();
    });
    if (typeof disposePreStep === 'function') disposers.push(disposePreStep);
  }

  cleanupRef = async () => {
    disposed = true;
    for (const d of disposers.splice(0)) {
      try { await d(); } catch { /* ignore */ }
    }
    await Promise.all(pendingWorkspaceWrites.values());
    nudgedBySession.clear();
  };
}
