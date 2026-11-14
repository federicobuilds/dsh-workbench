#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { packagesForPlatform } from './packages.mjs';
import { archiveHash, packPackages, readArchives } from './pack.mjs';

const args = process.argv.slice(2);
const selection = args.find(argument => argument.startsWith('--only='))?.slice(7).split(',');
const [profileArgument, archiveArgument, ...extra] = args.filter(argument => !argument.startsWith('--only='));
if (!profileArgument || extra.length || !isAbsolute(profileArgument) || (archiveArgument && !isAbsolute(archiveArgument))) {
  console.error('Usage: node scripts/install-profile.mjs /absolute/path/to/dsh-profile [/absolute/path/to/archives] [--only=package,package]');
  process.exit(2);
}

const profile = resolve(profileArgument);
const manifestPath = join(profile, 'package.json');
if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
  throw new Error(`Target is not a DSH profile with package.json: ${profile}`);
}
const available = packagesForPlatform(process.platform);
const selected = selection ? available.filter(({ dir }) => selection.includes(dir)) : available;
if (selection && (selected.length === 0 || selected.length !== new Set(selection).size)) {
  throw new Error('One or more selected packages are unknown or unsupported on this platform.');
}
const lock = join(profile, '.dsh-workbench-install.lock');
mkdirSync(lock);
let staging;
let preserveStaging = false;
try {
  staging = mkdtempSync(join(profile, '.dsh-workbench-install-'));
  const archiveDirectory = archiveArgument ?? join(staging, 'archives');
  const archives = archiveArgument ? readArchives(archiveDirectory) : packPackages(archiveDirectory);
  const patchPath = join(profile, 'cordis.patch.yml');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const hadPatch = existsSync(patchPath);
  manifest.dependencies ??= {};
  assert(manifest.dependencies && !Array.isArray(manifest.dependencies) && typeof manifest.dependencies === 'object');
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles ??= [];
  assert(Array.isArray(manifest.dsh.profile.bundles), 'Expected dsh.profile.bundles to be an array');

  function ensureDirectory(path) {
    if (!existsSync(path)) mkdirSync(path);
    const stat = lstatSync(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), `Expected a real directory at ${path}`);
  }
  const packagesDir = join(profile, 'dsh-packages');
  const modules = join(profile, 'node_modules');
  const scope = join(modules, '@dsh-workbench');
  const backup = join(profile, selection ? '.dsh-workbench-backup-' + basename(staging).split('-').at(-1) : '.dsh-workbench-backup');
  for (const path of [packagesDir, modules, scope, backup]) ensureDirectory(path);
  for (const path of [manifestPath, ...(hadPatch ? [patchPath] : [])]) {
    assert(lstatSync(path).isFile(), `Expected a regular profile file at ${path}`);
    const destination = join(backup, basename(path));
    if (!existsSync(destination)) cpSync(path, destination);
  }

  const operations = [];
  for (const { dir, metadata } of selected) {
    const entry = archives[dir];
    if (!entry || typeof entry.file !== 'string' || basename(entry.file) !== entry.file) {
      throw new Error(`Invalid archive entry for ${dir}`);
    }
    const archive = join(archiveDirectory, entry.file);
    assert.equal(archiveHash(archive), entry.sha256, `Archive hash mismatch for ${dir}`);
    const unpacked = join(staging, dir);
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', unpacked]);
    const installed = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'));
    assert.equal(installed.name, metadata.name);
    assert.equal(installed.version, metadata.version);
    const installedCopy = join(staging, `${dir}-installed`);
    cpSync(unpacked, installedCopy, { recursive: true });
    const destinations = [join(packagesDir, dir), join(scope, dir)];
    for (const [index, destination] of destinations.entries()) {
      if (selection && existsSync(destination)) {
        cpSync(destination, join(backup, (index === 0 ? 'source-' : 'installed-') + dir), { recursive: true, verbatimSymlinks: true });
      }
    }
    operations.push([unpacked, destinations[0]], [installedCopy, destinations[1]]);
    manifest.dependencies[metadata.name] = `file:./dsh-packages/${dir}`;
    if (!manifest.dsh.profile.bundles.includes(metadata.name)) manifest.dsh.profile.bundles.push(metadata.name);
  }
  const nextManifest = join(staging, 'next-manifest.json');
  manifest.dsh.profile.bundles.sort();
  writeFileSync(nextManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: lstatSync(manifestPath).mode & 0o777 });
  operations.push([nextManifest, manifestPath]);

  if (!hadPatch) {
    const nextPatch = join(staging, 'next-patch.yml');
    const patch = [{ insert: [
      { id: 'dsh-governance', name: '@dsh-workbench/dsh-governance', config: {
        approveExternalJudge: false,
        disableBundledMcpGate: true,
        disableBundledSearchGuard: true,
        disableBundledCredentialRouter: true,
        disableBundledVerificationLedger: true,
        disableBundledMemoryViewer: true,
      } },
      { id: 'dsh-judge', name: '@dsh-workbench/dsh-judge', config: {
        disableBundledRouter: true, allowLocalInference: true, allowExternalInference: false,
      } },
    ] }];
    writeFileSync(nextPatch, `${JSON.stringify(patch, null, 2)}\n`);
    operations.push([nextPatch, patchPath]);
  }

  const committed = [];
  try {
    for (const [source, destination] of operations) {
      const previous = existsSync(destination) ? join(staging, `previous-${committed.length}`) : null;
      if (previous) renameSync(destination, previous);
      committed.push({ destination, previous, replaced: false });
      renameSync(source, destination);
      committed.at(-1).replaced = true;
    }
  } catch (error) {
    try {
      for (const { destination, previous, replaced } of committed.reverse()) {
        if (replaced) rmSync(destination, { recursive: true, force: true });
        if (previous) renameSync(previous, destination);
      }
    } catch (rollbackError) {
      preserveStaging = true;
      throw new AggregateError([error, rollbackError], `Rollback incomplete. Recovery files are in ${staging}`);
    }
    throw error;
  }
  if (hadPatch) console.log('Existing cordis.patch.yml preserved. Review the Governance and Judge settings in the README.');
  console.log(`Installed ${selected.length} DSH Workbench packages into ${profile}`);
  console.log(`Original profile backup: ${backup}`);
} finally {
  if (staging && !preserveStaging) rmSync(staging, { recursive: true, force: true });
  rmSync(lock, { recursive: true, force: true });
}
