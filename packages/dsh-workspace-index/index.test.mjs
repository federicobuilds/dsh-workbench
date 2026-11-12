import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, stat, symlink, readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { INDEX_DEFAULTS } from './embedding.mjs';

const unitHooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-typert-protocol') {
    const error = new Error('Typert is excluded from this unit fixture');
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return nextResolve(specifier, context);
} });
const { apply, Config } = await import('./index.mjs');
unitHooks.deregister();

function makeCtx(extra = {}) {
  const tools = new Map();
  return {
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    workingDirectory: { get: () => null },
    _tools: tools,
    ...extra,
  };
}

test('settings schema exposes the requested defaults and options', () => {
  assert.deepEqual(Config({}), {
    provider: 'ollama', baseURL: 'http://127.0.0.1:11434', model: 'embeddinggemma:300m', dimensions: 768,
    storageBackend: 'jsonl', allowExternalEmbeddings: false, autoBuild: true, autoWatch: true, maxFiles: 3000,
  });
  assert.equal(Config({ provider: 'openai-compatible', storageBackend: 'jsonl' }).provider, 'openai-compatible');
  assert.throws(() => Config({ storageBackend: 'lancedb' }));
  assert.throws(() => Config({ provider: 'invalid' }));
  assert.throws(() => Config({ storageBackend: 'invalid' }));
});

test('configured Ollama root URL and watcher setting are honored', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-config-'));
  const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-config-store-'));
  await writeFile(join(ws, 'sample.py'), 'def sample():\n    return 1\n');
  const urls = [];
  const ctx = makeCtx();
  const dispose = apply(ctx, { indexRoot, dimensions: 3, baseURL: 'http://127.0.0.1:11434', autoWatch: false,
    fetch: async (url, init) => {
      urls.push(url);
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }) };
    } });
  try {
    const result = await ctx._tools.get('dsh_index_workspace').execute({ root: ws }, {});
    assert.equal(result.status, 'ok');
    assert.equal(result.watching, false);
    assert.deepEqual(urls, ['http://127.0.0.1:11434/v1/embeddings']);
  } finally {
    dispose();
    await rm(ws, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  }
});

test('remote status reports build progress and rebuild joins the active build', async () => {
  const moduleURL = source => `data:text/javascript,${encodeURIComponent(source)}`;
  const protocolURL = moduleURL(`
    export class TypertRemoteService { constructor(ctx, name) { this.ctx = ctx; ctx._remoteServices[name] = this; } }
    export class RemoteError extends Error { constructor(_code, message) { super(message); } }
    export const principalOf = invocation => invocation.principal;
    export const Remote = (_method, _options) => {};
  `);
  const remoteInfoURL = moduleURL('export const createTypertRemoteInfo = () => ({ descriptors: [] });');
  const zodURL = moduleURL('export const z = { string: () => ({ min: () => ({}) }), json: () => ({}) };');
  const uiHooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-typert-protocol') return nextResolve(protocolURL, context);
    if (specifier === '@deepseek-ai/dsh-typert-protocol/remote-info') return nextResolve(remoteInfoURL, context);
    if (specifier === 'zod') return nextResolve(zodURL, context);
    return nextResolve(specifier, context);
  } });
  let uiApply;
  try { ({ apply: uiApply } = await import('./index.mjs?ui-test')); }
  finally { uiHooks.deregister(); }

  const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-ui-'));
  const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-ui-store-'));
  await writeFile(join(ws, 'sample.py'), 'def sample():\n    return 1\n');
  let beginFetch, finishFetch;
  const started = new Promise(resolve => { beginFetch = resolve; });
  const gate = new Promise(resolve => { finishFetch = resolve; });
  let fetches = 0;
  let watchCallback;
  const ctx = makeCtx({ _remoteServices: {}, invocation: {}, workingDirectory: { get: () => ws }, fs: {
    resolve: async path => ({ targetKey: path }),
    watch: async (_target, callback) => { watchCallback = callback; return () => {}; },
  } });
  ctx.get = key => key === 'typert' ? { register() {} } : ctx[key];
  const dispose = uiApply(ctx, { indexRoot, dimensions: 3, autoWatch: false, fetch: async (_url, init) => {
    fetches++; beginFetch(); await gate;
    return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }) };
  } });
  try {
    const service = ctx._remoteServices.workspaceIndexUi;
    const agent = { session: { id: 'ui-fixture' } };
    assert.equal((await service.getStatus(agent)).indexed, false);
    await started;
    const progress = await service.getStatus(agent);
    assert.equal(progress.building, true);
    assert.equal(progress.progress.totalFiles, 1);
    const rebuilding = service.rebuild(agent);
    finishFetch();
    const result = await rebuilding;
    assert.equal(result.indexed, true);
    assert.equal(result.fileCount, 1);
    assert.equal(result.chunkCount, 1);
    assert.equal(result.storageBackend, 'jsonl');
    assert.equal(result.watching, false);
    assert.deepEqual(result.dirtyPaths, []);
    assert.equal(result.fingerprintMismatch, false);
    assert.equal(fetches, 1);
    await ctx._tools.get('dsh_index_workspace').execute({ action: 'watch', root: ws }, {});
    watchCallback(new Error('ctx watcher failed'));
    const failedWatch = await service.getStatus(agent);
    assert.equal(failedWatch.watchError, 'ctx watcher failed');
    assert.equal(typeof failedWatch.recursive, 'boolean');
    ctx.invocation.principal = 'external';
    await assert.rejects(service.rebuild(agent), /Only the owner/);

    dispose();
    await writeFile(join(ws, 'sample.py'), 'def sample():\n    return 2\n');
    let automaticFetches = 0, fail = false;
    const autoCtx = makeCtx({ _remoteServices: {}, invocation: {}, workingDirectory: { get: () => ws } });
    autoCtx.get = key => key === 'typert' ? { register() {} } : autoCtx[key];
    const autoDispose = uiApply(autoCtx, { indexRoot, dimensions: 3, autoWatch: true, fetch: async (_url, init) => {
      automaticFetches++;
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }) };
    } });
    try {
      const autoService = autoCtx._remoteServices.workspaceIndexUi;
      const dirtyStatus = await autoService.getStatus(agent);
      assert.equal(dirtyStatus.stale, true);
      assert.deepEqual(dirtyStatus.dirtyPaths, ['sample.py']);
      assert.equal(dirtyStatus.fingerprintMismatch, false);
      let status;
      for (let i = 0; i < 100; i++) {
        status = await autoService.getStatus(agent);
        if (automaticFetches === 1 && !status.stale) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(automaticFetches, 1);
      assert.equal(status.stale, false);
      assert.equal(status.watching, true);
      const autoIndex = autoCtx._tools.get('dsh_index_workspace');
      await autoIndex.execute({ action: 'unwatch', root: ws }, {});
      await writeFile(join(ws, 'sample.py'), 'def sample():\n    return 3\n');
      assert.equal((await autoService.getStatus(agent)).stale, true);
      await new Promise(resolve => setTimeout(resolve, 1700));
      assert.equal(automaticFetches, 1);
      fail = true;
      await autoIndex.execute({ action: 'watch', root: ws }, {});
      for (let i = 0; i < 100; i++) {
        status = await autoService.getStatus(agent);
        if (status.reason === 'build-failed') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(status.reason, 'build-failed');
      assert.equal(automaticFetches, 2);
      await new Promise(resolve => setTimeout(resolve, 1700));
      assert.equal((await autoService.getStatus(agent)).reason, 'build-failed');
      assert.equal(automaticFetches, 2);
    } finally { autoDispose(); }
  } finally {
    finishFetch(); dispose();
    await rm(ws, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  }
});

test('workspace index build, incremental SHA-256 reuse, deletion pruning, and semantic search over live Ollama', { skip: process.env.DSH_TEST_OLLAMA !== '1' }, async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-'));
  const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-store-'));
  await writeFile(
    join(ws, 'sort.py'),
    'def sort_items(items):\n    return sorted(items)\n\n\ndef reverse_items(items):\n    return list(reversed(items))\n',
  );
  await writeFile(
    join(ws, 'query.sql'),
    'SELECT customers.name FROM customers JOIN orders ON orders.customer_id = customers.id;\n',
  );
  await writeFile(
    join(ws, 'math.ts'),
    'export function fibonacci(n: number): number {\n  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);\n}\n',
  );

  let fetchCalls = 0;
  const countingFetch = async (url, init) => {
    fetchCalls++;
    return globalThis.fetch(url, init);
  };

  const ctx = makeCtx();
  const dispose = apply(ctx, { indexRoot, maxFiles: 50, fetch: countingFetch });
  const exec = { signal: undefined };
  try {
    const indexTool = ctx._tools.get('dsh_index_workspace');
    const searchTool = ctx._tools.get('dsh_search_workspace');
    const statusTool = ctx._tools.get('dsh_index_status');

    // Before indexing, status reports indexed: false, stale: true
    const preStatus = await statusTool.execute({ root: ws }, exec);
    assert.equal(preStatus.status, 'ok');
    assert.equal(preStatus.indexed, false);
    assert.equal(preStatus.stale, true);

    // 1. Initial build embeds all 3 files
    const build1 = await indexTool.execute({ root: ws }, exec);
    assert.equal(build1.status, 'ok');
    assert.equal(build1.files, 3);
    assert.equal(build1.embeddedFiles, 3);
    assert.equal(build1.reusedFiles, 0);
    assert.equal(build1.prunedFiles, 0);
    assert.ok(build1.indexed >= 4, `expected >=4 semantic chunks, got ${build1.indexed}`);
    assert.equal(build1.modelFingerprint, INDEX_DEFAULTS.modelFingerprint);
    const callsAfterFirstBuild = fetchCalls;
    assert.ok(callsAfterFirstBuild >= 1);

    // Verify atomic publication permissions (0600) and absence of leftover .tmp files
    const idxStat = await stat(build1.indexPath);
    assert.equal(idxStat.mode & 0o777, 0o600);
    const storeFiles = await readdir(indexRoot);
    assert.ok(storeFiles.every(f => !f.includes('.tmp.')));

    // Status immediately after build is fresh (stale: false, dirty: false)
    const freshStatus = await statusTool.execute({ root: ws }, exec);
    assert.equal(freshStatus.indexed, true);
    assert.equal(freshStatus.stale, false);
    assert.equal(freshStatus.dirty, false);
    assert.equal(freshStatus.files, 3);
    assert.equal(freshStatus.chunks, build1.indexed);
    assert.equal(freshStatus.modelFingerprint, INDEX_DEFAULTS.modelFingerprint);
    assert.ok(typeof freshStatus.lastIndexedAt === 'string');

    // 2. Second build with unchanged files reuses 100% of vectors and makes 0 Ollama fetch calls
    const build2 = await indexTool.execute({ root: ws }, exec);
    assert.equal(build2.status, 'ok');
    assert.equal(build2.reusedFiles, 3);
    assert.equal(build2.embeddedFiles, 0);
    assert.equal(build2.prunedFiles, 0);
    assert.equal(fetchCalls, callsAfterFirstBuild, 'unchanged rebuild must not call Ollama');

    // 3. Semantic search ranks matching files & line ranges accurately
    const hitSort = await searchTool.execute({ query: 'sort a list in python', root: ws, topK: 3 }, exec);
    assert.equal(hitSort.status, 'ok');
    assert.equal(hitSort.results[0].path, 'sort.py');
    assert.equal(hitSort.results[0].startLine, 1);
    assert.equal(hitSort.results[0].endLine, 2);
    assert.equal(hitSort.results[0].kind, 'function');

    const hitSql = await searchTool.execute({ query: 'join customers and orders sql', root: ws, topK: 3 }, exec);
    assert.equal(hitSql.results[0].path, 'query.sql');

    // 4. Modify 1 file and delete 1 file -> status becomes dirty/stale, incremental build embeds only the 1 changed file and prunes the deleted one
    await rm(join(ws, 'math.ts'));
    await writeFile(
      join(ws, 'query.sql'),
      'SELECT orders.id, customers.email FROM orders INNER JOIN customers ON orders.customer_id = customers.id;\n',
    );

    const dirtyStatus = await indexTool.execute({ action: 'status', root: ws }, exec);
    assert.equal(dirtyStatus.stale, true);
    assert.equal(dirtyStatus.dirty, true);
    assert.ok(dirtyStatus.dirtyPaths.includes('math.ts') || dirtyStatus.dirtyPaths.includes('query.sql'));

    const build3 = await indexTool.execute({ root: ws }, exec);
    assert.equal(build3.status, 'ok');
    assert.equal(build3.files, 2);
    assert.equal(build3.reusedFiles, 1); // sort.py reused
    assert.equal(build3.embeddedFiles, 1); // only query.sql re-embedded
    assert.equal(build3.prunedFiles, 1); // math.ts pruned

    // Confirm deleted math.ts is no longer in search results
    const afterPruneSearch = await searchTool.execute({ query: 'fibonacci recursion', root: ws, topK: 10 }, exec);
    assert.ok(afterPruneSearch.results.every(r => r.path !== 'math.ts'));

    // Negative cases: unindexed root, empty query, invalid maxFiles
    const emptyWs = await mkdtemp(join(tmpdir(), 'dsh-wsidx-empty-'));
    try {
      const noIdx = await searchTool.execute({ query: 'anything', root: emptyWs, topK: 2 }, exec);
      assert.equal(noIdx.status, 'error');
      assert.equal(noIdx.reason, 'no-index');
    } finally {
      await rm(emptyWs, { recursive: true, force: true });
    }

    const emptyQ = await searchTool.execute({ query: '   ', root: ws }, exec);
    assert.equal(emptyQ.reason, 'empty-query');

    const badMax1 = await indexTool.execute({ root: ws, maxFiles: 0 }, exec);
    assert.equal(badMax1.status, 'error');
    assert.equal(badMax1.reason, 'invalid-max-files');

    const badMax2 = await indexTool.execute({ root: ws, maxFiles: 99999 }, exec);
    assert.equal(badMax2.status, 'error');
    assert.equal(badMax2.reason, 'invalid-max-files');
  } finally {
    dispose();
    await rm(ws, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  }
}, { timeout: 90000 });

test('ignore rules (.gitignore, .kilocodeignore), secret/credential safeguards, symlink rejection, and ctx.fs integration', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-sec-'));
  const outside = await mkdtemp(join(tmpdir(), 'dsh-wsidx-outside-'));
  const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-sec-store-'));

  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body.input.map((_, index) => {
      const vec = new Array(768).fill(0);
      vec[0] = 1;
      vec[1] = index + 1;
      return { index, embedding: vec };
    });
    return { ok: true, status: 200, json: async () => ({ data }) };
  };

  try {
    // Root .gitignore and .kilocodeignore
    await writeFile(join(ws, '.gitignore'), 'ignored_dir/\n*.ignored.js\n!keep.ignored.js\n');
    await writeFile(join(ws, '.kilocodeignore'), 'dsh_skip.py\nsub/nested_skip.ts\n');

    // Valid files that SHOULD be indexed
    await writeFile(join(ws, 'main.ts'), 'export function main() { return 42; }\n');
    await writeFile(join(ws, 'keep.ignored.js'), 'export const kept = true;\n');
    await writeFile(join(ws, '.env.example'), 'API_URL=http://localhost:8080\n');
    await mkdir(join(ws, 'sub'), { recursive: true });
    await writeFile(join(ws, 'sub', '.gitignore'), 'local_only.py\n');
    await writeFile(join(ws, 'sub', 'ok.py'), 'def ok_fn():\n    return "ok"\n');

    // Ignored files that MUST NOT be indexed
    await mkdir(join(ws, 'ignored_dir'), { recursive: true });
    await writeFile(join(ws, 'ignored_dir', 'inside.ts'), 'export const x = 1;\n');
    await writeFile(join(ws, 'drop.ignored.js'), 'export const dropped = true;\n');
    await writeFile(join(ws, 'dsh_skip.py'), 'def skipped(): pass\n');
    await writeFile(join(ws, 'sub', 'nested_skip.ts'), 'export const skipped = 1;\n');
    await writeFile(join(ws, 'sub', 'local_only.py'), 'def local_skip(): pass\n');

    // Secret / credential files that MUST NOT be indexed
    await writeFile(join(ws, '.env'), 'SECRET_VAL=1\n');
    await writeFile(join(ws, '.env.local'), 'LOCAL_VAL=2\n');
    await writeFile(join(ws, '.env.production'), 'PROD_VAL=3\n');
    await writeFile(join(ws, 'id_rsa'), 'ssh key fixture\n');
    await writeFile(join(ws, 'server.pem'), 'cert fixture\n');
    await writeFile(join(ws, 'private.key'), 'key fixture\n');
    const pemHeader = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
    await writeFile(join(ws, 'inline_key.txt'), `${pemHeader}\nfixture\n`);
    await mkdir(join(ws, 'secrets'), { recursive: true });
    await writeFile(join(ws, 'secrets', 'token.json'), '{"ok": false}\n');

    // Symlinks (pointing both inside and outside workspace) that MUST be rejected
    await writeFile(join(outside, 'leaked.py'), 'def leaked(): pass\n');
    await symlink(join(outside, 'leaked.py'), join(ws, 'symlink_outside.py'));
    await symlink(join(ws, 'main.ts'), join(ws, 'symlink_inside.ts'));
    await symlink(outside, join(ws, 'symlink_dir'));

    // Track ctx.fs usage and deny one file via FS_SANDBOX_DENIED
    await writeFile(join(ws, 'sandbox_denied.ts'), 'export const denied = true;\n');
    const fsCalls = { resolve: 0, lstat: 0, readBytes: 0, watch: 0 };
    const mockFs = {
      async resolve(p) {
        fsCalls.resolve++;
        return { targetKey: p, displayPath: p };
      },
      contains(parent, child) {
        return child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + '/');
      },
      async lstat(p) {
        fsCalls.lstat++;
        const st = await stat(p).catch(() => null);
        if (!st) return undefined;
        return { version: 'v1', type: st.isDirectory() ? 'directory' : 'file', size: st.size };
      },
      async readBytes(target, _signal, maxBytes) {
        fsCalls.readBytes++;
        if (target.targetKey.endsWith('sandbox_denied.ts')) {
          const err = new Error('sandbox denied');
          err.code = 'FS_SANDBOX_DENIED';
          throw err;
        }
        const buf = await readFile(target.targetKey);
        if (buf.length > maxBytes) {
          const err = new Error('too large');
          err.code = 'FS_TOO_LARGE';
          throw err;
        }
        return buf;
      },
      async watch() {
        fsCalls.watch++;
        return async () => {};
      },
    };

    const ctx = makeCtx({ fs: mockFs });
    const dispose = apply(ctx, { indexRoot, fetch: fakeFetch });
    try {
      const indexTool = ctx._tools.get('dsh_index_workspace');
      const res = await indexTool.execute({ root: ws }, {});
      assert.equal(res.status, 'ok');

      // Read persisted index header to inspect exact indexed file set
      const lines = (await readFile(res.indexPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
      const header = lines[0];
      assert.equal(header.type, 'header');
      const indexedPaths = Object.keys(header.files).sort();
      assert.deepEqual(indexedPaths, ['.env.example', 'keep.ignored.js', 'main.ts', 'sub/ok.py']);

      assert.ok(fsCalls.resolve > 0, 'ctx.fs.resolve should be used');
      assert.ok(fsCalls.readBytes > 0, 'ctx.fs.readBytes should be used');
      assert.ok(fsCalls.watch > 0, 'ctx.fs.watch should be used');

      // Symlink root itself must be rejected
      const symlinkRootPath = join(outside, 'ws-link');
      await symlink(ws, symlinkRootPath);
      const symRootRes = await indexTool.execute({ root: symlinkRootPath }, {});
      assert.equal(symRootRes.status, 'error');
      assert.equal(symRootRes.reason, 'symlink-root-rejected');
    } finally {
      dispose();
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  }
});

test('watcher reports recursive fallback and errors and caches drift walks', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-watch-'));
  const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-watch-store-'));
  await writeFile(join(ws, 'sample.py'), 'def sample():\n    return 1\n');
  const originalWatch = fs.watch;
  const watcher = new EventEmitter();
  watcher.close = () => {};
  const attempts = [];
  fs.watch = (_path, options) => {
    attempts.push(Boolean(options.recursive));
    if (options.recursive) throw new Error('recursive unsupported');
    return watcher;
  };
  syncBuiltinESMExports();
  let walks = 0;
  let watchCallback;
  const ctx = makeCtx({ fs: {
    resolve: async path => ({ targetKey: path }),
    listDir: async target => { walks++; return (await readdir(target.targetKey)).map(name => ({ name })); },
    watch: async (_target, callback) => { watchCallback = callback; return () => {}; },
  } });
  const fetch = async (_url, init) => ({ ok: true, json: async () => ({
    data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 2, 3] })),
  }) });
  const dispose = apply(ctx, { indexRoot, dimensions: 3, fetch, autoBuild: false });
  try {
    const indexTool = ctx._tools.get('dsh_index_workspace');
    const statusTool = ctx._tools.get('dsh_index_status');
    await indexTool.execute({ action: 'build', root: ws }, {});
    assert.deepEqual(attempts, [true, false]);
    const walksBeforeStatus = walks;
    const first = await statusTool.execute({ root: ws }, {});
    assert.equal(first.recursive, false);
    assert.equal(first.dirty, false);
    assert.ok(walks > walksBeforeStatus, 'first status should check drift');
    const walksAfterStatus = walks;
    assert.equal((await statusTool.execute({ root: ws }, {})).dirty, false);
    assert.equal(walks, walksAfterStatus, 'fresh cached drift must not re-walk');
    watchCallback(new Error('ctx watcher failed'));
    assert.equal((await statusTool.execute({ root: ws }, {})).watchError, 'ctx watcher failed');
    watcher.emit('error', new Error('node watcher failed'));
    assert.equal((await statusTool.execute({ root: ws }, {})).watchError, 'node watcher failed');
    await indexTool.execute({ action: 'unwatch', root: ws }, {});
    assert.equal((await statusTool.execute({ root: ws }, {})).watchError, null);
  } finally {
    dispose();
    fs.watch = originalWatch;
    syncBuiltinESMExports();
    await rm(ws, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  }
});

test('watcher coalesces edits and queues one rebuild for changes during a build', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-auto-'));
  const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-auto-store-'));
  const file = join(ws, 'sample.py');
  await writeFile(file, 'def sample():\n    return 1\n');
  let calls = 0, active = 0, maxActive = 0, releaseBuild, startedBuild;
  let gate = null, started = null;
  const inputs = [];
  const fetch = async (_url, init) => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    inputs.push(JSON.parse(init.body).input.join('\n'));
    if (gate) { startedBuild(); await gate; }
    active--;
    return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }) };
  };
  const ctx = makeCtx();
  const dispose = apply(ctx, { indexRoot, dimensions: 3, fetch, autoBuild: true, autoWatch: true });
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('timed out waiting for automatic rebuild');
  };
  try {
    const build = ctx._tools.get('dsh_index_workspace');
    const status = ctx._tools.get('dsh_index_status');
    const initial = await build.execute({ root: ws, watch: true }, {});
    assert.equal(initial.status, 'ok');
    await writeFile(file, 'def sample():\n    return 2\n');
    await writeFile(file, 'def sample():\n    return 3\n');
    await waitFor(async () => calls === 2 && !(await status.execute({ root: ws }, {})).stale);
    assert.match(inputs[1], /return 3/);
    assert.equal(calls, 2);
    gate = new Promise(resolve => { releaseBuild = resolve; });
    started = new Promise(resolve => { startedBuild = resolve; });
    await writeFile(file, 'def sample():\n    return 4\n');
    await started;
    await writeFile(file, 'def sample():\n    return 5\n');
    await writeFile(file, 'def sample():\n    return 6\n');
    await new Promise(resolve => setTimeout(resolve, 1700));
    assert.equal(calls, 3);
    gate = null;
    releaseBuild();
    await waitFor(async () => calls === 4 && !(await status.execute({ root: ws }, {})).stale);
    await new Promise(resolve => setTimeout(resolve, 1700));
    assert.equal(calls, 4);
    assert.equal(maxActive, 1);
    assert.match(inputs[3], /return 6/);
    const header = JSON.parse((await readFile(initial.indexPath, 'utf8')).split('\n')[0]);
    assert.equal(header.files['sample.py'].sha256, createHash('sha256').update(await readFile(file)).digest('hex'));
    assert.equal((await status.execute({ root: ws }, {})).stale, false);
    await writeFile(file, 'def sample():\n    return 7\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    await build.execute({ action: 'unwatch', root: ws }, {});
    await new Promise(resolve => setTimeout(resolve, 1700));
    assert.equal(calls, 4);
  } finally {
    releaseBuild?.(); dispose();
    await rm(ws, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  }
}, { timeout: 15000 });

test('autoWatch false does not automatically rebuild a manually watched workspace', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-manual-'));
  const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-manual-store-'));
  const file = join(ws, 'sample.py');
  await writeFile(file, 'def sample():\n    return 1\n');
  let calls = 0;
  const fetch = async (_url, init) => {
    calls++;
    return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }) };
  };
  const ctx = makeCtx();
  const dispose = apply(ctx, { indexRoot, dimensions: 3, fetch, autoBuild: true, autoWatch: false });
  try {
    const build = ctx._tools.get('dsh_index_workspace');
    const status = ctx._tools.get('dsh_index_status');
    await build.execute({ root: ws }, {});
    await build.execute({ action: 'watch', root: ws }, {});
    await writeFile(file, 'def sample():\n    return 2\n');
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.equal(calls, 1);
    assert.equal((await status.execute({ root: ws }, {})).stale, true);
  } finally {
    dispose();
    await rm(ws, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  }
});

test('corrupt indexes are rejected, rebuilt without prefix reuse, and canceled builds preserve publication', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-corrupt-'));
  const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-corrupt-store-'));
  const fetch = async (_url, init) => ({ ok: true, json: async () => ({
    data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 2, 3] })),
  }) });
  const ctx = makeCtx();
  const dispose = apply(ctx, { indexRoot, dimensions: 3, fetch, watch: false });
  try {
    await writeFile(join(ws, 'sample.py'), 'def one():\n    return 1\n\ndef two():\n    return 2\n');
    const build = ctx._tools.get('dsh_index_workspace');
    const status = ctx._tools.get('dsh_index_status');
    const search = ctx._tools.get('dsh_search_workspace');
    const first = await build.execute({ root: ws }, {});
    const valid = await readFile(first.indexPath, 'utf8');
    const lines = valid.trim().split('\n');
    assert.ok(lines.length > 2);
    const header = JSON.parse(lines[0]);
    const badHeader = { ...header, chunkCount: header.chunkCount + 1 };
    const badManifest = structuredClone(header);
    badManifest.files['sample.py'].chunks++;
    const badVector = JSON.parse(lines[1]);
    badVector.v = [0, 0, 0];
    for (const broken of [
      `${valid}{`,
      lines.slice(0, -1).join('\n') + '\n',
      [JSON.stringify(badHeader), ...lines.slice(1)].join('\n') + '\n',
      [JSON.stringify(badManifest), ...lines.slice(1)].join('\n') + '\n',
      [lines[0], JSON.stringify(badVector), ...lines.slice(2)].join('\n') + '\n',
      [lines[0], JSON.stringify({ type: 'chunk' }), ...lines.slice(2)].join('\n') + '\n',
      lines[0] + '\n',
      Buffer.from([0xff]),
    ]) {
      await writeFile(first.indexPath, broken);
      assert.equal((await status.execute({ root: ws }, {})).reason, 'corrupt-index');
      assert.equal((await search.execute({ root: ws, query: 'one' }, {})).reason, 'corrupt-index');
    }
    const rebuilt = await build.execute({ root: ws }, {});
    assert.equal(rebuilt.status, 'ok');
    assert.equal(rebuilt.reusedChunks, 0);
    assert.equal((await status.execute({ root: ws }, {})).status, 'ok');
    const published = await readFile(first.indexPath, 'utf8');
    const duringWalk = new AbortController();
    const walkCtx = makeCtx({ fs: {
      resolve: async path => ({ targetKey: path }),
      listDir: async () => { duringWalk.abort(); return []; },
    } });
    const walkDispose = apply(walkCtx, { indexRoot, dimensions: 3, fetch, watch: false });
    try {
      assert.equal((await walkCtx._tools.get('dsh_index_workspace').execute({ root: ws }, { signal: duringWalk.signal })).reason, 'canceled');
      assert.equal(await readFile(first.indexPath, 'utf8'), published);
    } finally { walkDispose(); }
    await writeFile(join(ws, 'sample.py'), 'def changed():\n    return 3\n');
    const failingCtx = makeCtx();
    const failingDispose = apply(failingCtx, { indexRoot, dimensions: 3, fetch: async () => { throw new Error('offline'); }, watch: false });
    try {
      await assert.rejects(failingCtx._tools.get('dsh_index_workspace').execute({ root: ws }, {}), /offline/);
      assert.equal(await readFile(first.indexPath, 'utf8'), published);
    } finally { failingDispose(); }
    const controller = new AbortController();
    controller.abort();
    assert.equal((await build.execute({ root: ws }, { signal: controller.signal })).reason, 'canceled');
    assert.equal(await readFile(first.indexPath, 'utf8'), published);
    dispose();
    const changedCtx = makeCtx();
    const changedDispose = apply(changedCtx, { indexRoot, dimensions: 4, fetch, watch: false });
    try {
      const changed = await changedCtx._tools.get('dsh_index_status').execute({ root: ws }, {});
      assert.equal(changed.status, 'ok');
      assert.equal(changed.fingerprintMismatch, true);
      assert.equal(changed.stale, true);
    } finally { changedDispose(); }
  } finally {
    dispose();
    await rm(ws, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  }
});

test('pre-step auto-build uses session root and retries resolved cancellation and thrown failures', async () => {
  for (const failure of ['canceled', 'thrown']) {
    const ws = await mkdtemp(join(tmpdir(), 'dsh-wsidx-hook-'));
    const indexRoot = await mkdtemp(join(tmpdir(), 'dsh-wsidx-hook-store-'));
    await writeFile(join(ws, 'sample.py'), 'def sample():\n    return 1\n');
    const session = { id: 'fixture' };
    let hook;
    let fetches = 0;
    let service;
    const ctx = makeCtx({
      workingDirectory: { get: actual => { assert.equal(actual, session); return ws; } },
      on: (event, fn) => { assert.equal(event, 'agent/pre-step'); hook = fn; return () => {}; },
      provide: (key, value) => { assert.equal(key, 'dshWorkspaceIndex'); service = value; return () => {}; },
    });
    const fetch = async (_url, init) => {
      fetches++;
      if (failure === 'thrown' && fetches === 1) throw new Error('offline');
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }) };
    };
    const dispose = apply(ctx, { indexRoot, dimensions: 3, fetch, watch: false, autoBuild: true });
    try {
      const canceled = new AbortController();
      if (failure === 'canceled') canceled.abort();
      const decision = { kind: 'enter', messages: [] };
      await hook({ agent: { session }, signal: canceled.signal }, async () => decision);
      await new Promise(resolve => setTimeout(resolve, 30));
      for (let attempt = 0; attempt < 100; attempt++) {
        await hook({ agent: { session } }, async () => decision);
        if ((await service.status({ session })).indexed) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const result = await service.status({ session });
      assert.deepEqual(Object.keys(result).sort(), ['dirty', 'fingerprintMismatch', 'indexed', 'lastIndexedAt', 'stale', 'status']);
      assert.equal(result.indexed, true);
      assert.equal(result.stale, false);
      assert.equal(fetches, failure === 'thrown' ? 2 : 1);
    } finally {
      dispose();
      await rm(ws, { recursive: true, force: true });
      await rm(indexRoot, { recursive: true, force: true });
    }
  }
});

test('external embeddings require an explicit opt-in and HTTPS before workspace access', async () => {
  for (const [baseURL, allowExternalEmbeddings, reason] of [
    ['https://embeddings.example.test/v1', false, 'external-embeddings-disabled'],
    ['http://embeddings.example.test/v1', true, 'external-embeddings-require-https'],
    ['https://user:password@embeddings.example.test/v1', true, 'invalid-embedding-endpoint'],
  ]) {
    const ctx = makeCtx();
    const dispose = apply(ctx, { baseURL, allowExternalEmbeddings,
      fetch: () => assert.fail('A denied provider must receive no request') });
    try {
      for (const [name, args] of [['dsh_index_workspace', {}], ['dsh_search_workspace', { query: 'fixture' }]]) {
        const result = await ctx._tools.get(name).execute(args, {});
        assert.equal(result.reason, reason);
      }
    } finally { dispose(); }
  }
});
