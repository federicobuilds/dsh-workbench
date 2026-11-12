#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { packagesForPlatform } from './packages.mjs';
import { packPackages } from './pack.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdkRoot = process.env.DSH_SDK_ROOT;
if (!sdkRoot) throw new Error('DSH_SDK_ROOT is required and must identify the DSH 0.2.2-rc.1 SDK root');
const script = fileURLToPath(import.meta.url);
const asarMarker = `${join('', 'app.asar')}${process.platform === 'win32' ? '\\' : '/'}`;
if (!process.versions.electron && sdkRoot.includes(asarMarker)) {
  const resources = sdkRoot.slice(0, sdkRoot.indexOf(asarMarker) + asarMarker.length - 1);
  const electron = join(dirname(dirname(resources)), 'MacOS', 'DeepSeek Harness');
  const result = spawnSync(electron, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const root = dirname(dirname(script));
const installer = join(root, 'scripts', 'install-profile.mjs');
const names = packagesForPlatform(process.platform).map(pkg => pkg.dir);
const temporary = mkdtempSync(join(tmpdir(), 'dsh-workbench-smoke-'));
const profile = join(temporary, 'profile');

function copyDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from));
    else throw new Error(`Unsupported SDK entry: ${from}`);
  }
}

try {
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({ name: 'dsh-workbench-smoke-profile', private: true, version: '0.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`);
  const archiveDirectory = join(temporary, 'archives');
  packPackages(archiveDirectory);
  const install = () => execFileSync(process.execPath, [installer, profile, archiveDirectory], {
    env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  install();
  const firstManifest = readFileSync(join(profile, 'package.json'), 'utf8');
  const firstPatch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  install();
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), firstManifest, 'installer manifest is idempotent');
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), firstPatch, 'installer patch is idempotent');

  const archiveManifest = join(archiveDirectory, 'archives.json');
  const archiveManifestText = readFileSync(archiveManifest, 'utf8');
  const damaged = JSON.parse(archiveManifestText);
  damaged[names.at(-1)].sha256 = '0'.repeat(64);
  try {
    writeFileSync(archiveManifest, JSON.stringify(damaged));
    assert.throws(install, /Archive hash mismatch/);
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), firstManifest);
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), firstPatch);
  } finally {
    writeFileSync(archiveManifest, archiveManifestText);
  }

  const manifest = JSON.parse(firstManifest);
  assert.deepEqual(manifest.dsh.profile.bundles, names.map(name => `@dsh-workbench/${name}`).sort());
  const installed = join(profile, 'node_modules', '@dsh-workbench');
  assert.deepEqual(readdirSync(installed).sort(), [...names].sort());
  for (const name of names) {
    const id = `@dsh-workbench/${name}`;
    assert.equal(manifest.dependencies[id], `file:./dsh-packages/${name}`);
    for (const base of [join(profile, 'dsh-packages'), installed]) {
      const metadata = JSON.parse(readFileSync(join(base, name, 'package.json'), 'utf8'));
      assert.equal(metadata.name, id);
      assert.equal(metadata.engines.dsh, '0.2.2-rc.1');
      assert.equal(typeof metadata.description, 'string');
      assert(metadata.description.length > 0);
    }
  }
  const patch = JSON.parse(firstPatch);
  assert.equal(patch[0].insert.length, 2);
  const governancePatch = patch[0].insert.find(entry => entry.id === 'dsh-governance').config;
  const judgePatch = patch[0].insert.find(entry => entry.id === 'dsh-judge').config;
  assert.equal(governancePatch.approveExternalJudge, false);
  for (const key of ['disableBundledMcpGate', 'disableBundledSearchGuard', 'disableBundledCredentialRouter', 'disableBundledVerificationLedger', 'disableBundledMemoryViewer']) assert.equal(governancePatch[key], true);
  assert.deepEqual(judgePatch, { disableBundledRouter: true, allowLocalInference: true, allowExternalInference: false });
  assert.equal(readFileSync(join(profile, '.dsh-workbench-backup', 'package.json'), 'utf8').includes('dsh-workbench-smoke-profile'), true);

  const sdkModules = join(sdkRoot, 'node_modules');
  assert(existsSync(join(sdkModules, '@deepseek-ai')), `SDK modules not found under ${sdkModules}`);
  for (const name of ['@deepseek-ai', 'zod']) {
    const source = join(sdkModules, name);
    const target = join(profile, 'node_modules', name);
    if (sdkRoot.includes(asarMarker)) copyDirectory(source, target);
    else symlinkSync(source, target, 'junction');
  }

  const modules = new Map();
  for (const name of names) {
    const installedRoot = join(installed, name);
    const metadata = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
    const entry = typeof metadata.exports?.['.'] === 'string' ? metadata.exports['.'] : metadata.main;
    assert(entry, `${name} has a bundle entry`);
    const module = await import(pathToFileURL(join(installedRoot, entry)).href);
    assert.equal(typeof (module.apply ?? module.default), 'function', `${name} exports a plugin`);
    modules.set(name, module);
  }

  const require = createRequire(join(profile, 'package.json'));
  const { Context } = require('@deepseek-ai/cordis');
  const ctx = new Context();
  const registrations = [];
  const tools = {
    register(definition) {
      assert.equal(typeof definition?.name, 'string');
      registrations.push(definition);
      let active = true;
      return () => { if (active) { active = false; registrations.splice(registrations.indexOf(definition), 1); } };
    },
    guard() { return () => {}; },
  };
  ctx.provide('tools', tools);
  ctx.provide('typert', { register() { return () => {}; } });
  ctx.provide('agents', {});
  ctx.provide('agentPresets', {});
  ctx.provide('llm', {});

  const cleanups = [];
  const apply = async (name, config) => {
    const cleanup = await modules.get(name).apply(ctx, config);
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  };
  await apply('dsh-governance', governancePatch);
  await apply('dsh-verification-ledger', {});
  await apply('dsh-storage-guard', {});
  await apply('dsh-memory-viewer', {});
  await apply('dsh-mcp-gate', {});
  await apply('dsh-judge', judgePatch);
  await apply('dsh-workspace-index', { indexRoot: join(profile, 'workspace-index'), autoBuild: false, autoWatch: false, watch: false });
  await apply('dsh-skill-mcp-router');

  const counts = registrations.reduce((map, definition) => map.set(definition.name, (map.get(definition.name) ?? 0) + 1), new Map());
  assert.equal(counts.get('check'), 1, 'exactly one check tool');
  assert.equal(counts.get('resource'), 1, 'exactly one resource tool');
  assert.equal(counts.get('memory_preview'), 1, 'exactly one memory_preview tool');
  const requiredTools = ['dsh_governance_events', 'dsh_decision', 'dsh_dispatch', 'dsh_review', 'dsh_resume', 'dsh_index_workspace', 'dsh_search_workspace', 'dsh_index_status'];
  for (const name of requiredTools) assert.equal(counts.get(name), 1, `${name} registered once`);
  for (const name of ['dshJudge', 'dshWorkspaceIndex', 'routerRecommendation']) assert(ctx.get(name), `${name} service present`);

  for (const cleanup of cleanups.reverse()) await cleanup();
  if (typeof ctx.dispose === 'function') await ctx.dispose();
  console.log(`PASS: ${names.length} packed plugin archives installed with matching manifests`);
  console.log('PASS: repeat install preserves the backup and an invalid archive leaves the profile intact');
  console.log('PASS: one check, one resource, one memory_preview, eight required DSH tools, three DSH services');
  console.log(`PASS: dynamically imported all ${names.length} installed bundles with SDK resolution and no model calls`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
