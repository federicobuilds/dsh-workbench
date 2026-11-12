import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createMemoryPreview,
  buildMemorySnapshot,
  validateMemoryPublication,
  supersedeMemoryClaims,
} from './memory-preview.mjs';

const owned = [];
test.after(async () => {
  for (const dir of owned) await rm(dir, { recursive: true, force: true });
});

async function makeProject() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-mem-preview-')));
  owned.push(base);
  process.env.TMPDIR = join(base, 'tmp');
  await mkdir(process.env.TMPDIR, { mode: 0o700 });
  const project = join(base, 'proj');
  const memory = join(project, '.kilocode/memory');
  await mkdir(memory, { recursive: true });
  await writeFile(join(memory, 'INDEX.md'), '# Project Index\n\n## Status\nUse the shared path. Why: one place. How to apply: always.\n');
  await writeFile(join(memory, 'changelog.md'), '# Changelog\n\n[2026-10-26 10:00]\nWhat: Initialized memory\n');
  return { base, project, memory };
}

function authorFullReadable(snapshot) {
  const { model } = snapshot;
  return JSON.stringify({
    version: 1,
    project: snapshot.projectId,
    docs: snapshot.docs.map((doc) => ({
      rel: doc.rel,
      sha256: doc.sha256,
      explanation: `Plain explanation of ${doc.rel}.`,
      sections: model.sections.filter((s) => s.docId === doc.id).map((s) => ({ id: s.id, explanation: `Plain section ${s.id}.` })),
      facts: model.facts.filter((f) => f.docId === doc.id).map((f) => ({ id: f.id, fact: `Plain fact ${f.id}.` })),
      records: model.timeline.filter((r) => r.docId === doc.id).map((r) => ({ line: r.line, text: `Plain record ${r.line}.` })),
    })),
  });
}

test('memory_preview start, status, and stop manage the loopback preview and publish memory.html at 0600', async () => {
  const { project, memory } = await makeProject();
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => project };
      return undefined;
    },
  };
  const mp = createMemoryPreview(ctx, { root: project, nativeWatch: false, intervalMs: 60000, debounceMs: 0 });
  try {
    const initialStatus = await mp.execute({ action: 'status' }, { root: project });
    assert.equal(initialStatus.status, 'stopped');

    const started = await mp.execute({ action: 'start' }, { root: project });
    assert.equal(started.status, 'live');
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/$/);

    const htmlStat = await stat(join(memory, 'memory.html'));
    assert.equal(htmlStat.mode & 0o777, 0o600);

    const runningStatus = await mp.execute({ action: 'status' }, { root: project });
    assert.equal(runningStatus.status, 'live');
    assert.equal(runningStatus.docs, 2);

    const res = await fetch(started.url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Project Index/);

    const stopped = await mp.execute({ action: 'stop' }, { root: project });
    assert.equal(stopped.status, 'stopped');

    const afterStop = await mp.execute({ action: 'status' }, { root: project });
    assert.equal(afterStop.status, 'stopped');
  } finally {
    await mp.dispose();
  }
});

test('memory companion hooks create 0600 memory.readable.json on root write, gate incomplete completion, and validate authored explanations', async () => {
  const { project, memory } = await makeProject();
  let guard = null;
  const sessions = new Map([
    ['root-sess', { id: 'root-sess', header: { origin: 'user' } }],
    ['child-sess', { id: 'child-sess', header: { origin: 'subagent', parentSession: 'root-sess' } }],
  ]);
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) };
      return undefined;
    },
    on(name, fn) { if (name === 'tools/pre-execute') guard = fn; return () => {}; },
  };
  const mp = createMemoryPreview(ctx, { root: project, nativeWatch: false, debounceMs: 0 });
  try {
    // 1) Delegated child write in a run subfolder does not create memory.readable.json
    const childFile = join(memory, 'run-20261026/handback.md');
    await mkdir(dirname(childFile), { recursive: true });
    await writeFile(childFile, '# Handback\n');
    await mp.recordMemoryWrite('child-sess', project, 'write', { file_path: childFile }, { immediate: true });
    await assert.rejects(() => stat(join(memory, 'memory.readable.json')), { code: 'ENOENT' });

    // 2) Root owner write initializes empty memory.readable.json (0600) and publishes memory.html (0600)
    await mp.recordMemoryWrite('root-sess', project, 'write', { file_path: join(memory, 'INDEX.md') }, { immediate: true });
    const readablePath = join(memory, 'memory.readable.json');
    const readableStat = await stat(readablePath);
    assert.equal(readableStat.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(readablePath, 'utf8')).docs, []);
    assert.equal((await stat(join(memory, 'memory.html'))).mode & 0o777, 0o600);

    // 3) Incomplete memory blocks goal completion for owner and supersedes memory-complete claims
    const gate = await guard({
      name: 'goal_report',
      arguments: { status: 'complete' },
      agent: { session: { id: 'root-sess' } },
    }, async () => ({ kind: 'allow' }));
    assert.equal(gate.kind, 'deny');
    assert.match(gate.reason, /Memory gate: goal_report complete refused/);

    const filtered = await mp.filterClaimText('root-sess', 'msg-1', 'All done.\nProject memory is complete.\nTests pass.');
    assert.ok(!filtered.includes('Project memory is complete.'));
    assert.match(filtered, /Memory status \(harness, replaced a memory-complete claim/);

    // Non-claims are untouched
    assert.equal(supersedeMemoryClaims('Project memory is not complete yet.', 'REPLACED'), null);
    assert.equal(supersedeMemoryClaims('I will mark memory complete after validation.', 'REPLACED'), null);

    // 4) Authoring full plain-language explanations bound to SHA-256 and republishing satisfies validation
    const snap = await buildMemorySnapshot(project);
    await writeFile(readablePath, authorFullReadable(snap), { mode: 0o600 });
    await mp.recordMemoryWrite('root-sess', project, 'write', { file_path: readablePath }, { immediate: true });

    const valid = await validateMemoryPublication(project);
    assert.equal(valid.complete, true);

    const gatePass = await guard({
      name: 'goal_report',
      arguments: { status: 'complete' },
      agent: { session: { id: 'root-sess' } },
    }, async () => ({ kind: 'allow' }));
    assert.deepEqual(gatePass, { kind: 'allow' });
  } finally {
    await mp.dispose();
  }
});
