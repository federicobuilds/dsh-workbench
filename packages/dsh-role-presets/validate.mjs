import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';

const mode = process.argv[2] ?? '--check';
assert(['--check', '--write'].includes(mode), 'Expected --check or --write');
const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const presets = await readJson('./presets-data.json');
const patternsPath = '../dsh-governance/worker-patterns.json';
const registry = await readJson(patternsPath);
assert.equal(new Set(presets.map(preset => preset.id)).size, presets.length);
assert.ok(presets.every(preset => preset.id.startsWith('dsh-') && Array.isArray(preset.plugins)));
for (const pattern of registry.patterns) {
  const preset = presets.find(item => item.id === pattern.plannedPresetId);
  assert.ok(preset, `Missing worker preset ${pattern.plannedPresetId}`);
  if (mode === '--write') pattern.plugins = preset.plugins;
  else assert.deepEqual(pattern.plugins, preset.plugins, `Worker pattern drift in ${preset.id}`);
}
if (mode === '--write') {
  const temporary = new URL(`${patternsPath}.tmp-${process.pid}`, import.meta.url);
  await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, new URL(patternsPath, import.meta.url));
}
console.log(`Validated ${presets.length} presets and ${registry.patterns.length} worker patterns`);
