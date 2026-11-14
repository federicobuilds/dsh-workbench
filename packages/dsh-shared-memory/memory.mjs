import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  activateHtmlMemory as activate,
  publishHtmlMemory,
  readHtmlSnapshot,
  readProjectReminders as readReminders,
  rollbackHtmlMemory as rollback,
  stageHtmlMemory as stage,
  updateHtmlMemory as update,
  validateHtmlSnapshot,
  writeProjectReminders as writeReminders,
} from './html-memory.mjs';

const exec = promisify(execFile);
const MAX_DOCUMENT = 16_000;
const MAX_RESULTS = 20;

function missing(error) {
  if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  return null;
}

function requireAbsolute(project) {
  if (typeof project !== 'string' || !isAbsolute(project)) {
    throw new Error('Choose a project by its absolute root path.');
  }
  return project;
}

async function loadLegacyEngine() {
  const engineRoot = join(homedir(), '.config', 'kilo', 'harness', 'memory');
  const enginePath = join(engineRoot, 'index.mjs');
  if (!await lstat(enginePath).catch(missing)) {
    return import('@dsh-workbench/dsh-governance/memory-preview');
  }
  const [engine, format] = await Promise.all([
    import(pathToFileURL(enginePath).href),
    import(pathToFileURL(join(engineRoot, 'format.mjs')).href),
  ]);
  return { ...engine, ...format };
}


export async function loadMemoryEngine() {
  const legacy = await loadLegacyEngine();
  return {
    memoryRootOf: legacy.memoryRootOf,
    async buildMemorySnapshot(project) {
      return await readHtmlSnapshot(await legacy.memoryRootOf(project)) ?? legacy.buildMemorySnapshot(project);
    },
    validateSnapshot(snapshot) {
      return snapshot.format === 'html' ? validateHtmlSnapshot(snapshot) : legacy.validateSnapshot(snapshot);
    },
    async refreshMemoryHtml(project) {
      const root = await legacy.memoryRootOf(project);
      const snapshot = await readHtmlSnapshot(root);
      return snapshot ? publishHtmlMemory(root, snapshot.sourceHash) : legacy.refreshMemoryHtml(project);
    },
  };
}

export async function stageHtmlMemory(project, options) {
  return stage(requireAbsolute(project), options, await loadLegacyEngine());
}

export async function activateHtmlMemory(project, revision) {
  return activate(requireAbsolute(project), revision, await loadLegacyEngine());
}

export async function updateHtmlMemory(project, request) {
  return update(requireAbsolute(project), request, await loadLegacyEngine());
}

export async function rollbackHtmlMemory(project, revision, recoveryPath) {
  return rollback(requireAbsolute(project), revision, await loadLegacyEngine(), recoveryPath);
}

export async function resolveSessionProject(session, currentDirectory, engine, signal) {
  const cwd = session?.header?.cwd ?? currentDirectory;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  const candidates = [];
  const gitOptions = { cwd, signal, timeout: 2_000, maxBuffer: 64 * 1024 };
  try {
    const { stdout } = await exec('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], gitOptions);
    const [top, common] = stdout.trimEnd().split('\n');
    if (common && isAbsolute(common) && basename(common) === '.git') {
      const main = dirname(common);
      const metadata = await lstat(join(main, '.git')).catch(missing);
      if (metadata?.isDirectory()) candidates.push(main);
    }
    if (isAbsolute(top)) candidates.push(top);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  for (const candidate of new Set([...candidates, cwd])) {
    const root = await engine.memoryRootOf(candidate).catch(missing);
    if (root) return root.project;
  }
  return null;
}

function reference(doc) {
  return {
    id: doc.id,
    path: doc.rel,
    title: doc.title,
    sha256: doc.sha256,
    modifiedAt: doc.mtime,
  };
}

export async function sharedMemory(project, { action = 'index', selector, query, offset = 0 } = {}, engine) {
  requireAbsolute(project);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Use a nonnegative integer offset.');
  engine ??= await loadMemoryEngine();
  const snapshot = await engine.buildMemorySnapshot(project);
  const status = engine.validateSnapshot(snapshot);
  const base = {
    project: snapshot.project,
    projectId: snapshot.projectId,
    revision: snapshot.sourceHash,
    verified: status.complete,
    format: snapshot.format ?? 'markdown',
    ...(!status.complete ? { pending: status.missingCount } : {}),
  };
  if (action === 'verify') return { ...base, ...status };
  if (action === 'resume') {
    if (!snapshot.records) {
      return sharedMemory(project, selector
        ? { action: 'search', query: selector, offset }
        : { action: 'index', offset }, engine);
    }
    const candidates = snapshot.records.filter(record => record.task && (
      selector ? record.id === selector : ['active', 'blocked'].includes(record.status)));
    if (!candidates.length && selector) throw new Error('Choose an exact task ID from the memory index.');
    const toSummary = ({ id, title, summary, source, status, verifiedAt }) =>
      ({ id, title, summary, source, status, verifiedAt });
    if (candidates.length === 1) {
      const record = candidates[0];
      return { ...base, task: { ...toSummary(record), ...record.task, related: record.related } };
    }
    return { ...base, tasks: candidates.slice(offset, offset + MAX_RESULTS).map(toSummary) };
  }
  const markdown = snapshot.docs.filter(doc => doc.kind === 'markdown');
  const documents = new Map(markdown.map(doc => [doc.id, doc]));
  const sections = snapshot.model.sections.filter(section => section.level > 0 && documents.has(section.docId));
  const sectionReference = section => ({
    id: section.id, path: section.rel, title: section.heading, line: section.line,
    documentId: section.docId, sha256: documents.get(section.docId).sha256,
    modifiedAt: documents.get(section.docId).mtime,
  });
  if (action === 'read') {
    const doc = markdown.find(doc => doc.id === selector || doc.rel === selector);
    const section = sections.find(section => section.id === selector);
    if (!doc && !section) throw new Error('Choose an exact document or section ID or a document path.');
    const end = offset + MAX_DOCUMENT;
    const content = doc ? doc.raw : section.text;
    return {
      ...base,
      ...(doc ? {
        document: { ...reference(doc), markdown: content.slice(offset, end) },
        sections: sections.filter(section => section.docId === doc.id).slice(0, 40).map(sectionReference),
      } : { section: { ...sectionReference(section), markdown: content.slice(offset, end) } }),
      nextOffset: end < content.length ? end : null,
    };
  }
  if (action !== 'index' && action !== 'search') throw new Error('Choose index, search, read, or verify.');
  const needle = String(query ?? '').trim().toLowerCase();
  if (action === 'search' && !needle) throw new Error('Enter a search term.');
  const results = action === 'index' ? markdown.map(reference) : [
    ...sections.filter(section => section.heading.toLowerCase().includes(needle)).map(sectionReference),
    ...markdown.filter(doc => doc.rel.toLowerCase().includes(needle)
      || doc.raw.toLowerCase().includes(needle)).map(reference),
  ];
  const page = results.slice(offset, offset + MAX_RESULTS);
  const index = markdown.find(doc => doc.rel === 'INDEX.md');
  return {
    ...base,
    ...(action === 'index' && offset === 0 && index ? { overview: index.raw.slice(0, 4_000) } : {}),
    ...(action === 'index' ? { documents: page } : { matches: page }),
    nextOffset: offset + page.length < results.length ? offset + page.length : null,
  };
}

export async function publishMemory(project) {
  requireAbsolute(project);
  const engine = await loadMemoryEngine();
  const { path, written } = await engine.refreshMemoryHtml(project);
  return { path, written, ...await sharedMemory(project, { action: 'verify' }, engine) };
}

export async function readProjectReminders(project) {
  return readReminders(await (await loadLegacyEngine()).memoryRootOf(requireAbsolute(project)));
}

export async function writeProjectReminders(project, expectedRevision, records) {
  return writeReminders(await (await loadLegacyEngine()).memoryRootOf(requireAbsolute(project)), expectedRevision, records);
}
