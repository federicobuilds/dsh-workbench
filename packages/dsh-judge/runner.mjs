import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyEnv, resolveJudge } from '@dsh-workbench/dsh-governance/judge-registry';
export const OPERATIONS = Object.freeze(['risk','tier','dispatch','conflict','lane','route','auditor-tier','search-scope','skill','skill-index','claims','repeat','check','resource','efficiency','task-organization','memory-reminder']);
const PYTHON = legacyEnv('DSH_JUDGE_PYTHON', 'KILO_JUDGE_PYTHON') || join(homedir(), '.dsh', 'profiles', 'desktop', 'runtime', 'dsh-judge', '.venv', 'bin', 'python');
const SCRIPT = fileURLToPath(new URL('./bridge.py', import.meta.url));

/** Bounded, authorized child invocation. No credential read or inference is
 * performed by construction/readiness. Input stays on stdin, never argv. */
export function createOriginalJudge({ authorizeOperation = () => false, launch = spawn } = {}) {
  return { async decide({ operation, family, state, skills = {}, options = {} }, { signal } = {}) {
    let selected;
    let preferredJudge;
    const backend = () => selected && operation !== 'skill-index' ? { judge: selected.id, model: selected.env.JUDGE_MODEL, ...(preferredJudge ? { preferredJudge } : {}) } : {};
    const unsure = reason => ({ decision: 'UNSURE', why: reason, unavailable: true, ...backend(), permissionGranted: false });
    if (!OPERATIONS.includes(operation) || !['off','free','simple','advanced'].includes(family)) return unsure('Invalid operation or worker track');
    const input = JSON.stringify({ operation, state, skills, options });
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) return unsure('Decision envelope exceeds its limit');
    try { selected = resolveJudge(family, homedir()); } catch { return unsure('Judge registry unavailable'); }
    if (signal?.aborted) return unsure('Cancelled');
    try {
      const authorized = judge => authorizeOperation({ operation, family, judge: judge.id, external: !judge.local });
      if (operation !== 'skill-index' && await authorized(selected) !== true) {
        if (!selected.local && ['memory-reminder', 'task-organization'].includes(operation)) {
          const local = resolveJudge('simple', homedir());
          if (local.local && await authorized(local) === true) {
            preferredJudge = selected.id;
            selected = local;
          }
        }
        if (!preferredJudge) return unsure('Judge inference is not authorized');
      }
    } catch { return unsure('Judge authorization unavailable'); }
    if (signal?.aborted) return unsure('Cancelled');
    const env = { HOME: homedir(), PATH: process.env.PATH, LANG: process.env.LANG ?? 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
    for (const [key, value] of Object.entries(selected.env)) if (/^(JUDGE_|JEV_|TYPESAFE_BASE_URL$)/.test(key) && typeof value === 'string') env[key] = value;
    return new Promise(resolve => {
      const chunks = []; let bytes = 0, finished = false, timer, terminationTimer, stopping;
      const done = result => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(terminationTimer); signal?.removeEventListener('abort', abort); resolve(result); };
      let child;
      const terminate = reason => {
        if (finished || stopping) return;
        stopping = reason;
        clearTimeout(timer);
        terminationTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          if (!finished) terminationTimer = setTimeout(() => done({ ...unsure(reason), terminationObserved: false }), 100);
        }, 100);
        try { child.kill('SIGTERM'); } catch {}
      };
      const abort = () => terminate('Cancelled');
      try { child = launch(PYTHON, [SCRIPT], { env, stdio: ['pipe','pipe','pipe'], windowsHide: true }); }
      catch { done(unsure('Judge interpreter unavailable')); return; }
      timer = setTimeout(() => terminate('Judge deadline expired'), selected.processTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => terminate('Judge process failed'));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { terminate('Judge output exceeds its limit'); return; }
        if (!finished) chunks.push(Buffer.from(chunk));
      });
      // Consume but never expose private process/SDK diagnostics.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => terminate('Judge input failed'));
      child.on('close', (code, closeSignal) => {
        if (stopping) { done({ ...unsure(stopping), terminationObserved: true, closeSignal: closeSignal ?? null }); return; }
        if (code !== 0) { done(unsure('Judge process did not complete')); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || typeof value.decision !== 'string') throw new Error();
          done({ ...value, ...backend(), permissionGranted: false });
        } catch { done(unsure('Judge returned invalid output')); }
      });
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
  } };
}
