import fs from 'node:fs';
import { Service } from '@deepseek-ai/cordis';
import { EntryGroup } from '@deepseek-ai/cordis-plugin-loader';
import Schema from '@deepseek-ai/schemastery';
import { applyModelOverrides, defaultModelRoutes, modelRevision, MODEL_ROUTES } from '../dsh-governance/model-overrides.mjs';
import { publishRoleModelOverrides, resolveRouteSelection } from '../dsh-governance/bindings.mjs';
import { buildRosterConfigDTO } from '../dsh-governance/config-dto.mjs';
import { normalizeConfig } from '../dsh-governance/policy.mjs';
import { legacyPresetId } from '../dsh-governance/legacy.mjs';

const rosterPath = new URL('../dsh-governance/role-roster.example.json', import.meta.url);
const assignmentsPath = new URL('../dsh-governance/assignments.json', import.meta.url);
const dataPath = new URL('./presets-data.json', import.meta.url);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const defaults = fs.existsSync(rosterPath) ? defaultModelRoutes(readJson(rosterPath)) : {};
const labels = {
  coordinatorModel: 'Coordinator model', coderModel: 'Coder model', researcherModel: 'Deep Researcher model',
  reviewerModel: 'Reviewer model', auditorModel: 'Auditor model', teacherModel: 'Teacher model',
  advisorModel: 'Advisor model', videoEditorModel: 'Video Editor model',
  executorCheapModel: 'Executor cheap model', executorDefaultModel: 'Executor default model',
  executorMaxModel: 'Executor max model', criticModel: 'Critic model', criticMaxModel: 'Critic max model',
  reviewerWorkerModel: 'Worker reviewer model', reviewerMaxModel: 'Reviewer max model',
  auditorWorkerModel: 'Worker auditor model', auditorMaxModel: 'Auditor max model',
  simpleExecutorCheapModel: 'Simple executor cheap model', simpleExecutorDefaultModel: 'Simple executor default model',
  simpleExecutorMaxModel: 'Simple executor max model', freeExecutorCheapModel: 'Free executor cheap model',
  freeExecutorDefaultModel: 'Free executor default model', freeExecutorStrongModel: 'Free executor strong model',
};
const fields = Object.fromEntries(Object.keys(MODEL_ROUTES).map(key => {
  const field = Schema.string();
  if (defaults[key] !== undefined) field.default(defaults[key]);
  return [key, field.description(labels[key])];
}));
fields.executorDefaultEffort = Schema.string();
if (defaults.executorDefaultEffort !== undefined) fields.executorDefaultEffort.default(defaults.executorDefaultEffort);
fields.executorDefaultEffort.description('Executor default reasoning effort');

export default class RolePresetsPlugin {
  static inject = ['agentPresets', 'llm'];
  static [EntryGroup.key] = true;
  static Config = Schema.object(fields);

  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
  }

  async *[Service.init]() {
    if (!fs.existsSync(rosterPath)) throw new Error('Role presets configuration error: private role roster is unavailable');
    const originalRoster = readJson(rosterPath);
    const originalAssignments = readJson(assignmentsPath);
    this.config = Object.freeze({ ...defaultModelRoutes(originalRoster), ...this.config });
    const updated = applyModelOverrides(originalRoster, originalAssignments, this.config);
    const dto = buildRosterConfigDTO(updated.roster);
    normalizeConfig(dto);
    const llm = this.ctx.get?.('llm') ?? this.ctx.llm;
    if (typeof llm?.resolveModelInfo !== 'function') throw new Error('Role presets configuration error: model metadata service unavailable');
    const routes = [];
    for (const [field, spec] of Object.entries(MODEL_ROUTES)) {
      const row = updated.roster.agents.find(agent => agent.seat === spec.seat);
      routes.push({ target: this.config[field], variant: spec.primary ? (originalAssignments['dsh-agent-' + spec.seat]?.variant ?? null) : row.configured_effort });
      for (const id of spec.presets ?? []) routes.push(updated.assignments[id]);
    }
    for (const route of routes) await resolveRouteSelection(route, (provider, model) => llm.resolveModelInfo(provider, model));
    for (const preset of readJson(dataPath)) {
      yield await this.ctx.agentPresets.register(preset);
      yield await this.ctx.agentPresets.register({ ...preset, id: legacyPresetId(preset.id) });
    }
    yield publishRoleModelOverrides(this.ctx, this.config, updated.assignments, modelRevision({ seats: dto.seats, config: this.config }));
    if (this.config.defaultCoordinatorOnStandard) {
      yield this.ctx.on('agent-preset/selected', (sessionId, presetId) => {
        if (presetId !== 'standard') return;
        const agent = this.ctx.get?.('agents')?.get?.(sessionId);
        if (agent && agent.session?.header?.origin !== 'subagent' && (agent.session?.seq ?? 0) < 10) this.ctx.agentPresets.select(sessionId, 'dsh-coordinator-simple');
      });
    }
  }
}
