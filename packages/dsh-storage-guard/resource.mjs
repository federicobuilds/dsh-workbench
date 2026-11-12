import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { resolvePolicy } from './policy.mjs';
import { trackPolicyReader } from './tracks.mjs';
import { createEventStore, makeEvent } from './event-store.mjs';
import { redactText } from './redaction.mjs';

export const RES_OPS = Object.freeze([
  'venv',
  'conda',
  'Download',
  'docker_image',
  'docker_container',
  'scratch_dir',
]);
const VALID_RES_OPS = new Set([...RES_OPS, 'download', 'ensure_env']);

export const RES_CLASSES = Object.freeze(['deliverable', 'reusable', 'scratch']);
const DOCKER_OPS = new Set(['docker_image', 'docker_container']);
const CANDIDATES_MAX = 10;

const DOCKER_LABELABLE = /^\s*(docker\s+(?:container\s+(?:run|create)|image\s+build|buildx\s+build|run|create|build))(?=\s|$)/;
const DOCKER_PULL = /^\s*docker\s+(image\s+)?pull(?=\s|$)/;
export const LABEL_VALUE = /^[A-Za-z0-9._:@\/-]{1,128}$/;
// 2026-11-10: Reserve legacy labels for backward compatibility.
export const RESERVED_LABEL = /(?:dsh|kilo)\.(class|owner)|--label-file/i;
const OVERRIDE = /^OVERRIDE:[ \t]*\S.{4,}/m;

export const GB = 1e9;
export const DISK_WARN_GB = 50;
export const DISK_REFUSE_GB = 30;

const NULL_SINKS = new Set(['/dev/null', '-', '/dev/stdout', '/dev/stderr']);
const KILO_TMP = '/var/folders/07/bshbzmzx7wx8f1psg06kck8m0000gn/T/kilo';
const TMP_ROOTS = [
  ...new Set([
    tmpdir(),
    (() => { try { return realpathSync(tmpdir()); } catch { return tmpdir(); } })(),
    '/tmp',
    '/private/tmp',
    KILO_TMP,
  ]),
];

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const ledgerRecordSchema = {
  parse(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid resource ledger record');
    if (typeof raw.id !== 'string' || !raw.id) throw new Error('Invalid resource ledger id');
    if (typeof raw.machine !== 'string' || !raw.machine) throw new Error('Invalid resource ledger machine');
    if (typeof raw.kind !== 'string' || !VALID_RES_OPS.has(raw.kind)) throw new Error('Invalid resource ledger kind');
    if (typeof raw.path_or_id !== 'string' || !raw.path_or_id) throw new Error('Invalid resource ledger path_or_id');
    if (typeof raw.owner_session !== 'string' || !raw.owner_session) throw new Error('Invalid resource ledger owner_session');
    if (typeof raw.owner_task !== 'string' || !LABEL_VALUE.test(raw.owner_task)) throw new Error('Invalid resource ledger owner_task');
    if (typeof raw.class !== 'string' || !RES_CLASSES.includes(raw.class)) throw new Error('Invalid resource ledger class');
    if (!['created', 'failed', 'done', 'removed'].includes(raw.status)) throw new Error('Invalid resource ledger status');
    if (typeof raw.created_at !== 'string' || typeof raw.last_used !== 'string') throw new Error('Invalid resource ledger timestamps');
    return JSON.parse(JSON.stringify(raw));
  },
};

export const RESOURCE_DOMAIN_SPEC = Object.freeze({
  name: 'dsh_resources',
  version: 1,
  tables: {
    ledger: { valueSchema: ledgerRecordSchema },
  },
});

/** Offsets where a top-level shell command starts (outside quotes, escapes, backticks, and parens). */
export function commandStarts(command) {
  const starts = [0];
  let quote = null;
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '\\') {
      i++;
    } else if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
    } else if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) {
      continue;
    } else if (depth === 0 && (c === ';' || c === '|' || c === '&' || c === '\n')) {
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Words of one shell command with quotes and escapes removed up to the first unquoted separator. */
export function shellWords(s) {
  const words = [];
  let w = null;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else w += c;
    } else if (quote) {
      if (c === quote) quote = null;
      else w += c === '\\' && i + 1 < s.length ? s[++i] : c;
    } else if (c === "'" || c === '"') {
      quote = c;
      w ??= '';
    } else if (c === '\\') {
      i++;
      if (s[i] !== '\n') w = (w ?? '') + (s[i] ?? '');
    } else if (c === ' ' || c === '\t') {
      if (w !== null) {
        words.push(w);
        w = null;
      }
    } else if (';&|\n()'.includes(c)) {
      break;
    } else {
      w = (w ?? '') + c;
    }
  }
  if (w !== null) words.push(w);
  return words;
}

/**
 * Validate and insert `--label dsh.owner=<owner> --label dsh.class=<cls>` into every
 * labelable top-level docker command (`run`, `create`, `build`, `container run/create`,
 * `image build`, `buildx build`). Rejects reserved label keys and `--label-file`.
 */
export function labelDocker(command, owner, cls) {
  if (typeof command !== 'string') throw new Error('resource: command must be a string');
  for (const [name, value] of [['owner_task', owner], ['class', cls]]) {
    if (!LABEL_VALUE.test(String(value ?? ''))) {
      throw new Error(`resource: ${name} must match ${LABEL_VALUE}, 1 to 128 letters, digits, or . _ : @ / -.`);
    }
  }
  if (RESERVED_LABEL.test(command) || RESERVED_LABEL.test(command.replace(/['"\\]/g, ''))) {
    throw new Error(
      'resource: the command sets a reserved label (dsh.class or dsh.owner) or uses --label-file. ' +
      'The harness sets these labels itself; remove them from the command and call again.',
    );
  }
  const labels = `--label dsh.owner=${owner} --label dsh.class=${cls}`;
  const starts = commandStarts(command);
  let out = command;
  let labeled = 0;
  for (const start of [...starts].reverse()) {
    const m = DOCKER_LABELABLE.exec(command.slice(start));
    if (!m) continue;
    const at = start + m[0].length;
    out = `${out.slice(0, at)} ${labels}${out.slice(at)}`;
    labeled++;
  }
  return {
    command: out,
    labeled,
    pull: starts.some((start) => DOCKER_PULL.test(command.slice(start))),
  };
}

/**
 * Low-disk alarm before a resource create or heavy check: warn below 50 GB free on `homedir()`,
 * refuse below 30 GB unless `override_reason` is non-empty (or an argument holds an OVERRIDE line).
 */
export async function diskGate(args = {}, options = {}) {
  const home = options.home ?? homedir();
  const statfsFn = options.statfs ?? statfs;
  let free;
  try {
    const s = await statfsFn(home);
    free = Number(s.bavail) * Number(s.bsize);
  } catch (e) {
    return `Disk check: could not read free space on ${home} (${e?.message ?? e}); proceeding without a number.`;
  }
  if (free >= DISK_WARN_GB * GB) return '';
  const gb = (free / GB).toFixed(1);
  const override = Boolean(String(args?.override_reason ?? '').trim())
    || Object.values(args ?? {}).some((v) => typeof v === 'string' && OVERRIDE.test(v));
  if (free < DISK_REFUSE_GB * GB && !override) {
    throw new Error(
      `Disk check: ${gb} GB free on ${home}, below the ${DISK_REFUSE_GB} GB floor, so this is refused. ` +
      'Free space first, or call again with a non-empty override_reason (or an "OVERRIDE: <reason>" line) naming why it must run now.',
    );
  }
  return `Disk check: ${gb} GB free on ${home}, below ${DISK_WARN_GB} GB${free < DISK_REFUSE_GB * GB ? '; proceeding on override' : ''}.`;
}

const underTmp = (p) => typeof p === 'string' && p.startsWith('/') && !p.split('/').includes('..')
  && TMP_ROOTS.some((r) => p.startsWith(`${r.replace(/\/$/, '')}/`));

/** Recognize raw resource-creating commands at top-level command starts. */
export function rawResourceForms(command) {
  if (typeof command !== 'string') return [];
  const forms = [];
  for (const start of commandStarts(command)) {
    const s = command.slice(start).trimStart();
    const t = shellWords(s);
    const name = (t[0] ?? '').split('/').pop() ?? '';
    const rest = t.slice(1);
    const operand = (from) => from.find((a) => !a.startsWith('-')) ?? null;
    const after = (flags) => {
      for (let i = 0; i < rest.length; i++) {
        if (flags.includes(rest[i])) return rest[i + 1] ?? null;
        const long = flags.find((f) => f.startsWith('--') && rest[i].startsWith(`${f}=`));
        if (long) return rest[i].slice(long.length + 1);
      }
      return null;
    };
    let kind = null;
    let target = null;
    if (/^python[\d.]*$/.test(name) && rest[0] === '-m' && rest[1] === 'venv') {
      kind = 'venv';
      target = operand(rest.slice(2));
    } else if (name === 'uv' && rest[0] === 'venv') {
      kind = 'venv';
      target = operand(rest.slice(1)) ?? '.venv';
    } else if ((name === 'conda' || name === 'mamba' || name === 'micromamba') && (rest[0] === 'create' || (rest[0] === 'env' && rest[1] === 'create'))) {
      kind = 'conda';
      target = after(['-p', '--prefix', '-n', '--name']) ?? operand(rest.slice(rest[0] === 'env' ? 2 : 1));
    } else if (name === 'docker') {
      if (['pull', 'build', 'run', 'create'].includes(rest[0])) {
        kind = `docker_${rest[0]}`;
        target = rest[0] === 'pull' ? operand(rest.slice(1)) : null;
      } else if (rest[0] === 'container' && ['run', 'create'].includes(rest[1])) {
        kind = `docker_${rest[1]}`;
      } else if (rest[0] === 'image' && ['build', 'pull'].includes(rest[1])) {
        kind = `docker_${rest[1]}`;
        target = rest[1] === 'pull' ? operand(rest.slice(2)) : null;
      } else if (rest[0] === 'buildx' && rest[1] === 'build') {
        kind = 'docker_build';
      }
    } else if (name === 'curl') {
      target = after(['-o', '--output']) ?? (rest.some((a) => a === '-O' || a === '--remote-name') ? '(remote name)' : null);
      if (target && !NULL_SINKS.has(target)) kind = 'Download';
    } else if (name === 'wget') {
      const doc = after(['-O', '--output-document']);
      target = doc ?? after(['-P', '--directory-prefix']);
      if (doc ? !NULL_SINKS.has(doc) : target) kind = 'Download';
    } else if (name === 'mkdir') {
      const paths = rest.filter((a) => !a.startsWith('-'));
      if (paths.some((a) => /[$`]/.test(a))) kind = 'unknown';
      else if (paths.length && paths.every(underTmp)) {
        kind = 'scratch_dir';
        target = paths[0];
      }
    }
    if (!kind) continue;
    const segment = s.slice(0, s.search(/[;&|\n]|$/));
    forms.push(kind === 'unknown' || /[$`*?]/.test(segment) ? { kind: 'unknown', target: null } : { kind, target });
  }
  return forms;
}

const ROUTE_OPERATIONS = Object.freeze({
  venv: 'venv',
  conda: 'conda',
  docker_pull: 'docker_image',
  docker_build: 'docker_image',
  docker_run: 'docker_container',
  docker_create: 'docker_container',
  Download: 'Download',
  download: 'Download',
  scratch_dir: 'scratch_dir',
});

/** Check a bash command for unrouted resource creation; throws a Resource checkpoint error when matched. */
export function resourceRoute(command, options = {}) {
  if (typeof command !== 'string' || !command.trim()) return { routed: false, guidance: null };
  const sessionId = options.sessionId ?? options.sessionID ?? '';
  const pending = options.pending;
  if (pending && typeof pending.has === 'function' && pending.has(`${sessionId}\0${command}`)) {
    return { routed: false, guidance: null };
  }
  const forms = rawResourceForms(command);
  const known = forms.filter((form) => form.kind !== 'unknown');
  if (!known.length) {
    if (forms.length) {
      return {
        routed: false,
        guidance: 'Resource guidance: this command uses dynamic resource destinations. If it creates an environment, download, container or scratch directory, submit it through resource with the resolved target. This parser does not certify opaque scripts.',
      };
    }
    return { routed: false, guidance: null };
  }
  const summary = known
    .map((form) => `op=${ROUTE_OPERATIONS[form.kind] ?? form.kind}, target=${form.target ?? '(specify its real target)'}`)
    .join('; ');
  const message = redactText(
    `Resource checkpoint: ${summary}. Call resource with that operation, real target, purpose, class and this command. ` +
    'Follow its create/reuse/not-needed decision; execute only its returned command unchanged. ' +
    'This routing grants no installation, deletion, network or disk permission.',
  ).text;
  throw new Error(message);
}

const svc = (ctx, name) => {
  if (ctx == null) return undefined;
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
};

function sanitizeLedgerEntry(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    out[k] = typeof v === 'string' && k !== 'id' && k !== 'owner_session' ? redactText(v).text : v;
  }
  return ledgerRecordSchema.parse(out);
}

function validateEffOverride(args, validIds) {
  const reason = args?.efficiency_override_reason;
  const ids = args?.evidence_ids;
  if (typeof reason !== 'string' || /[\r\n]/.test(reason)) return null;
  const r = reason.trim();
  if (!r || r.length < 10 || r.length > 300 || /^#?\s*OVERRIDE\b/i.test(r)) return null;
  if (!Array.isArray(ids) || !ids.length || ids.length > 4) return null;
  if (!ids.every((id) => typeof id === 'string' && (!validIds || validIds.has(id)))) return null;
  return { reason: r, evidence_ids: ids };
}

/** Create the durable resource governance service and bash correlation hooks. */
export function createResource(ctx, domain, config = {}) {
  const pending = new Map();
  const executing = new Map();
  const table = domain ? domain.table('ledger') : null;
  const statfsFn = config.statfs ?? statfs;
  const statFn = config.stat ?? stat;
  const home = config.home ?? homedir();
  const sharedEvents = config.events ?? null;

  async function journal(sessionId, decision, reason, extra = {}) {
    try {
      const store = sharedEvents ?? (() => {
        const d = svc(ctx, 'storageDomain')?.get?.('dsh_governance_events');
        return d ? createEventStore(d) : null;
      })();
      if (!store) return;
      const ev = makeEvent({ kind: 'resource', session: sessionId, decision, reason, tool: 'resource', ...extra });
      ev.id = randomUUID();
      ev.permissionGranted = false;
      await store.record(ev);
    } catch { /* best-effort */ }
  }

  function ledger() {
    if (!table) return [];
    const out = [];
    for (const [, entry] of table.entries()) out.push(entry);
    return out;
  }

  async function putLedger(entry) {
    if (!table) throw new Error('Resource ledger store unavailable');
    const record = sanitizeLedgerEntry(entry);
    await table.put(record.id, record);
    return record;
  }

  async function rootOf(exec) {
    if (typeof exec?.root === 'string' && isAbsolute(exec.root) && exec.root !== '/') return exec.root;
    if (typeof exec?.directory === 'string' && isAbsolute(exec.directory) && exec.directory !== '/') return exec.directory;
    const wd = svc(ctx, 'workingDirectory');
    if (wd && typeof wd.ensure === 'function' && exec?.agent) {
      const r = await wd.ensure(exec.agent, exec.signal);
      if (r && r !== '/') return r;
    }
    if (typeof config.root === 'string' && isAbsolute(config.root) && config.root !== '/') return config.root;
    throw new Error('resource: workspace root unavailable');
  }

  function resolveObjective(exec, sessionId, purpose) {
    if (exec?.objective && typeof exec.objective === 'object') return exec.objective;
    const eff = svc(ctx, 'efficiency') ?? config.efficiency;
    if (eff && typeof eff.getObjective === 'function') {
      const o = eff.getObjective(sessionId);
      if (o) return o;
    }
    const goals = svc(ctx, 'goals');
    if (goals && typeof goals.get === 'function' && exec?.agent) {
      const g = goals.get(exec.agent);
      if (typeof g?.objective === 'string' && g.objective.trim()) {
        const text = g.objective.trim();
        const complete = text.length <= 4000;
        return {
          objective_state: complete ? 'known' : 'unknown',
          text: complete ? text : null,
          goal_source: complete ? 'newest' : 'truncated',
          complete,
          provenance: ['goal'],
        };
      }
      const derived = (exec.agent?.session?.deriveMessages?.() ?? [])
        .filter((m) => m.role === 'user' && m.source?.kind === 'user')
        .slice(-3)
        .map((m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'))
        .filter(Boolean);
      if (derived.length) {
        const text = derived.join('\n---\n');
        const complete = text.length <= 4000;
        return {
          objective_state: complete ? 'known' : 'unknown',
          text: complete ? text : null,
          goal_source: complete ? 'newest' : 'truncated',
          complete,
          provenance: derived.map((_, i) => `msg-${i + 1}`),
        };
      }
      if (exec.objectiveComplete === false) {
        return { objective_state: 'unknown', text: null, goal_source: 'missing', complete: false, provenance: [] };
      }
    }
    if (exec?.objectiveComplete === false) {
      return { objective_state: 'unknown', text: null, goal_source: 'missing', complete: false, provenance: [] };
    }
    return {
      objective_state: 'known',
      text: String(purpose ?? '').slice(0, 4000),
      goal_source: 'newest',
      complete: true,
      provenance: ['req-1'],
    };
  }

  async function decide(args, exec = {}) {
    if (!table) throw new Error('Resource ledger store unavailable');
    if (!args || typeof args !== 'object') throw new Error('Invalid resource request');
    if (typeof args.op !== 'string' || !VALID_RES_OPS.has(args.op)) {
      throw new Error(`resource: op must be one of ${RES_OPS.join(', ')}`);
    }
    if (typeof args.target !== 'string' || !args.target.trim()) {
      throw new Error('resource: target is required');
    }
    if (typeof args.purpose !== 'string' || !args.purpose.trim()) {
      throw new Error('resource: purpose is required');
    }
    for (const [name, value] of [['owner_task', args.owner_task], ['class', args.class]]) {
      if (!LABEL_VALUE.test(String(value ?? ''))) {
        throw new Error(`resource: ${name} must match ${LABEL_VALUE}, 1 to 128 letters, digits, or . _ : @ / -.`);
      }
    }
    if (!RES_CLASSES.includes(args.class)) {
      throw new Error(`resource: class must be one of ${RES_CLASSES.join(', ')}`);
    }
    const supplied = args.command ?? '';
    if (typeof supplied !== 'string') throw new Error('resource: command must be a string');
    if (RESERVED_LABEL.test(supplied) || RESERVED_LABEL.test(supplied.replace(/['"\\]/g, ''))) {
      throw new Error(
        'resource: the command sets a reserved label (dsh.class or dsh.owner) or uses --label-file. ' +
        'The harness sets these labels itself; remove them from the command and call again.',
      );
    }

    const root = await rootOf(exec);
    const sessionId = exec?.agent?.session?.id ?? exec?.sessionID ?? exec?.sessionId ?? 'unknown';
    const docker = DOCKER_OPS.has(args.op);
    const target = docker ? args.target.trim() : resolve(root, args.target.trim());
    const stored = redactText(target).text;

    const matching = ledger()
      .filter((e) => e.kind === args.op && e.path_or_id === stored && (e.status === 'created' || e.status === 'done'))
      .sort((a, b) => (a.last_used < b.last_used ? 1 : a.last_used > b.last_used ? -1 : 0))
      .slice(0, CANDIDATES_MAX);

    const candidates = await Promise.all(
      matching.map(async (e) => ({
        entry: e,
        exists: docker ? 'unknown' : await statFn(e.path_or_id).then(() => true, () => false),
      })),
    );

    const objective = resolveObjective(exec, sessionId, args.purpose);
    let family = 'off';
    try { family = resolvePolicy(sessionId, trackPolicyReader(ctx)).mode ?? 'off'; } catch { /* default off */ }

    const judgeService = svc(ctx, 'dshJudge');
    let judged = { decision: 'UNSURE' };
    if (judgeService && typeof judgeService.decide === 'function') {
      try {
        const res = await judgeService.decide(
          {
            operation: 'resource',
            family,
            state: {
              op: args.op,
              target,
              purpose: args.purpose.slice(0, 2000),
              class: args.class,
              objective: objective.text,
              objective_state: objective.objective_state,
              candidates: candidates.map(({ entry: e, exists }) => ({
                id: e.id,
                path_or_id: e.path_or_id,
                class: e.class,
                created_at: e.created_at,
                last_used: e.last_used,
                exists,
              })),
            },
          },
          { signal: exec?.signal },
        );
        if (res && typeof res === 'object') judged = res;
      } catch {
        judged = { decision: 'UNSURE', unavailable: true };
      }
    }

    const warning = typeof judged.warning === 'string' && judged.warning
      ? `Note (judge.py resource): ${judged.warning}.`
      : null;
    const incomplete = objective.complete
      ? null
      : `the current objective is ${objective.goal_source ?? 'incomplete'}, so nothing is reduced`;

    const eff = svc(ctx, 'efficiency') ?? config.efficiency;
    const validIds = eff && typeof eff.validEvidenceIds === 'function'
      ? eff.validEvidenceIds(sessionId)
      : null;
    const effOverride = validateEffOverride(args, validIds);

    if (judged.decision === 'not-needed' && !incomplete) {
      if (!effOverride) {
        const why = judged.why ?? 'the task does not need this resource';
        await journal(sessionId, 'not-needed', `Resource ${args.op} ${stored}: not needed (${why})`, { unit: args.owner_task });
        const message = `${warning ? `${warning}\n` : ''}Resource ${args.op} ${target}: not needed (${why}). Nothing is created and no command is handed back; call resource again if the task turns out to need it.`;
        return {
          status: 'not-needed',
          decision: 'not-needed',
          op: args.op,
          target,
          why,
          warning,
          command: null,
          permissionGranted: false,
          message,
        };
      }
      await journal(sessionId, 'efficiency-override', `Resource ${args.op} ${stored}: not-needed overridden (${effOverride.reason})`, { unit: args.owner_task });
    }

    const pick = judged.decision === 'reuse' && !incomplete
      ? candidates.find((c) => c.entry.id === judged.candidate && c.exists === true)
      : undefined;
    if (pick) {
      const updated = await putLedger({ ...pick.entry, last_used: new Date().toISOString() });
      const why = judged.why ?? 'an existing resource serves this purpose';
      await journal(sessionId, 'reuse', `Resource ${updated.id}: reuse ${updated.path_or_id} (${why})`, { unit: args.owner_task });
      const message = `${warning ? `${warning}\n` : ''}Resource ${updated.id}: reuse ${updated.path_or_id} (${why}). Class ${updated.class}, created ${updated.created_at}. Do not create it again.`;
      return {
        status: 'reuse',
        decision: 'reuse',
        op: args.op,
        target: updated.path_or_id,
        path_or_id: updated.path_or_id,
        candidate: updated.id,
        resource: updated,
        why,
        warning,
        command: null,
        permissionGranted: false,
        message,
      };
    }

    const why = judged.decision === 'create'
      ? (judged.why ?? 'resource creation required')
      : incomplete && (judged.decision === 'not-needed' || judged.decision === 'reuse')
        ? `The judge answered ${judged.decision} (${judged.why ?? ''}), so the resource is created: ${incomplete}`
        : judged.decision === 'not-needed'
          ? `The judge answered not-needed (${judged.why ?? ''}); created under the efficiency override: ${effOverride.reason}`
          : `The judge answered ${judged.decision ?? 'UNSURE'} (${judged.why ?? ''}), so the resource is created`;

    const { efficiency_override_reason: _er, evidence_ids: _eids, ...diskArgs } = args;
    const diskWarning = await diskGate(diskArgs, { statfs: statfsFn, home });
    const raw = supplied.trim() ? supplied : args.op === 'scratch_dir' ? `mkdir -p ${shellQuote(target)}` : '';
    if (!raw) throw new Error(`resource: op ${args.op} needs the creation command in \`command\`.`);

    const notes = [];
    let command = raw;
    if (docker) {
      const d = labelDocker(raw, args.owner_task, args.class);
      command = d.command;
      if (d.pull) notes.push('docker pull cannot set labels, so this image is tracked in the ledger only.');
      if (!d.labeled && !d.pull) notes.push('no docker run, create, or build form was found to label, so this resource is tracked in the ledger only.');
    }

    const resourceId = `res-${randomBytes(6).toString('hex')}`;
    const grant = {
      id: randomUUID(),
      resourceId,
      sessionId,
      root,
      command,
      entry: {
        id: resourceId,
        machine: hostname(),
        kind: args.op,
        path_or_id: stored,
        owner_session: sessionId,
        owner_task: args.owner_task,
        class: args.class,
      },
      createdAt: Date.now(),
    };
    pending.set(`${sessionId}\0${command}`, grant);
    await journal(sessionId, 'create', `Resource ${args.op} ${stored}: create (${why})`, { unit: args.owner_task });

    const message =
      `${diskWarning ? `${diskWarning}\n` : ''}${warning ? `${warning}\n` : ''}` +
      `Resource ${args.op} ${target}: create (${why}).${notes.length ? ` ${notes.join(' ')}` : ''} ` +
      `Run this exact command with the bash tool, workdir ${root}, unchanged:\n\n${command}\n\n` +
      'The harness records created or failed from its output.';

    return {
      status: 'create',
      decision: 'create',
      op: args.op,
      target,
      why,
      warning,
      diskWarning,
      notes,
      command,
      workdir: root,
      grantId: grant.id,
      resourceId,
      permissionGranted: false,
      message,
    };
  }

  async function capture(grant, outcome = {}) {
    if (!table || !grant?.entry) return null;
    const at = new Date().toISOString();
    const created = Boolean(outcome.settled && outcome.exitCode === 0);
    const status = created ? 'created' : 'failed';
    const record = await putLedger({
      ...grant.entry,
      created_at: at,
      last_used: at,
      status,
    });
    const why = created ? `exit 0` : (outcome.why ?? `exit ${outcome.exitCode ?? 'unknown'}`);
    await journal(grant.sessionId, status, `Resource ${record.id}: ${status.toUpperCase()} (${why})`, { unit: grant.entry.owner_task });
    return record;
  }

  async function markDone(childSessionId) {
    if (!childSessionId || !table) return [];
    const updated = [];
    for (const entry of ledger()) {
      if (entry.status === 'created' && entry.owner_session === childSessionId) {
        updated.push(await putLedger({ ...entry, status: 'done' }));
      }
    }
    return updated;
  }

  const tools = svc(ctx, 'tools');
  const disposeGuard = tools?.guard?.((exec) => {
    if (exec?.name !== 'bash' || typeof exec.arguments?.command !== 'string') return undefined;
    const sessionId = exec.agent?.session?.id ?? '';
    const command = exec.arguments.command;
    const key = `${sessionId}\0${command}`;
    const grant = pending.get(key);
    if (grant) {
      if (resolve(grant.root, exec.arguments.workdir ?? '.') !== resolve(grant.root)) {
        return 'Resource grant belongs to another workspace; use its returned workdir unchanged.';
      }
      pending.delete(key);
      executing.set(exec.callId ?? key, grant);
      return undefined;
    }
    try {
      resourceRoute(command, { sessionId, pending });
    } catch (error) {
      void journal(sessionId, 'routed', error.message);
      return error.message;
    }
    return undefined;
  });

  const disposeResult = typeof ctx?.on === 'function'
    ? ctx.on('tools/result', async (exec, result) => {
        if (exec?.name !== 'bash' || !table) return;
        const sessionId = exec.agent?.session?.id ?? '';
        const key = exec.callId ?? `${sessionId}\0${exec.arguments?.command}`;
        const grant = executing.get(key);
        if (!grant) return;
        executing.delete(key);
        const value = result?.value;
        const settled = result?.isError === false
          && value?.kind === 'foreground'
          && Number.isInteger(value.exitCode)
          && value.signal === null
          && !value.aborted
          && !value.timedOut
          && resolve(value.cwd ?? '') === resolve(grant.root);
        await capture(grant, {
          settled,
          exitCode: settled ? value.exitCode : null,
          why: settled ? `native exit ${value.exitCode}` : 'execution outcome not established',
        });
      })
    : null;

  function toolDefinition() {
    return {
      name: 'resource',
      description:
        'Decide whether to create a resource (environment, download, docker image or container, scratch dir) or reuse one the ' +
        'resource ledger already holds, and record it. Never executes commands directly: on create returns the exact command ' +
        'to run with bash unchanged; on reuse returns the existing path or id. Refuses creation below 30 GB free on home unless override_reason is set.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'target', 'purpose', 'class', 'owner_task'],
        properties: {
          op: { type: 'string', enum: [...RES_OPS] },
          target: { type: 'string' },
          command: { type: 'string' },
          purpose: { type: 'string' },
          class: { type: 'string', enum: [...RES_CLASSES] },
          owner_task: { type: 'string' },
          override_reason: { type: 'string' },
          efficiency_override_reason: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      execute: (args, exec) => decide(args, exec),
    };
  }

  return {
    decide,
    decideResource: decide,
    capture,
    captureResource: capture,
    route: (command, opts) => resourceRoute(command, { ...opts, pending }),
    resourceRoute: (command, opts) => resourceRoute(command, { ...opts, pending }),
    diskGate: (args, opts) => diskGate(args, { statfs: statfsFn, home, ...opts }),
    labelDocker,
    ledger,
    markDone,
    toolDefinition,
    dispose() {
      pending.clear();
      executing.clear();
      disposeGuard?.();
      disposeResult?.();
    },
  };
}

export async function decideResource(args, execOrCtx = {}, domain, config) {
  if (execOrCtx && typeof execOrCtx.decide === 'function') return execOrCtx.decide(args);
  if (domain) return createResource(execOrCtx, domain, config).decide(args, execOrCtx);
  throw new Error('decideResource requires a resource service instance or (args, ctx, domain)');
}

export async function captureResource(resourceOrGrant, grantOrOutcome, outcome) {
  if (resourceOrGrant && typeof resourceOrGrant.capture === 'function') {
    return resourceOrGrant.capture(grantOrOutcome, outcome);
  }
  throw new Error('captureResource requires a resource service instance');
}
