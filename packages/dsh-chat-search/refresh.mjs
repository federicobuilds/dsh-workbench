import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export const defaults = {
  dbPath: join(homedir(), '.dsh/chat-index.db'),
  sessionsRoot: join(homedir(), '.dsh/sessions'),
  mcpDir: '',
  pythonPath: '',
  embedBackend: 'openai',
  embedBaseUrl: 'http://127.0.0.1:11434/v1',
  embedModel: 'embeddinggemma:300m',
  autoUpdateOnTurnEnd: false,
  timeoutMs: 300_000,
};

const updateScript = String.raw`
import contextlib, json, re, sys
try:
    with contextlib.redirect_stdout(sys.stderr):
        import indexer
        result = indexer.update_index()
    fields = ('added', 'updated', 'removed', 'unchanged', 'failed')
    if not isinstance(result, dict) or any(type(result.get(k)) is not int or not 0 <= result[k] <= 9007199254740991 for k in fields):
        raise ValueError()
    if result.get('coverage') not in ('current', 'incomplete') or not isinstance(result.get('failures'), list):
        raise ValueError()
    failures = []
    for failure in result['failures'][:8]:
        if not isinstance(failure, dict) or not isinstance(failure.get('session'), str) or not isinstance(failure.get('reason'), str):
            raise ValueError()
        session = failure['session'] if re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', failure['session']) else None
        match = re.match(r'^(PermissionError|FileNotFoundError|ModuleNotFoundError|ImportError)(?::|$)', failure['reason'])
        failures.append({'session': session, 'reason': match.group(1) if match else 'other'})
    stats = {k: result[k] for k in fields}
    stats.update(failures=failures, coverage=result['coverage'])
    if len(failures) > stats['failed']:
        raise ValueError()
    print(json.dumps(stats, separators=(',', ':')))
except Exception:
    print('{"error":"invalid-result"}')
    sys.exit(1)
sys.exit(1 if stats['failed'] or stats['coverage'] != 'current' else 0)
`;

function parseStats(output) {
  try {
    const stats = JSON.parse(output.toString());
    const keys = ['added', 'updated', 'removed', 'unchanged', 'failed', 'failures', 'coverage'];
    if (!stats || Array.isArray(stats) || typeof stats !== 'object' ||
        Object.keys(stats).length !== keys.length || keys.some(key => !Object.hasOwn(stats, key)) ||
        keys.slice(0, 5).some(key => !Number.isSafeInteger(stats[key]) || stats[key] < 0) ||
        !['current', 'incomplete'].includes(stats.coverage) || !Array.isArray(stats.failures) ||
        stats.failures.length > 8 || stats.failures.length > stats.failed) return null;
    const reasons = ['PermissionError', 'FileNotFoundError', 'ModuleNotFoundError', 'ImportError', 'other'];
    if (stats.failures.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).length !== 2 || !Object.hasOwn(item, 'session') || !Object.hasOwn(item, 'reason') ||
        (item.session !== null && (typeof item.session !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(item.session))) ||
        !reasons.includes(item.reason))) return null;
    return stats;
  } catch { return null; }
}

function configurationError(config) {
  for (const key of ['mcpDir', 'pythonPath', 'sessionsRoot', 'dbPath']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) return key;
  }
  try {
    if (!statSync(config.mcpDir).isDirectory()) return 'mcpDir';
  } catch { return 'mcpDir'; }
  try {
    if (!statSync(config.pythonPath).isFile()) return 'pythonPath';
    accessSync(config.pythonPath, constants.X_OK);
  } catch { return 'pythonPath'; }
  try {
    if (!statSync(config.sessionsRoot).isDirectory()) return 'sessionsRoot';
  } catch { return 'sessionsRoot'; }
  try {
    if (!statSync(dirname(config.dbPath)).isDirectory()) return 'dbPath';
    try {
      if (!statSync(config.dbPath).isFile()) return 'dbPath';
    } catch (error) {
      if (error.code !== 'ENOENT') return 'dbPath';
    }
  } catch { return 'dbPath'; }
  return null;
}

export function startRefresh(ctx, config, launch = spawn) {
  let status = { state: 'disabled' };
  let child = null;
  let queued = false;
  let disposed = false;
  let deadline;
  let killTimer;
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 && config.timeoutMs <= 2_147_483_647
    ? config.timeoutMs : defaults.timeoutMs;
  const terminate = owned => {
    clearTimeout(deadline);
    if (killTimer) return;
    killTimer = setTimeout(() => {
      if (child === owned) {
        try { owned.kill('SIGKILL'); } catch { /* The process may have exited. */ }
      }
    }, 2000);
    killTimer.unref?.();
    try { owned.kill('SIGTERM'); } catch { status = { ...status, reason: 'kill-error' }; }
  };
  let unsubscribe;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    queued = false;
    unsubscribe?.();
    status = { ...status, state: 'disposed' };
    if (child) terminate(child);
  };
  Object.defineProperty(dispose, 'status', { get: () => structuredClone(status) });

  if (config.autoUpdateOnTurnEnd !== true) return dispose;

  const invalid = configurationError(config);
  status = invalid ? { state: 'configuration-error', field: invalid } : { state: 'idle' };

  const run = () => {
    if (disposed) return;
    if (child) { queued = true; return; }
    const invalid = configurationError(config);
    if (invalid) { status = { state: 'configuration-error', field: invalid }; return; }
    let owned;
    try {
      owned = launch(config.pythonPath, ['-c', updateScript], {
        cwd: config.mcpDir,
        env: { ...process.env, DSH_CHAT_INDEX_DB: config.dbPath, DSH_SESSIONS_DIR: config.sessionsRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      status = { state: 'failed', reason: 'spawn-error' };
      return;
    }
    child = owned;
    const last = status.state === 'failed' ? status : status.last;
    status = last ? { state: 'running', last } : { state: 'running' };
    let failed = false;
    let timedOut = false;
    deadline = setTimeout(() => {
      if (child !== owned || disposed) return;
      timedOut = true;
      status = { state: 'failed', reason: 'timeout' };
      terminate(owned);
    }, timeoutMs);
    deadline.unref?.();
    let stdout = Buffer.alloc(0);
    let stdoutTruncated = false;
    owned.stdout.on('data', chunk => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutTruncated ||= data.length > 4096 - stdout.length;
      stdout = Buffer.concat([stdout, data.subarray(0, 4096 - stdout.length)]);
    });
    let stderr = Buffer.alloc(0);
    let stderrTruncated = false;
    owned.stderr.on('data', chunk => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTruncated ||= data.length > 4096 - stderr.length;
      stderr = Buffer.concat([stderr, data.subarray(0, 4096 - stderr.length)]);
    });
    const diagnostic = () => {
      const kind = /(?:^|\n)(PermissionError|FileNotFoundError|ModuleNotFoundError|ImportError):/.exec(stderr.toString());
      return { stderrBytes: stderr.length, stderrTruncated, stderrKind: kind?.[1] ?? (stderr.length ? 'other' : 'none') };
    };
    owned.on('error', () => {
      if (child !== owned) return;
      failed = true;
      if (!disposed) status = { state: 'failed', reason: 'child-error', ...diagnostic() };
    });
    owned.once('close', (code, signal) => {
      if (child !== owned) return;
      child = null;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      killTimer = undefined;
      if (disposed) return;
      const stats = stdoutTruncated ? null : parseStats(stdout);
      const reason = timedOut ? 'timeout' : failed ? 'child-error' : signal ? 'signal' : code !== 0 ? 'nonzero-exit' :
        !stats ? 'invalid-status' : stats.failed ? 'failed-index' :
        stats.coverage !== 'current' ? 'incomplete-coverage' : null;
      status = { state: reason ? 'failed' : 'ok', ...(reason && { reason }),
        ...(stats && { stats }), ...diagnostic() };
      if (queued) { queued = false; run(); }
    });
  };
  unsubscribe = ctx.on('session/event', (_session, event) => {
    if (event?.type === 'turn/end') run();
  });
  ctx.effect?.(() => dispose);
  return dispose;
}
