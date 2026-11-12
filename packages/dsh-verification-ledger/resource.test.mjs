import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RES_OPS,
  RES_CLASSES,
  RESOURCE_DOMAIN_SPEC,
  GB,
  diskGate,
  labelDocker,
  resourceRoute,
  createResource,
} from './resource.mjs';

function makeDomain(spec) {
  const store = new Map();
  for (const name of Object.keys(spec.tables)) store.set(name, new Map());
  return {
    table(name) {
      const m = store.get(name);
      const schema = spec.tables[name].valueSchema;
      return {
        get: (k) => m.get(k),
        put: async (k, v) => m.set(k, schema.parse(v)),
        entries: () => [...m.entries()],
      };
    },
    store,
  };
}

function fixture({ freeBytes = 100 * GB, exists = true, judgePick = { decision: 'create', why: 'needed' } } = {}) {
  const domain = makeDomain(RESOURCE_DOMAIN_SPEC);
  const events = [];
  const handlers = new Map();
  let guard = null;
  let currentJudge = judgePick;
  let currentFree = freeBytes;
  let currentExists = exists;

  const eventStore = {
    record: async (ev) => { events.push(ev); return ev; },
    recent: () => events,
  };

  const ctx = {
    get(name) {
      return {
        workingDirectory: { ensure: async () => '/workspace' },
        dshJudge: {
          decide: async () => (typeof currentJudge === 'function' ? currentJudge() : currentJudge),
        },
        tools: {
          guard: (fn) => { guard = fn; return () => {}; },
        },
      }[name];
    },
    on(name, fn) {
      handlers.set(name, fn);
      return () => {};
    },
  };

  const resource = createResource(ctx, domain, {
    home: '/Users/test',
    statfs: async () => ({ bavail: Math.floor(currentFree / 4096), bsize: 4096 }),
    stat: async () => {
      if (!currentExists) throw new Error('ENOENT');
      return { isFile: () => true };
    },
    events: eventStore,
  });

  const agent = { session: { id: 'sess-1' } };
  const bashCall = (command, workdir = '/workspace', id = 'call-1') => ({
    name: 'bash',
    arguments: { command, workdir },
    agent,
    callId: id,
  });
  const bashResult = (exitCode = 0, cwd = '/workspace') => ({
    isError: false,
    value: {
      kind: 'foreground',
      cwd,
      exitCode,
      signal: null,
      aborted: false,
      timedOut: false,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
    },
  });

  return {
    resource,
    domain,
    events,
    handlers,
    get guard() { return guard; },
    agent,
    bashCall,
    bashResult,
    setJudge: (v) => { currentJudge = v; },
    setFree: (v) => { currentFree = v; },
    setExists: (v) => { currentExists = v; },
  };
}

test('RES_OPS and RES_CLASSES expose canonical resource operations and classes', () => {
  assert.deepEqual(RES_OPS, ['venv', 'conda', 'Download', 'docker_image', 'docker_container', 'scratch_dir']);
  assert.deepEqual(RES_CLASSES, ['deliverable', 'reusable', 'scratch']);
});

test('diskGate warns below 50 GB and refuses below 30 GB unless override_reason is set', async () => {
  const ok = await diskGate({}, { home: '/Users/test', statfs: async () => ({ bavail: 60, bsize: GB }) });
  assert.equal(ok, '');

  const warn = await diskGate({}, { home: '/Users/test', statfs: async () => ({ bavail: 42, bsize: GB }) });
  assert.match(warn, /42\.0 GB free on \/Users\/test, below 50 GB/);

  await assert.rejects(
    () => diskGate({}, { home: '/Users/test', statfs: async () => ({ bavail: 25, bsize: GB }) }),
    /below the 30 GB floor, so this is refused/,
  );

  const overridden = await diskGate(
    { override_reason: 'urgent hotfix container build' },
    { home: '/Users/test', statfs: async () => ({ bavail: 20, bsize: GB }) },
  );
  assert.match(overridden, /20\.0 GB free.*proceeding on override/);
});

test('labelDocker inserts owner and class labels on labelable docker ops and rejects reserved labels', () => {
  for (const prefix of [
    'docker run',
    'docker create',
    'docker build',
    'docker container run',
    'docker container create',
    'docker image build',
    'docker buildx build',
  ]) {
    const res = labelDocker(`${prefix} -t app:1 .`, 'U1', 'scratch');
    assert.equal(res.labeled, 1);
    assert.equal(res.pull, false);
    assert.equal(res.command, `${prefix} --label dsh.owner=U1 --label dsh.class=scratch -t app:1 .`);
  }

  const pulled = labelDocker('docker pull alpine:3.20', 'U1', 'reusable');
  assert.equal(pulled.labeled, 0);
  assert.equal(pulled.pull, true);

  assert.throws(() => labelDocker('docker run --label dsh.owner=fake alpine', 'U1', 'scratch'), /reserved label/);
  assert.throws(() => labelDocker('docker run --label "dsh.class=deliverable" alpine', 'U1', 'scratch'), /reserved label/);
  assert.throws(() => labelDocker('docker run --label-file ./labels alpine', 'U1', 'scratch'), /--label-file/);
});

test('resourceRoute blocks raw resource-creating bash commands and allows null sinks', () => {
  assert.throws(() => resourceRoute('python3 -m venv .venv'), /Resource checkpoint: op=venv, target=\.venv/);
  assert.throws(() => resourceRoute('conda create -p /tmp/conda-env python=3.11'), /Resource checkpoint: op=conda, target=\/tmp\/conda-env/);
  assert.throws(() => resourceRoute('curl -o /tmp/archive.tar.gz https://example.com/a.tgz'), /Resource checkpoint: op=Download, target=\/tmp\/archive.tar.gz/);
  assert.throws(() => resourceRoute('docker run -d postgres:16'), /Resource checkpoint: op=docker_container/);
  assert.throws(() => resourceRoute('mkdir -p /tmp/scratch-work'), /Resource checkpoint: op=scratch_dir, target=\/tmp\/scratch-work/);
  assert.deepEqual(resourceRoute('curl -s -o /dev/null https://example.com/health'), { routed: false, guidance: null });
});

test('createResource correlates bash execution, reuses live ledger candidates, and defaults to create on UNSURE', async () => {
  const f = fixture({ judgePick: { decision: 'UNSURE' } });

  // Raw venv creation is blocked by the guard before calling resource.
  assert.match(f.guard(f.bashCall('python3 -m venv .venv')), /Resource checkpoint/);

  // 1) Decide on UNSURE defaults conservatively to create.
  const first = await f.resource.decide(
    {
      op: 'venv',
      target: '.venv',
      command: 'python3 -m venv .venv',
      purpose: 'Create test virtualenv',
      class: 'reusable',
      owner_task: 'U1',
    },
    { agent: f.agent },
  );
  assert.equal(first.status, 'create');
  assert.equal(first.command, 'python3 -m venv .venv');

  // Wrong workspace is rejected; matching workspace is allowed and recorded as created on exit 0.
  assert.match(f.guard(f.bashCall('python3 -m venv .venv', '/other')), /another workspace/);
  assert.equal(f.guard(f.bashCall('python3 -m venv .venv', '/workspace')), undefined);
  await f.handlers.get('tools/result')(f.bashCall('python3 -m venv .venv', '/workspace'), f.bashResult(0));

  const entries = f.resource.ledger();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'created');
  assert.equal(entries[0].path_or_id, '/workspace/.venv');

  // 2) Judge selects reuse for the existing live candidate.
  f.setJudge({ decision: 'reuse', candidate: entries[0].id, why: 'existing venv matches' });
  const reused = await f.resource.decide(
    {
      op: 'venv',
      target: '.venv',
      command: 'python3 -m venv .venv',
      purpose: 'Reuse test virtualenv',
      class: 'reusable',
      owner_task: 'U1',
    },
    { agent: f.agent },
  );
  assert.equal(reused.status, 'reuse');
  assert.equal(reused.candidate, entries[0].id);
  assert.equal(reused.command, null);

  // 3) Judge selects not-needed.
  f.setJudge({ decision: 'not-needed', why: 'already covered' });
  const unneeded = await f.resource.decide(
    {
      op: 'scratch_dir',
      target: '/tmp/unneeded',
      purpose: 'Unused scratch dir',
      class: 'scratch',
      owner_task: 'U1',
    },
    { agent: f.agent },
  );
  assert.equal(unneeded.status, 'not-needed');
  assert.equal(unneeded.command, null);
  assert.ok(f.events.some((e) => e.kind === 'resource' && e.decision === 'create'));
  assert.ok(f.events.some((e) => e.kind === 'resource' && e.decision === 'reuse'));
  assert.ok(f.events.some((e) => e.kind === 'resource' && e.decision === 'not-needed'));
});
