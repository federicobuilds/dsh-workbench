import { createHash } from 'node:crypto';
import { canonicalPresetId } from './legacy.mjs';

export const MODEL_ROUTES = Object.freeze({
  coordinatorModel: { seat: 'orchestrator-custom', presets: ['dsh-coordinator-off', 'dsh-coordinator-free', 'dsh-coordinator-simple', 'dsh-coordinator-advanced'] },
  coderModel: { seat: 'coder-custom', presets: ['dsh-coder'] },
  researcherModel: { seat: 'deep-researcher', presets: ['dsh-researcher'] },
  reviewerModel: { seat: 'reviewer', presets: ['dsh-reviewer'], primary: true },
  auditorModel: { seat: 'auditor', presets: ['dsh-auditor'], primary: true },
  teacherModel: { seat: 'teacher-mode', presets: ['dsh-teacher'] },
  advisorModel: { seat: 'career-advisor', presets: ['dsh-advisor'] },
  videoEditorModel: { seat: 'video-editor', presets: ['dsh-video-editor'] },
  executorCheapModel: { seat: 'executor-cheap' },
  executorDefaultModel: { seat: 'executor' },
  executorMaxModel: { seat: 'executor-max' },
  criticModel: { seat: 'critic' },
  criticMaxModel: { seat: 'critic-max' },
  reviewerWorkerModel: { seat: 'reviewer' },
  reviewerMaxModel: { seat: 'reviewer-max' },
  auditorWorkerModel: { seat: 'auditor' },
  auditorMaxModel: { seat: 'auditor-max' },
  simpleExecutorCheapModel: { seat: 'executor-s-cheap' },
  simpleExecutorDefaultModel: { seat: 'executor-s' },
  simpleExecutorMaxModel: { seat: 'executor-s-max' },
  freeExecutorCheapModel: { seat: 'executor-f-cheap' },
  freeExecutorDefaultModel: { seat: 'executor-f' },
  freeExecutorStrongModel: { seat: 'executor-f-strong' },
});

export function defaultModelRoutes(roster) {
  const defaults = {};
  for (const [field, spec] of Object.entries(MODEL_ROUTES)) {
    const row = roster.agents.find(agent => agent.seat === spec.seat);
    if (!row) throw new Error(`Missing role ${spec.seat}`);
    defaults[field] = spec.primary ? (row.primary_target ?? row.configured_target) : row.configured_target;
  }
  defaults.executorDefaultEffort = roster.agents.find(agent => agent.seat === 'executor').configured_effort ?? '';
  return defaults;
}

export function applyModelOverrides(roster, assignments, config = {}) {
  const nextRoster = structuredClone(roster);
  const nextAssignments = structuredClone(assignments);
  for (const [field, spec] of Object.entries(MODEL_ROUTES)) {
    if (config[field] === undefined) continue;
    const target = config[field];
    if (typeof target !== 'string' || target !== target.trim() || !/^[^/\s]+\/[^\s]+$/.test(target)) throw new Error(`Invalid model route ${field}`);
    const provider = target.slice(0, target.indexOf('/'));
    if (!Object.hasOwn(nextRoster.providers, provider)) throw new Error(`Unknown model provider for ${field}`);
    const row = nextRoster.agents.find(agent => agent.seat === spec.seat);
    if (!row) throw new Error(`Missing role ${spec.seat}`);
    const key = 'dsh-agent-' + spec.seat;
    const existing = nextAssignments[key];
    if (spec.primary) row.primary_target = target;
    else {
      row.configured_target = target;
      if (existing) existing.target = target;
    }
    for (const id of spec.presets ?? []) nextAssignments[id] = { sourceRole: spec.seat, target, variant: existing?.variant ?? null };
  }
  if (config.executorDefaultEffort !== undefined) {
    const effort = config.executorDefaultEffort;
    if (typeof effort !== 'string' || effort !== effort.trim()) throw new Error('Invalid executor effort');
    const row = nextRoster.agents.find(agent => agent.seat === 'executor');
    if (!row) throw new Error('Missing role executor');
    row.configured_effort = effort || null;
    if (nextAssignments['dsh-agent-executor']) nextAssignments['dsh-agent-executor'].variant = effort || null;
  }
  return { roster: nextRoster, assignments: nextAssignments };
}

export function configuredAssignment(presetId, assignments, config) {
  presetId = canonicalPresetId(presetId);
  for (const [field, spec] of Object.entries(MODEL_ROUTES)) {
    if (spec.presets?.includes(presetId) && config?.[field] !== undefined) {
      const original = assignments['dsh-agent-' + spec.seat];
      return { target: config[field], variant: original?.variant ?? null };
    }
  }
  return assignments[presetId];
}

export function modelRevision(seats) {
  return 'settings-' + createHash('sha256').update(JSON.stringify(seats)).digest('hex').slice(0, 24);
}
