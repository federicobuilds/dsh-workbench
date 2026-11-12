import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefIsReadOnly, nativeWorkingDirectory, readOnlyToolRefusal, archiveCwdRefusal } from './worker-scope.mjs';

test('explicit read-only changes and no-file-writes constraints are restrictive', () => {
  assert.equal(briefIsReadOnly({ changes: 'read-only research' }), true);
  assert.equal(briefIsReadOnly({ changes: 'research', constraints: 'No file writes, no installs, no config changes.' }), true);
  assert.equal(briefIsReadOnly({ changes: 'local executable code', scope: 'src/app.py' }), false);
});

test('archive-internal cwd is refused before filesystem calls, real directories are accepted', async () => {
  let reads = 0;
  const io = { realpath: async value => { reads++; return value; }, stat: async () => ({ isDirectory: () => true }) };
  await assert.rejects(nativeWorkingDirectory('/Applications/Test.app/Contents/Resources/app.asar/dsh', io), /real operating-system/);
  assert.equal(reads, 0);
  assert.equal(await nativeWorkingDirectory('/Applications/Test.app/Contents/Resources/app.asar.unpacked', io), '/Applications/Test.app/Contents/Resources/app.asar.unpacked');
  await assert.rejects(nativeWorkingDirectory('/workspace/file', { ...io, stat: async () => ({ isDirectory: () => false }) }), /not a real/);
});

test('read-only tool refusal blocks direct writes and escalation without blocking inspection', () => {
  for (const name of ['write', 'edit', 'apply_patch']) assert.match(readOnlyToolRefusal({ name }), /not authorized/);
  assert.match(readOnlyToolRefusal({ name: 'bash', arguments: { sandboxMode: 'danger-full-access' } }), /escalation/);
  assert.match(readOnlyToolRefusal({ name: 'background_process', arguments: { action: 'start' } }), /not authorized/);
  assert.equal(readOnlyToolRefusal({ name: 'read', arguments: { path: '/workspace/report.md' } }), null);
  assert.equal(readOnlyToolRefusal({ name: 'background_process', arguments: { action: 'logs' } }), null);
});

test('direct cwd tool is blocked for archives, not ordinary unpacked paths', () => {
  assert.match(archiveCwdRefusal({ name: 'working_directory', arguments: { cd: '/Applications/Test.app/Contents/Resources/app.asar/dsh' } }), /real workspace/);
  assert.match(archiveCwdRefusal({ name: 'bash', arguments: { workdir: '/app.asar/dsh' } }), /real workspace/);
  assert.equal(archiveCwdRefusal({ name: 'working_directory', arguments: { cd: '/workspace/project' } }), null);
});
