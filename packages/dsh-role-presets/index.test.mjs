import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { roleModelOverrides, selectionFor } from '../dsh-governance/bindings.mjs';

const modules = {
  '@deepseek-ai/cordis': 'export const Service = { init: Symbol.for("preset-test-init") };',
  '@deepseek-ai/cordis-plugin-loader': 'export const EntryGroup = { key: Symbol.for("preset-test-group") };',
  '@deepseek-ai/schemastery': 'const field = () => ({ default(value) { this.value = value; return this; }, description(value) { this.label = value; return this; } }); export default { string: field, object: fields => ({ fields }) };',
};
registerHooks({ resolve(specifier, context, next) {
  if (Object.hasOwn(modules, specifier)) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
  return next(specifier, context);
} });
const roster = new URL('../dsh-governance/role-roster.example.json', import.meta.url);
const assignments = new URL('../dsh-governance/assignments.json', import.meta.url);
const syntheticRoster = new URL('../dsh-governance/test-fixtures/role-roster.synthetic.json', import.meta.url);
const syntheticAssignments = new URL('../dsh-governance/test-fixtures/assignments.synthetic.json', import.meta.url);
const realRead = fs.readFileSync;
const realExists = fs.existsSync;
let missingRoster = false;
fs.readFileSync = (path, ...args) => realRead(path instanceof URL && path.href === roster.href ? syntheticRoster : path instanceof URL && path.href === assignments.href ? syntheticAssignments : path, ...args);
fs.existsSync = path => path instanceof URL && path.href === roster.href ? !missingRoster : realExists(path);
after(() => { fs.readFileSync = realRead; fs.existsSync = realExists; });
const hashes = () => [roster, assignments].map(path => createHash('sha256').update(realRead(path)).digest('hex'));
const before = hashes();
const { default: Plugin } = await import('./index.mjs');
const init = Symbol.for('preset-test-init');
const metadata = async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'xhigh' }] } });
function profile(resolveModelInfo = metadata) {
  const registered = [];
  const agentPresets = { async register(preset) { registered.push(preset); return () => {}; }, async resolve(id) { return registered.find(preset => preset.id === id); } };
  const llm = { resolveModelInfo };
  const ctx = { agentPresets, llm, get: name => ({ agentPresets, llm })[name] };
  return { ctx, registered };
}
async function initialize(ctx, config) {
  const disposers = [];
  for await (const dispose of new Plugin(ctx, config)[init]()) disposers.push(dispose);
  return disposers;
}

test('every canonical preset has a resolvable legacy alias with identical content', async () => {
  const current = profile();
  const disposers = await initialize(current.ctx);
  const presets = JSON.parse(realRead(new URL('./presets-data.json', import.meta.url), 'utf8'));
  assert.equal(presets.length, 19);
  for (const preset of presets) {
    const canonical = await current.ctx.agentPresets.resolve(preset.id);
    const legacyId = `kilo-${preset.id.slice(4)}`;
    const alias = await current.ctx.agentPresets.resolve(legacyId);
    assert.deepEqual(canonical, preset);
    assert.deepEqual(alias, { ...preset, id: legacyId });
  }
  assert.equal(disposers.length, 39);
  disposers.at(-1)();
});

test('validated settings are profile-owned, disposable, and never write source data', async () => {
  const a = profile(), b = profile();
  const first = await initialize(a.ctx, { coderModel: 'openrouter/first' });
  assert.equal(a.registered.length, 38);
  assert.equal(first.length, 39);
  assert.equal(roleModelOverrides(a.ctx).assignments['dsh-coder'].target, 'openrouter/first');
  assert.equal(roleModelOverrides(b.ctx), undefined);
  assert.deepEqual(hashes(), before);
  const second = await initialize(a.ctx, { coderModel: 'openrouter/second' });
  const isolated = await initialize(b.ctx, { coderModel: 'openrouter/other' });
  const secondState = roleModelOverrides(a.ctx);
  first.at(-1)();
  assert.equal(roleModelOverrides(a.ctx), secondState);
  assert.equal(roleModelOverrides(b.ctx).assignments['dsh-coder'].target, 'openrouter/other');
  second.at(-1)();
  assert.equal(roleModelOverrides(a.ctx), undefined);
  assert.ok(roleModelOverrides(b.ctx));
  isolated.at(-1)();
  assert.deepEqual(hashes(), before);
  const reloaded = await initialize(a.ctx, { coderModel: 'openrouter/reloaded' });
  assert.equal(roleModelOverrides(a.ctx).assignments['dsh-coder'].target, 'openrouter/reloaded');
  reloaded.at(-1)();
  assert.deepEqual(hashes(), before);
});

test('startup resolves configured OpenRouter catalog aliases', async () => {
  const aliases = new Map([
    ['moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3'],
    ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash'],
    ['openai/gpt-6.1-terra', 'openai/gpt-6.1-sol'],
  ]);
  const lookedUp = [];
  const current = profile(async (provider, model) => {
    lookedUp.push(model);
    if (provider === 'openrouter' && aliases.has(model)) {
      throw Object.assign(new Error('has no configured model'), { code: 'UNKNOWN_MODEL' });
    }
    return metadata();
  });
  const disposers = await initialize(current.ctx, {
    coderModel: 'openrouter/moonshotai/kimi-k3.1-pro',
    researcherModel: 'openrouter/deepseek/deepseek-v4.1-flash-1017',
  });
  for (const alias of aliases.values()) assert.ok(lookedUp.includes(alias));
  disposers.at(-1)();
});

test('only degen without effort metadata omits the requested effort', async () => {
  const assignment = { target: 'degen/local-model', variant: 'high' };
  assert.deepEqual(await selectionFor(assignment, async () => ({})), { provider: 'degen', model: 'local-model' });
  await assert.rejects(selectionFor(assignment, async () => ({ reasoning: { efforts: [] } })), /no verified native effort/);
  await assert.rejects(selectionFor({ ...assignment, target: 'openrouter/model' }, async () => ({})), /no verified native effort/);
});

test('invalid routes, missing metadata, resolver errors and unsupported efforts refuse before registration or publication', async () => {
  for (const [config, resolver, error] of [
    [{ coderModel: 'unknown/model' }, metadata, /Unknown model provider/],
    [{ coderModel: 'openrouter//bad' }, metadata, /Invalid assigned model identifier/],
    [{}, async () => null, /no native metadata/],
    [{}, async () => { throw new Error('metadata failure'); }, /metadata failure/],
    [{ executorDefaultEffort: 'unsupported' }, metadata, /no verified native effort/],
  ]) {
    const current = profile(resolver);
    await assert.rejects(initialize(current.ctx, config), error);
    assert.equal(current.registered.length, 0);
    assert.equal(roleModelOverrides(current.ctx), undefined);
    assert.deepEqual(hashes(), before);
  }
  const current = profile();
  const existing = await initialize(current.ctx, { coderModel: 'openrouter/valid' });
  const published = roleModelOverrides(current.ctx);
  current.ctx.llm.resolveModelInfo = async () => null;
  const count = current.registered.length;
  await assert.rejects(initialize(current.ctx, { coderModel: 'openrouter/invalid' }), /no native metadata/);
  assert.equal(current.registered.length, count);
  assert.equal(roleModelOverrides(current.ctx), published);
  existing.at(-1)();
  assert.deepEqual(hashes(), before);
});

test('missing private roster permits import but refuses initialization', async () => {
  missingRoster = true;
  try {
    const { default: MissingPlugin } = await import('./index.mjs?missing-roster');
    const current = profile();
    const run = async () => { for await (const _ of new MissingPlugin(current.ctx)[init]()) {} };
    await assert.rejects(run(), /configuration error: private role roster is unavailable/);
    assert.equal(current.registered.length, 0);
    assert.equal(roleModelOverrides(current.ctx), undefined);
    assert.deepEqual(hashes(), before);
  } finally { missingRoster = false; }
});
