import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT } from './remote.mjs';

export const name = 'dsh-appshots';
export const inject = ['typert'];

const run = promisify(execFile);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxImageBytes = 10 * 1024 * 1024;
let capturing = false;

export async function captureMacWindow(signal, execute = run) {
  if (process.platform !== 'darwin') throw new Error('Native window capture requires macOS.');
  if (capturing) throw new Error('Finish or cancel the current window capture first.');
  capturing = true;
  let directory;
  try {
    signal?.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), 'dsh-appshot-'));
    const path = join(directory, 'window.png');
    try {
      await execute('/usr/sbin/screencapture', ['-i', '-w', '-o', '-x', '-t', 'png', path], {
        signal,
        timeout: 90_000,
        maxBuffer: 8192,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error.killed) throw new Error('The capture timed out. Open the picker again.');
      throw new Error('Window capture did not complete. Check macOS Screen Recording permission or open an existing screenshot.');
    }
    const metadata = await stat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!metadata) return null;
    if (metadata.size > maxImageBytes) throw new Error('The capture exceeds 10 MB. Open a smaller screenshot.');
    const data = await readFile(path, { signal });
    if (!data.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error('The capture did not produce a PNG.');
    return data.toString('base64');
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      capturing = false;
    }
  }
}

export function apply(ctx) {
  const initializers = [];
  class AppshotsService extends TypertRemoteService {
    constructor() {
      super(ctx, 'workbenchAppshots');
      for (const initialize of initializers) initialize.call(this);
    }

    async capture(signal) {
      if (!this.ctx.invocation || principalOf(this.ctx.invocation) !== undefined) {
        throw new RemoteError('gateway/bad-request', 'Only the owner UI may start a window capture.');
      }
      try {
        return await captureMacWindow(signal);
      } catch (error) {
        signal?.throwIfAborted();
        throw new RemoteError('gateway/bad-request', error.message);
      }
    }
  }
  Remote(AppshotsService.prototype.capture, {
    kind: 'method', name: 'capture', static: false, private: false,
    addInitializer(fn) { initializers.push(fn); },
  });
  ctx.get('typert').register(TYPERT);
  new AppshotsService();
}
