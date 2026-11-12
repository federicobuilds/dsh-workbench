import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { apply } from './index.mjs';

test('guard blocks unscoped roots and retains async scoped searches', async () => {
  let guard, pre, disposed = 0;
  const tools = { guard(fn) { guard = fn; return () => { disposed++; }; } };
  const ctx = { get(name) { return name === 'tools' ? tools : undefined; }, on(event, fn) { assert.equal(event, 'tools/pre-execute'); pre = fn; return () => { disposed++; }; } };
  const dispose = apply(ctx);
  assert.match(guard({ name: 'grep', arguments: { path: '/' } }), /scoped/);
  assert.match(guard({ name: 'glob', arguments: { path: '~' } }), /scoped/);
  const project = fileURLToPath(new URL('.', import.meta.url));
  assert.equal(guard({ name: 'grep', arguments: { path: project } }), undefined);
  assert.equal((await pre({ name: 'grep', arguments: { path: '/' } }, () => null)).kind, 'deny');
  assert.equal(await pre({ name: 'grep', arguments: { path: project } }, () => 'allowed'), 'allowed');
  dispose();
  assert.equal(disposed, 2);
});

test('real symlinks distinguish project directories from broad roots', async t => {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'dsh-search-guard-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await fs.realpath(temporary);
  const home = join(fixture, 'home');
  const library = join(home, 'Library');
  const icloud = join(library, 'Mobile Documents');
  const cloudDocs = join(icloud, 'com~apple~CloudDocs');
  const cloudProject = join(icloud, 'project');
  const cloudStorage = join(library, 'CloudStorage');
  const project = join(home, 'project');
  await fs.mkdir(cloudProject, { recursive: true });
  await fs.mkdir(join(cloudDocs, 'CLOUD_ARCHIVES'), { recursive: true });
  await fs.mkdir(cloudStorage);
  await fs.mkdir(project);
  const projectLink = join(fixture, 'project-link');
  const cloudLink = join(fixture, 'cloud-link');
  const broadPaths = ['/', home, library, icloud, cloudStorage, cloudDocs, join(cloudDocs, 'CLOUD_ARCHIVES')];
  if (process.platform === 'darwin') broadPaths.push('/Users');
  const broadLinks = broadPaths.map((target, i) => [target, join(fixture, `broad-${i}`)]);
  for (const [target, link] of [...broadLinks, [project, projectLink], [cloudProject, cloudLink]]) {
    await fs.symlink(target, link, 'dir');
  }
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  let applyFixture;
  try { ({ apply: applyFixture } = await import(`./index.mjs?home=${encodeURIComponent(home)}`)); }
  finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
  let pre;
  const ctx = { get(name) { return name === 'tools' ? { guard() {} } : undefined; }, on(_event, fn) { pre = fn; } };
  applyFixture(ctx);
  let calls = 0;
  const next = () => { calls++; return 'allowed'; };
  for (const path of [projectLink, join(temporary, 'home', 'project'), cloudLink]) {
    assert.equal(await pre({ name: 'grep', arguments: { path } }, next), 'allowed', path);
  }
  for (const [, path] of broadLinks) {
    assert.equal((await pre({ name: 'grep', arguments: { path } }, next)).kind, 'deny', path);
  }
  assert.match((await pre({ name: 'grep', arguments: { path: join(fixture, 'missing') } }, next)).reason, /unavailable.*fail closed/);
  const agent = { session: { header: { cwd: cloudLink } } };
  assert.equal((await pre({ name: 'dsh_search_workspace', arguments: {}, agent }, next)).kind, 'deny');
  assert.equal(await pre({ name: 'dsh_search_workspace', arguments: { root: cloudLink }, agent }, next), 'allowed');
  assert.equal(calls, 4);
});

test('glob judge still decides independently for scoped recursive searches', async () => {
  let pre;
  let decisions = 0;
  const ctx = { get(name) {
    if (name === 'tools') return { guard() {} };
    if (name === 'dshJudge') return { decide: async () => { decisions++; return { decision: 'deny' }; } };
  }, on(_event, fn) { pre = fn; } };
  apply(ctx);
  const path = fileURLToPath(new URL('.', import.meta.url));
  assert.equal((await pre({ name: 'glob', arguments: { path, pattern: '**/*.mjs' } }, () => 'allowed')).kind, 'deny');
  assert.equal(decisions, 1);
  assert.equal(await pre({ name: 'glob', arguments: { path, pattern: '*.mjs' } }, () => 'allowed'), 'allowed');
  assert.equal(decisions, 1);
});
