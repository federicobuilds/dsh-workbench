import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const ARCHIVE_DIRECTORY = /(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i;
const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'patch', 'delete_file', 'move_file', 'notebook_edit']);

/** Interpret explicit no-write constraints conservatively, without granting any new permission. */
export function briefIsReadOnly(brief) {
  const fields = [brief?.changes, brief?.constraints, brief?.scope].flat().filter(value => typeof value === 'string').join('\n');
  return /\bread[- ]only\b|\bno\s+(?:file\s+)?writes?\b|\bdo not\s+(?:write|edit|modify)\s+(?:any\s+)?files?\b/i.test(fields);
}

/** Reject virtual archive paths before Electron's patched filesystem can label them directories. */
export async function nativeWorkingDirectory(value, io = { realpath, stat }) {
  if (typeof value !== 'string' || !isAbsolute(value) || ARCHIVE_DIRECTORY.test(value)) throw new Error('Worker cwd must be a real operating-system directory, not an app.asar path');
  const resolved = await io.realpath(value);
  if (ARCHIVE_DIRECTORY.test(resolved) || !(await io.stat(resolved)).isDirectory()) throw new Error('Worker cwd is not a real operating-system directory');
  return resolved;
}

/** Prevent model tools from widening an admitted read-only brief or directly editing files. */
export function readOnlyToolRefusal(exec) {
  if (MUTATING_TOOLS.has(exec?.name)) return 'Read-only worker brief: file mutation is not authorized. Return findings to the coordinator instead.';
  const args = exec?.arguments ?? {};
  if (exec?.name === 'background_process' && !['list', 'status', 'logs'].includes(args.action)) return 'Read-only worker brief: starting, restarting or stopping background processes is not authorized.';
  if (args.dangerouslyDisableSandbox === true || args.sandbox_permissions === 'require_escalated' || ['danger-full-access', 'workspace-write'].includes(args.sandboxMode ?? args.sandbox ?? args.mode)) return 'Read-only worker brief: sandbox escalation is not authorized.';
  return null;
}

/** Recognize a virtual archive cwd in direct working-directory and shell tool arguments. */
export function archiveCwdRefusal(exec) {
  const args = exec?.arguments ?? {};
  const value = exec?.name === 'working_directory' ? args.cd : ['bash', 'background_process'].includes(exec?.name) ? args.workdir ?? args.cwd : undefined;
  return typeof value === 'string' && ARCHIVE_DIRECTORY.test(value) ? 'Use a real workspace directory. Paths inside app.asar are readable resources, not valid shell or worker working directories.' : null;
}
