import { createHash } from 'node:crypto';

export const SIZE_UNITS = Object.freeze({
  S: 1,
  M: 2,
  L: 4,
  XL: 8,
});

// Shipped cold-start priors (used only when machine + workspace + session have 0 samples)
export const SHIPPED_PRIORS = Object.freeze({
  stepsPerUnit: 1.5, // S -> 1.5 steps, M -> 3 steps, L -> 6 steps, XL -> 12 steps
  msPerStep: 11000,  // 11s per step
  toolEwmaMs: {
    read: 900,
    grep: 1200,
    glob: 1100,
    edit: 2200,
    write: 2200,
    bash: 9500,
    subagent: 38000,
    subagent_fork: 38000,
    dsh_dispatch: 42000,
    dsh_review: 18000,
    check: 6500,
    default: 4500,
  },
  // Survival quantiles (steps) per size class for cold-start tail expectation
  classStepQuantiles: {
    S: [1, 1, 2, 2, 3, 4, 6],
    M: [1, 2, 3, 3, 4, 6, 9],
    L: [3, 4, 5, 6, 8, 11, 15],
    XL: [5, 7, 9, 12, 15, 20, 28],
  },
});

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'under',
  'after', 'before', 'when', 'where', 'while', 'make', 'add', 'update', 'fix',
  'check', 'verify', 'test', 'run', 'use', 'using', 'all', 'each', 'one', 'two',
]);

const SIZE_TAG_RE = /(?:\[\s*(S|M|L|XL)\s*\]|\(\s*(S|M|L|XL)\s*\))\s*$/i;

const WRITE_TOOLS = new Set(['edit', 'write', 'apply_patch']);
const VERIFY_TOOLS = new Set(['read', 'grep', 'glob', 'check', 'dsh_search_workspace', 'read_image']);

/**
 * Parse a todo content string into normalized content, size tag ('S'|'M'|'L'|'XL'),
 * relative story-point units, and lexical tokens for analogy matching.
 */
export function parseTaskContent(rawContent) {
  const trimmed = String(rawContent ?? '').trim();
  const match = SIZE_TAG_RE.exec(trimmed);
  const rawTag = (match?.[1] ?? match?.[2] ?? '').toUpperCase();
  const hasExplicitTag = rawTag in SIZE_UNITS;
  const cleanText = hasExplicitTag
    ? trimmed.slice(0, match.index).trim()
    : trimmed;

  const tokens = extractTokens(cleanText);
  const inferredTag = hasExplicitTag ? rawTag : inferHeuristicSizeTag(cleanText, tokens);
  const units = SIZE_UNITS[inferredTag] ?? 2;
  const key = createHash('sha1').update((cleanText || trimmed).toLowerCase()).digest('hex').slice(0, 12);

  return {
    key,
    rawContent: trimmed,
    cleanText: cleanText || trimmed,
    sizeTag: inferredTag,
    explicitTag: hasExplicitTag,
    units,
    tokens,
  };
}

export function extractTokens(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 24);
}

function inferHeuristicSizeTag(cleanText, tokens) {
  const lower = cleanText.toLowerCase();
  if (/\b(read|inspect|check|list|verify|lint|syntax|bump|rename)\b/.test(lower) && tokens.length <= 5) {
    return 'S';
  }
  if (/\b(architecture|migration|full|complete|overhaul|multi|suite|end-to-end|e2e|integration)\b/.test(lower)) {
    return 'L';
  }
  return 'M';
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function quantile(values, q) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pos = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

/**
 * Empirical-Bayes hierarchical shrinkage: blends sample estimate toward prior
 * with shrinkage weight n / (n + k) where k = 5.
 */
export function shrinkBlend(sampleValue, sampleCount, priorValue, k = 5) {
  if (sampleValue === null || sampleValue === undefined || !Number.isFinite(sampleValue) || sampleCount <= 0) {
    return priorValue;
  }
  const weight = sampleCount / (sampleCount + k);
  return weight * sampleValue + (1 - weight) * priorValue;
}

/**
 * Token Jaccard + size-class similarity for Shepperd & Schofield analogy matching.
 */
export function tokenSimilarity(tokensA, tokensB, tagA, tagB) {
  if (!tokensA?.length || !tokensB?.length) return 0;
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of tokensA) {
    if (setB.has(t)) intersection++;
  }
  if (intersection === 0) return 0;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = intersection / union;
  const tagBonus = tagA === tagB ? 0.12 : 0;
  return Math.min(1, jaccard + tagBonus);
}

/**
 * Shepperd & Schofield k-NN analogy estimator (k = 3, similarity floor = 0.22).
 * Searches workspace records first, then machine-wide records.
 */
export function estimateByAnalogy(task, workspaceTasks, machineTasks) {
  const SIMILARITY_FLOOR = 0.22;
  const K = 3;

  const scorePool = pool => {
    const matches = [];
    for (const candidate of pool ?? []) {
      if (!candidate || !Number.isFinite(candidate.steps) || candidate.steps <= 0) continue;
      const sim = tokenSimilarity(task.tokens, candidate.tokens, task.sizeTag, candidate.sizeTag);
      if (sim >= SIMILARITY_FLOOR) {
        matches.push({ sim, steps: candidate.steps, activeMs: candidate.activeMs, units: SIZE_UNITS[candidate.sizeTag] ?? 2 });
      }
    }
    matches.sort((a, b) => b.sim - a.sim);
    return matches.slice(0, K);
  };

  const top = scorePool(workspaceTasks);
  if (top.length < 2) {
    const machineTop = scorePool(machineTasks);
    for (const m of machineTop) {
      if (top.length >= K) break;
      top.push(m);
    }
  }

  if (top.length === 0) return null;

  let weightSum = 0;
  let weightedStepsPerUnit = 0;
  let weightedMsPerUnit = 0;
  for (const item of top) {
    const u = Math.max(1, item.units);
    weightSum += item.sim;
    weightedStepsPerUnit += item.sim * (item.steps / u);
    weightedMsPerUnit += item.sim * (item.activeMs / u);
  }
  if (weightSum <= 0) return null;

  return {
    plannedSteps: Math.max(0.8, (weightedStepsPerUnit / weightSum) * task.units),
    plannedMs: Math.max(2500, (weightedMsPerUnit / weightSum) * task.units),
    matchCount: top.length,
    topSimilarity: top[0].sim,
  };
}

/**
 * Survival-analysis conditional expectation: E[TotalSteps | ConsumedSteps >= s].
 * Uses empirical completed step counts for the task's size class (blended with
 * class quantiles), and switches to a pareto/85th-percentile tail continuation
 * once consumed steps exceed the median.
 */
export function conditionalExpectedSteps(consumedSteps, plannedSteps, sizeTag, classHistorySteps) {
  const s = Math.max(0, consumedSteps);
  if (s === 0) return Math.max(0.8, plannedSteps);

  const priorQuantiles = SHIPPED_PRIORS.classStepQuantiles[sizeTag] ?? SHIPPED_PRIORS.classStepQuantiles.M;
  const priorMedian = priorQuantiles[3] || 3;
  const scale = Math.max(0.35, plannedSteps / priorMedian);
  const scaledPrior = priorQuantiles.map(v => Math.max(0.8, v * scale));

  const pool = [
    ...scaledPrior,
    ...(Array.isArray(classHistorySteps) ? classHistorySteps.filter(v => Number.isFinite(v) && v > 0) : []),
  ].sort((a, b) => a - b);

  const survivors = pool.filter(v => v > s + 0.15);

  if (survivors.length >= 2) {
    const tailMean = survivors.reduce((acc, v) => acc + v, 0) / survivors.length;
    return Math.max(s + 0.6, tailMean);
  }

  const p85 = quantile(pool, 0.85) ?? plannedSteps * 1.5;
  const tailRemaining = Math.max(1.0, Math.min(p85 * 0.45, s * 0.35));
  return s + tailRemaining;
}

export const CALIBRATION_DOMAIN_SPEC = Object.freeze({
  name: 'dsh_task_progress_calibration',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: {
    workspaces: {
      valueSchema: {
        parse(raw) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Invalid workspace calibration profile');
          }
          if (typeof raw.workspace !== 'string' || !Array.isArray(raw.completedTasks)) {
            throw new Error('Invalid workspace calibration fields');
          }
          return JSON.parse(JSON.stringify(raw));
        },
      },
    },
  },
});

export function emptyWorkspaceProfile(workspace) {
  return {
    workspace,
    completedTasks: [],
    toolEwmaMs: {},
    stepDurationSamplesMs: [],
    forecastErrorsMs: [],
    updatedAt: Date.now(),
  };
}

export function initSessionProjectionState(header) {
  return {
    sessionId: header?.id ?? null,
    workspace: header?.cwd ?? '__default__',
    activeJobIds: [],
    initialTaskCount: null,
    peakTaskCount: 0,
    tasks: [],
    activeStepStartAt: null,
    activeTurnStartAt: null,
    lastStepEndAt: null,
    totalSteps: 0,
    totalActiveMs: 0,
    stepDurationSamplesMs: [],
    toolCallStartByCallId: {},
    activeToolNames: [],
    toolEwmaMs: {},
    verifyCallsSinceLastEdit: 0,
    verifyCountsPerCompletedTask: [],
    currentTaskVerifyCalls: 0,
    lastEditSeq: null,
    goalId: null,
    goalObjective: null,
    goalPhase: null,
    goalRoundsStarted: 0,
    goalMaxRounds: 0,
    goalCreatedAt: null,
    goalUpdatedAt: null,
    revisions: [],
    completedPredictions: [],
    lastRevisionReason: null,
    lastRevisionDeltaMs: 0,
    lastRevisionAt: null,
  };
}

function attributeStepToActiveTasks(tasks, stepDurationMs, countStep = true) {
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const targets = inProgress.length > 0 ? inProgress : tasks.filter(t => t.status === 'pending').slice(0, 1);
  if (targets.length === 0) return tasks;

  const totalUnits = targets.reduce((sum, t) => sum + Math.max(1, t.units), 0);
  const targetKeys = new Set(targets.map(t => t.key));

  return tasks.map(t => {
    if (!targetKeys.has(t.key)) return t;
    const share = Math.max(1, t.units) / totalUnits;
    return {
      ...t,
      consumedSteps: t.consumedSteps + (countStep ? share : 0),
      consumedActiveMs: t.consumedActiveMs + stepDurationMs * share,
    };
  });
}

export function applySessionProjectionEvent(state, event, onTaskCompleted) {
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now();
  const seq = typeof event.seq === 'number' ? event.seq : 0;

  switch (event.type) {
    case 'job/registered': {
      const jobId = event.data?.jobId;
      if (typeof jobId !== 'string' || state.activeJobIds.includes(jobId)) return state;
      return { ...state, activeJobIds: [...state.activeJobIds, jobId] };
    }

    case 'job/settled': {
      const jobId = event.data?.jobId;
      if (!state.activeJobIds.includes(jobId)) return state;
      return { ...state, activeJobIds: state.activeJobIds.filter(id => id !== jobId) };
    }

    case 'turn/start': {
      // Preserve unfinished tasks across user replies (only clear when every task was already completed
      // in a prior turn and no active goal is running).
      const hasUnfinished = state.tasks.some(t => t.status !== 'completed');
      const keepTasks = (state.goalPhase === 'active' || hasUnfinished) ? state.tasks : [];
      return {
        ...state,
        tasks: keepTasks,
        initialTaskCount: keepTasks.length > 0 ? state.initialTaskCount : null,
        activeTurnStartAt: time,
      };
    }

    case 'turn/end': {
      const elapsed = state.activeStepStartAt === null ? 0 : Math.max(0, Math.min(300000, time - state.activeStepStartAt));
      return {
        ...state,
        totalActiveMs: state.totalActiveMs + elapsed,
        tasks: elapsed > 0 ? attributeStepToActiveTasks(state.tasks, elapsed, false) : state.tasks,
        activeTurnStartAt: null,
        activeStepStartAt: null,
        activeToolNames: [],
      };
    }

    case 'step/start': {
      return {
        ...state,
        activeStepStartAt: time,
      };
    }

    case 'step/end': {
      const stepDurationMs = state.activeStepStartAt !== null
        ? Math.max(200, Math.min(300000, time - state.activeStepStartAt))
        : 4000;
      const nextSamples = [...state.stepDurationSamplesMs, stepDurationMs].slice(-40);
      const nextTasks = attributeStepToActiveTasks(state.tasks, stepDurationMs);
      return {
        ...state,
        activeStepStartAt: null,
        lastStepEndAt: time,
        totalSteps: state.totalSteps + 1,
        totalActiveMs: state.totalActiveMs + stepDurationMs,
        stepDurationSamplesMs: nextSamples,
        tasks: nextTasks,
        activeToolNames: [],
      };
    }

    case 'tool/call': {
      const callId = String(event.data?.callId ?? '');
      const toolName = String(event.data?.name ?? 'default');
      if (!callId) return state;
      const nextMap = { ...state.toolCallStartByCallId, [callId]: { tool: toolName, at: time } };
      const nextActiveTools = state.activeToolNames.includes(toolName)
        ? state.activeToolNames
        : [...state.activeToolNames, toolName];
      return {
        ...state,
        toolCallStartByCallId: nextMap,
        activeToolNames: nextActiveTools,
      };
    }

    case 'tool/result': {
      const callId = String(event.data?.message?.toolCallId ?? event.data?.message?.source?.callId ?? '');
      const started = callId ? state.toolCallStartByCallId[callId] : undefined;
      const nextMap = { ...state.toolCallStartByCallId };
      if (callId) delete nextMap[callId];

      let nextToolEwma = state.toolEwmaMs;
      let nextVerifySinceEdit = state.verifyCallsSinceLastEdit;
      let nextCurrentTaskVerify = state.currentTaskVerifyCalls;
      let nextLastEditSeq = state.lastEditSeq;

      const toolName = started?.tool ?? '';
      if (started && time >= started.at) {
        const dur = Math.max(50, Math.min(600000, time - started.at));
        const prev = nextToolEwma[toolName] ?? SHIPPED_PRIORS.toolEwmaMs[toolName] ?? SHIPPED_PRIORS.toolEwmaMs.default;
        const alpha = 0.35;
        nextToolEwma = {
          ...nextToolEwma,
          [toolName]: Math.round(alpha * dur + (1 - alpha) * prev),
        };
      }

      const isError = Boolean(event.data?.message?.isError || event.data?.error);
      if (!isError && WRITE_TOOLS.has(toolName)) {
        nextVerifySinceEdit = 0;
        nextLastEditSeq = seq;
      } else if (VERIFY_TOOLS.has(toolName) || toolName === 'bash') {
        nextVerifySinceEdit += 1;
        nextCurrentTaskVerify += 1;
      }

      const remainingTools = Object.values(nextMap).map(v => v.tool);
      return {
        ...state,
        toolCallStartByCallId: nextMap,
        activeToolNames: [...new Set(remainingTools)],
        toolEwmaMs: nextToolEwma,
        verifyCallsSinceLastEdit: nextVerifySinceEdit,
        currentTaskVerifyCalls: nextCurrentTaskVerify,
        lastEditSeq: nextLastEditSeq,
      };
    }

    case 'todo/write': {
      const rawList = Array.isArray(event.data?.todos) ? event.data.todos : [];
      const prevByKey = new Map();
      const prevOccurrences = new Map();
      for (const task of state.tasks) {
        const base = parseTaskContent(task.rawContent).key;
        const occurrence = prevOccurrences.get(base) ?? 0;
        prevOccurrences.set(base, occurrence + 1);
        prevByKey.set(occurrence === 0 ? base : `${base}:${occurrence}`, task);
      }
      const prevCompletedCount = state.tasks.filter(t => t.status === 'completed').length;

      const nextTasks = [];
      const newlyCompleted = [];
      const occurrences = new Map();

      for (const item of rawList) {
        if (!item || typeof item.content !== 'string') continue;
        const parsed = parseTaskContent(item.content);
        const occurrence = occurrences.get(parsed.key) ?? 0;
        occurrences.set(parsed.key, occurrence + 1);
        const key = occurrence === 0 ? parsed.key : `${parsed.key}:${occurrence}`;
        const status = item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending';
        const existing = prevByKey.get(key);

        let startedAt = existing?.startedAt ?? null;
        let completedAt = existing?.completedAt ?? null;
        let reopenedCount = existing?.reopenedCount ?? 0;

        if (status === 'in_progress' && startedAt === null) {
          startedAt = time;
        }
        if (existing?.status === 'completed' && status !== 'completed') {
          reopenedCount += 1;
          completedAt = null;
        }
        if (status === 'completed' && existing?.status !== 'completed') {
          completedAt = time;
          if (startedAt === null) startedAt = state.activeTurnStartAt ?? time;
        }

        const taskRecord = {
          key,
          rawContent: parsed.rawContent,
          cleanText: parsed.cleanText,
          sizeTag: parsed.sizeTag,
          explicitTag: parsed.explicitTag,
          units: parsed.units,
          tokens: parsed.tokens,
          status,
          startedAt,
          completedAt,
          consumedSteps: existing?.consumedSteps ?? (status === 'completed' ? 1 : 0),
          consumedActiveMs: existing?.consumedActiveMs ?? (status === 'completed' && startedAt ? Math.max(1500, time - startedAt) : 0),
          reopenedCount,
          plannedStepsAtStart: existing?.plannedStepsAtStart ?? null,
          plannedMsAtStart: existing?.plannedMsAtStart ?? null,
        };

        if (status === 'completed' && existing?.status !== 'completed') {
          newlyCompleted.push(taskRecord);
        }
        nextTasks.push(taskRecord);
      }

      if (typeof onTaskCompleted === 'function' && newlyCompleted.length > 0) {
        for (const done of newlyCompleted) {
          try { onTaskCompleted(done); } catch { /* ignore */ }
        }
      }

      const initialTaskCount = state.initialTaskCount === null && nextTasks.length > 0
        ? nextTasks.length
        : state.initialTaskCount;
      const peakTaskCount = Math.max(state.peakTaskCount, nextTasks.length);

      const nextVerifyCounts = newlyCompleted.length > 0
        ? [...state.verifyCountsPerCompletedTask, state.currentTaskVerifyCalls].slice(-20)
        : state.verifyCountsPerCompletedTask;

      let reason = null;
      if (state.tasks.length === 0 && nextTasks.length > 0) {
        reason = 'plan initialized';
      } else if (nextTasks.length > state.tasks.length) {
        reason = `+${nextTasks.length - state.tasks.length} task${nextTasks.length - state.tasks.length > 1 ? 's' : ''} added`;
      } else if (nextTasks.length < state.tasks.length) {
        reason = 'scope trimmed';
      } else if (newlyCompleted.length > 0) {
        const doneNow = nextTasks.filter(t => t.status === 'completed').length;
        reason = `task ${doneNow}/${nextTasks.length} complete`;
      } else if (nextTasks.some(t => t.reopenedCount > (prevByKey.get(t.key)?.reopenedCount ?? 0))) {
        reason = 'task reopened';
      } else if (prevCompletedCount === nextTasks.filter(t => t.status === 'completed').length) {
        reason = 'task active';
      }

      return {
        ...state,
        initialTaskCount,
        peakTaskCount,
        tasks: nextTasks,
        verifyCountsPerCompletedTask: nextVerifyCounts,
        currentTaskVerifyCalls: newlyCompleted.length > 0 ? 0 : state.currentTaskVerifyCalls,
        lastRevisionReason: reason ?? state.lastRevisionReason,
        lastRevisionDeltaMs: state.lastRevisionAt === null ? 0 : Math.max(0, time - state.lastRevisionAt),
        lastRevisionAt: time,
      };
    }

    case 'goal/change': {
      const data = event.data;
      if (!data || data.kind !== 'goal/change') return state;
      if (data.operation === 'clear') {
        return {
          ...state,
          goalId: null,
          goalObjective: null,
          goalPhase: null,
          goalRoundsStarted: 0,
          goalMaxRounds: 0,
          goalCreatedAt: null,
          goalUpdatedAt: null,
        };
      }
      const goal = data.goal;
      if (!goal || typeof goal !== 'object') return state;
      return {
        ...state,
        goalId: typeof goal.id === 'string' ? goal.id : state.goalId,
        goalObjective: typeof goal.objective === 'string' ? goal.objective : state.goalObjective,
        goalPhase: goal.phase ?? state.goalPhase,
        goalRoundsStarted: typeof data.roundsStarted === 'number' ? data.roundsStarted : state.goalRoundsStarted,
        goalMaxRounds: typeof goal.maxGoalRounds === 'number' ? goal.goalMaxRounds : state.goalMaxRounds,
        goalCreatedAt: typeof data.createdAt === 'number' ? data.createdAt : state.goalCreatedAt,
        goalUpdatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : time,
        lastRevisionReason: `goal ${data.operation}`,
        lastRevisionDeltaMs: state.lastRevisionAt === null ? 0 : Math.max(0, time - state.lastRevisionAt),
        lastRevisionAt: time,
      };
    }

    case 'user/message': {
      const source = event.data?.source;
      if (source && source.kind === 'goal' && typeof source.round === 'number') {
        return {
          ...state,
          goalRoundsStarted: source.round,
          goalUpdatedAt: time,
          lastRevisionReason: `goal round ${source.round}`,
          lastRevisionDeltaMs: state.lastRevisionAt === null ? 0 : Math.max(0, time - state.lastRevisionAt),
          lastRevisionAt: time,
        };
      }
      return state;
    }

    default:
      return state;
  }
}

export function buildSessionForecast(state, context) {
  const {
    workspaceProfile,
    machineTasks,
    kiloSignals,
    running,
    backgroundActive,
    waitingForUser,
    now,
  } = context;

  const tasks = state.tasks ?? [];
  const hasTodos = tasks.length > 0;
  const hasVisibleGoal = state.goalPhase !== null && state.goalPhase !== 'complete';

  const wsStepSamples = Array.isArray(workspaceProfile?.stepDurationSamplesMs) ? workspaceProfile.stepDurationSamplesMs.filter(Number.isFinite) : [];
  const sessionStepSamples = Array.isArray(state.stepDurationSamplesMs) ? state.stepDurationSamplesMs.filter(Number.isFinite) : [];
  const wsStepMedian = median(wsStepSamples);
  const sessionStepMedian = median(sessionStepSamples);
  const baseStepMs = shrinkBlend(
    wsStepMedian,
    wsStepSamples.length,
    SHIPPED_PRIORS.msPerStep,
    5
  );
  const calibratedStepMs = Math.max(
    1800,
    shrinkBlend(sessionStepMedian, sessionStepSamples.length, baseStepMs, 4)
  );

  const wsCompleted = workspaceProfile?.completedTasks ?? [];
  const wsStepsPerUnitSamples = wsCompleted
    .filter(t => Number.isFinite(t.steps) && t.steps > 0)
    .map(t => t.steps / Math.max(1, SIZE_UNITS[t.sizeTag] ?? 2));
  const machineStepsPerUnitSamples = (machineTasks ?? [])
    .filter(t => Number.isFinite(t.steps) && t.steps > 0)
    .map(t => t.steps / Math.max(1, SIZE_UNITS[t.sizeTag] ?? 2));

  const machineStepsPerUnit = shrinkBlend(
    median(machineStepsPerUnitSamples),
    machineStepsPerUnitSamples.length,
    SHIPPED_PRIORS.stepsPerUnit,
    5
  );
  const wsStepsPerUnit = shrinkBlend(
    median(wsStepsPerUnitSamples),
    wsStepsPerUnitSamples.length,
    machineStepsPerUnit,
    5
  );

  const sessionCompletedTasks = tasks.filter(t => t.status === 'completed' && t.consumedSteps > 0);
  const sessionStepsPerUnitSamples = sessionCompletedTasks.map(
    t => t.consumedSteps / Math.max(1, t.units)
  );
  const stepsPerUnit = Math.max(
    0.5,
    shrinkBlend(median(sessionStepsPerUnitSamples), sessionStepsPerUnitSamples.length, wsStepsPerUnit, 3)
  );

  let bacSteps = 0;
  let evSteps = 0;
  let acSteps = 0;
  let remainingSteps = 0;

  const taskBreakdown = [];
  for (const task of tasks) {
    const analogy = estimateByAnalogy(task, wsCompleted, machineTasks ?? []);
    const tagPlannedSteps = Math.max(0.8, task.units * stepsPerUnit);

    const plannedSteps = analogy
      ? shrinkBlend(analogy.plannedSteps, analogy.matchCount, tagPlannedSteps, 3)
      : tagPlannedSteps;

    const classHistorySteps = [
      ...wsCompleted.filter(t => t.sizeTag === task.sizeTag).map(t => t.steps),
      ...sessionCompletedTasks.filter(t => t.sizeTag === task.sizeTag).map(t => t.consumedSteps),
    ];

    let taskEv = 0;
    let taskRemainingSteps = 0;
    let expectedTotalForTask = plannedSteps;

    if (task.status === 'completed') {
      taskEv = plannedSteps;
      taskRemainingSteps = 0;
      acSteps += Math.max(0.5, task.consumedSteps || plannedSteps);
    } else if (task.status === 'in_progress') {
      expectedTotalForTask = conditionalExpectedSteps(
        task.consumedSteps,
        plannedSteps,
        task.sizeTag,
        classHistorySteps
      );
      taskRemainingSteps = Math.max(0.35, expectedTotalForTask - task.consumedSteps);
      const frac = Math.min(0.88, task.consumedSteps / Math.max(1, expectedTotalForTask));
      taskEv = plannedSteps * Math.max(0.12, frac);
      acSteps += task.consumedSteps;
    } else {
      taskEv = 0;
      taskRemainingSteps = plannedSteps;
    }

    bacSteps += plannedSteps;
    evSteps += taskEv;
    remainingSteps += taskRemainingSteps;

    taskBreakdown.push({
      key: task.key,
      cleanText: task.cleanText,
      sizeTag: task.sizeTag,
      explicitTag: task.explicitTag,
      status: task.status,
      plannedSteps: Number(plannedSteps.toFixed(2)),
      consumedSteps: Number(task.consumedSteps.toFixed(2)),
      expectedTotalSteps: Number(expectedTotalForTask.toFixed(2)),
      remainingSteps: Number(taskRemainingSteps.toFixed(2)),
      reopenedCount: task.reopenedCount,
    });
  }

  const rawCpi = acSteps > 0.8 && evSteps > 0 ? evSteps / acSteps : 1.0;
  const cpi = Math.max(0.35, Math.min(2.2, shrinkBlend(rawCpi, sessionCompletedTasks.length + 1, 1.0, 2)));
  const eacRemainingSteps = remainingSteps / Math.min(1.35, Math.max(0.45, cpi));

  let activeStepExpectedMs = calibratedStepMs;
  if (state.activeToolNames && state.activeToolNames.length > 0) {
    const toolName = state.activeToolNames[state.activeToolNames.length - 1];
    const toolMs = state.toolEwmaMs?.[toolName]
      ?? workspaceProfile?.toolEwmaMs?.[toolName]
      ?? SHIPPED_PRIORS.toolEwmaMs[toolName]
      ?? SHIPPED_PRIORS.toolEwmaMs.default;
    activeStepExpectedMs = Math.max(calibratedStepMs * 0.65, toolMs + 2200);
  }

  const currentStepElapsedMs = (running || backgroundActive) && state.activeStepStartAt !== null
    ? Math.max(0, now - state.activeStepStartAt)
    : 0;

  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length;
  const pendingCount = tasks.length - completedCount - inProgressCount;

  const isAllDone = hasTodos && completedCount === tasks.length && !hasVisibleGoal;

  let baselineRemainingMs = null;
  if (isAllDone) {
    baselineRemainingMs = 0;
  } else if (hasTodos) {
    const firstStepComponent = Math.max(1500, activeStepExpectedMs);
    const subsequentSteps = Math.max(0, eacRemainingSteps - 1);
    baselineRemainingMs = Math.round(firstStepComponent + subsequentSteps * calibratedStepMs);
  }

  let liveRemainingMs = null;
  if (baselineRemainingMs === 0) {
    liveRemainingMs = 0;
  } else if (baselineRemainingMs !== null) {
    if (currentStepElapsedMs < baselineRemainingMs - 1000) {
      liveRemainingMs = baselineRemainingMs - currentStepElapsedMs;
    } else {
      liveRemainingMs = Math.max(2000, Math.round(currentStepElapsedMs * 0.35));
    }
  }

  const completedDurations = sessionCompletedTasks
    .map(t => t.consumedActiveMs)
    .filter(ms => ms > 500);
  const naiveTaskMs = median(completedDurations) ?? (calibratedStepMs * 3);
  const naiveRemainingMs = hasTodos
    ? Math.round((pendingCount + inProgressCount * 0.5) * naiveTaskMs)
    : null;

  const doneEvSteps = taskBreakdown
    .filter(t => t.status === 'completed')
    .reduce((acc, t) => acc + t.plannedSteps, 0);
  const donePercent = hasTodos && bacSteps > 0
    ? Math.min(100, Math.round((doneEvSteps / bacSteps) * 100))
    : 0;

  const stepMicroRatio = (running || backgroundActive)
    ? Math.min(0.85, currentStepElapsedMs / Math.max(3000, activeStepExpectedMs))
    : 0;
  const liveEvSteps = evSteps + (inProgressCount > 0 ? Math.min(0.6, stepMicroRatio * 0.45) : 0);

  const percent = isAllDone
    ? 100
    : hasTodos && bacSteps > 0
      ? Math.min(99, Math.max(donePercent, Math.round((liveEvSteps / bacSteps) * 100)))
      : null;

  const activePercent = percent !== null ? Math.max(0, percent - donePercent) : 0;

  const initialCount = state.initialTaskCount ?? tasks.length;
  const reopenedTotal = tasks.reduce((sum, t) => sum + t.reopenedCount, 0);
  const addedTasks = Math.max(0, tasks.length - initialCount);
  const scopeGrowthRatio = initialCount > 0 ? (addedTasks + reopenedTotal) / initialCount : 0;

  const medianVerifyPerTask = Math.max(
    3,
    median(state.verifyCountsPerCompletedTask) ?? 4
  );
  const verifyRatio = state.verifyCallsSinceLastEdit / medianVerifyPerTask;

  const totalExpectedSteps = evSteps + eacRemainingSteps;
  const spi = totalExpectedSteps > 0 && bacSteps > 0
    ? Number((bacSteps / totalExpectedSteps).toFixed(2))
    : 1.0;

  const recentKiloBlocks = kiloSignals?.recentBlocks ?? 0;
  const recentKiloReasons = kiloSignals?.recentReasons ?? [];

  let stoplight = 'green';
  let stoplightReason = 'On pace';

  if (state.goalPhase === 'blocked' || recentKiloBlocks >= 2 || spi < 0.6) {
    stoplight = 'red';
    if (state.goalPhase === 'blocked') {
      stoplightReason = 'Goal blocked';
    } else if (recentKiloBlocks >= 2) {
      stoplightReason = recentKiloReasons[0]
        ? `Guard block: ${recentKiloReasons[0].slice(0, 60)}`
        : `${recentKiloBlocks} harness blocks in current task`;
    } else {
      stoplightReason = `SPI ${spi.toFixed(2)} (significant overrun)`;
    }
  } else if (
    spi < 0.85
    || scopeGrowthRatio > 0.4
    || verifyRatio > 2.0
    || recentKiloBlocks === 1
  ) {
    stoplight = 'amber';
    if (recentKiloBlocks === 1) {
      stoplightReason = recentKiloReasons[0]
        ? `Guard notice: ${recentKiloReasons[0].slice(0, 60)}`
        : '1 harness block recorded';
    } else if (scopeGrowthRatio > 0.4) {
      stoplightReason = `Scope grew ${initialCount} → ${tasks.length} tasks`;
    } else if (verifyRatio > 2.0) {
      stoplightReason = `${state.verifyCallsSinceLastEdit} verification calls since last edit`;
    } else {
      stoplightReason = `SPI ${spi.toFixed(2)} (pace slipping)`;
    }
  }

  const errorRecords = workspaceProfile?.forecastErrorsMs ?? [];
  const modelMaeMs = errorRecords.length > 0
    ? Math.round(errorRecords.reduce((s, r) => s + Math.abs(r.predictedMs - r.actualMs), 0) / errorRecords.length)
    : null;
  const naiveMaeMs = errorRecords.length > 0
    ? Math.round(errorRecords.reduce((s, r) => s + Math.abs(r.naivePredictedMs - r.actualMs), 0) / errorRecords.length)
    : null;

  const executionState = isAllDone
    ? 'complete'
    : running
      ? 'working'
      : backgroundActive
        ? 'background'
        : waitingForUser
          ? 'waiting-user'
          : 'idle';

  return {
    schema: 'dsh.task-progress/v2',
    hasTodos,
    hasVisibleGoal,
    executionState,
    stoplight,
    stoplightReason,
    percent,
    donePercent,
    activePercent,
    evSteps: Number(evSteps.toFixed(2)),
    bacSteps: Number(bacSteps.toFixed(2)),
    cpi: Number(cpi.toFixed(2)),
    spi,
    baselineRemainingMs,
    liveRemainingMs,
    naiveRemainingMs,
    activeStepStartAt: state.activeStepStartAt,
    activeStepExpectedMs: Math.round(activeStepExpectedMs),
    calibratedStepMs: Math.round(calibratedStepMs),
    stepsPerUnit: Number(stepsPerUnit.toFixed(2)),
    totalSteps: state.totalSteps,
    totalActiveMs: Math.round(state.totalActiveMs + currentStepElapsedMs),
    completedCount,
    inProgressCount,
    pendingCount,
    totalCount: tasks.length,
    initialTaskCount: initialCount,
    addedTasks,
    reopenedTotal,
    scopeGrowthRatio: Number(scopeGrowthRatio.toFixed(2)),
    verifyCallsSinceLastEdit: state.verifyCallsSinceLastEdit,
    medianVerifyPerTask: Number(medianVerifyPerTask.toFixed(1)),
    guardActive: Boolean(kiloSignals?.active),
    guardEditRevision: kiloSignals?.editRevision ?? null,
    guardRecentBlocks: recentKiloBlocks,
    modelMaeMs,
    naiveMaeMs,
    forecastSampleCount: errorRecords.length,
    lastRevisionReason: state.lastRevisionReason,
    lastRevisionDeltaMs: state.lastRevisionDeltaMs,
    lastRevisionAt: state.lastRevisionAt,
    tasks: taskBreakdown,
  };
}
