import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { escapeHtml, hashPattern, normalizeRecord, parseRecord, projectText, renderRecord, sha } from './html-record.mjs';

const helper = fileURLToPath(new URL('./html-store.py', import.meta.url));
const storeName = '.shared-memory-html';
const maximum = 160 << 20;
const checkedHash = value => {
  if (typeof value !== 'string' || !hashPattern.test(value)) throw new Error('An exact SHA-256 revision is required.');
  return value;
};

function operation(root, name, request = {}) {
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > maximum) throw new Error('Memory operation exceeds its size limit.');
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helper, name, root], { stdio: ['pipe', 'pipe', 'ignore'] });
    const output = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maximum) child.kill();
      else output.push(chunk);
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('error', reject);
    child.on('close', code => {
      try {
        const result = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (size > maximum || code !== 0 || result.error) throw new Error(result.error ?? 'Memory storage operation failed.');
        if (result.conflict) {
          throw Object.assign(new Error('Memory changed. Read the current revision before retrying.'), {
            code: 'MEMORY_REVISION_CONFLICT', revision: result.revision,
          });
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(body);
  });
}

function validateRelationships(records) {
  const ids = new Set(records.map(record => record.id));
  if (ids.size !== records.length) throw new Error('Duplicate memory record ID.');
  for (const record of records) {
    for (const related of record.related) {
      if (!ids.has(related)) throw new Error(`Unknown related record ${related} in ${record.id}.`);
    }
  }
}

function encodeRevision({ projectId, parent, author, reason, evidence, records, migration = null }) {
  validateRelationships(records);
  const files = Object.fromEntries(records.map(record => [`${record.id}.html`, renderRecord(record)]));
  const descriptor = {
    schema: 1, projectId, parent, createdAt: new Date().toISOString(),
    author, reason, evidence, migration,
    files: Object.fromEntries(Object.entries(files).map(([name, html]) => [name, sha(html)])),
  };
  const manifest = JSON.stringify(descriptor);
  return { revision: sha(manifest), manifest, files };
}

function decodeRevision(state, revision) {
  if (sha(state.manifest) !== revision) throw new Error('Memory revision failed its manifest hash check.');
  const descriptor = JSON.parse(state.manifest);
  if (descriptor.schema !== 1 || typeof descriptor.projectId !== 'string'
    || !Array.isArray(descriptor.evidence) || (descriptor.parent !== null && !hashPattern.test(descriptor.parent))) {
    throw new Error('Unsupported memory revision manifest.');
  }
  const records = Object.entries(state.files).map(([file, html]) => {
    if (sha(html) !== descriptor.files[file]) throw new Error(`Memory document ${file} changed outside its revision.`);
    const record = parseRecord(html);
    if (`${record.id}.html` !== file) throw new Error('Memory record ID does not match its filename.');
    return record;
  });
  validateRelationships(records);
  return { descriptor, records, revision };
}

function valueList(value, label) {
  if (!Array.isArray(value) || value.length > 100 || !value.length
    || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) {
    throw new Error(`Provide bounded ${label}.`);
  }
  return value;
}

function provenance(request) {
  const { author, reason, evidence } = request;
  if (typeof author !== 'string' || !author.trim() || author.length > 120
    || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
    throw new Error('Provide an author and reason for this revision.');
  }
  return { author, reason, evidence: valueList(evidence, 'evidence references') };
}

function sourceBaseline(snapshot) {
  return sha(JSON.stringify({
    files: snapshot.docs.map(doc => [doc.rel, doc.sha256]).sort((a, b) => a[0].localeCompare(b[0])),
    companion: snapshot.readable.sha256,
  }));
}

function migratedRecord(snapshot, doc) {
  const readable = snapshot.readable.docs.get(doc.id);
  return normalizeRecord({
    id: doc.id,
    title: doc.title,
    summary: readable?.explanation,
    details: doc.raw,
    source: doc.rel,
    evidence: [...doc.raw.matchAll(/<!-- memory-evidence: (dsh-chat\/[\w.-]+\/[\w:.-]+) -->/g)].map(match => match[1]).slice(0, 100),
    status: 'reference',
    sections: snapshot.model.sections.filter(section => section.docId === doc.id && section.id !== doc.id)
      .map(section => ({
        id: section.id,
        title: section.heading,
        summary: readable?.sections.get(section.id)?.explanation ?? '',
        details: section.text,
      })),
  });
}

export async function stageHtmlMemory(project, options, legacy) {
  const source = await legacy.buildMemorySnapshot(project);
  const current = await operation(source.root, 'read');
  if (current.head) throw new Error('This project already uses HTML memory.');
  if (source.census.unavailable.length) throw new Error('Some source files are unavailable. Reconcile them before migration.');
  if (source.readable.state === 'invalid' || source.readable.stale.length) {
    throw new Error('Reconcile invalid or stale companion entries before migration.');
  }
  const records = source.docs.map(doc => migratedRecord(source, doc));
  const mapping = source.docs.map(doc => ({
    path: doc.rel, kind: doc.kind, id: doc.id, sha256: doc.sha256,
    sections: source.model.sections.filter(section => section.docId === doc.id).map(section => section.id),
    facts: source.model.facts.filter(fact => fact.docId === doc.id).map(fact => ({
      id: fact.id, explanation: source.readable.docs.get(doc.id)?.facts.get(fact.id) ?? null,
    })),
    timeline: source.model.timeline.filter(row => row.docId === doc.id).map(row => ({
      line: row.line, text: source.readable.docs.get(doc.id)?.records.get(row.line) ?? '',
    })),
  }));
  const migration = {
    sourceBaseline: sourceBaseline(source), mapping, excluded: source.census.excluded,
    redactions: source.census.redactions, orphanedExplanations: source.readable.orphaned,
    otherTypes: source.census.otherTypes,
  };
  const next = encodeRevision({
    projectId: source.projectId, parent: null, records, migration,
    ...provenance(options),
  });
  await operation(source.root, 'stage', { expected: null, ...next });
  const staged = await operation(source.root, 'read', { revision: next.revision });
  decodeRevision(staged, next.revision);
  return {
    project: source.project, stagedRevision: next.revision, documents: records.length, ...migration,
  };
}

export async function activateHtmlMemory(project, revision, legacy) {
  checkedHash(revision);
  const source = await legacy.buildMemorySnapshot(project);
  const current = await operation(source.root, 'read', { revision });
  const { descriptor } = decodeRevision(current, revision);
  if (!descriptor.migration || descriptor.migration.sourceBaseline !== sourceBaseline(source)) {
    throw new Error('Markdown or its companion changed after staging. Stage a fresh revision.');
  }
  if (source.census.unavailable.length) throw new Error('Some source files are unavailable.');
  await operation(source.root, 'activate', { expected: null, revision });
  try {
    return await publishHtmlMemory(source, revision);
  } catch (error) {
    return { revision, saved: true, published: false, error: error.message };
  }
}

export async function updateHtmlMemory(project, request, legacy) {
  const expected = checkedHash(request.expectedRevision);
  const root = await legacy.memoryRootOf(project);
  const state = await operation(root.root, 'read');
  if (state.head !== expected) {
    throw Object.assign(new Error('Memory changed. Read the current revision before retrying.'), {
      code: 'MEMORY_REVISION_CONFLICT', revision: state.head,
    });
  }
  const current = decodeRevision(state, expected);
  if (!Array.isArray(request.changes) || !request.changes.length || request.changes.length > 100) {
    throw new Error('Provide one to 100 complete changed records.');
  }
  const records = new Map(current.records.map(record => [record.id, record]));
  const changes = request.changes.map(normalizeRecord);
  if (new Set(changes.map(record => record.id)).size !== changes.length) throw new Error('Duplicate changed record ID.');
  for (const record of changes) records.set(record.id, record);
  const next = encodeRevision({
    projectId: current.descriptor.projectId, parent: expected, records: [...records.values()],
    ...provenance(request),
  });
  await operation(root.root, 'commit', { expected, ...next });
  try {
    return await publishHtmlMemory(root, next.revision);
  } catch (error) {
    return { revision: next.revision, saved: true, published: false, error: error.message };
  }
}

export async function readHtmlSnapshot(root) {
  const state = await operation(root.root, 'read');
  if (!state.head) return null;
  const { descriptor, records, revision } = decodeRevision(state, state.head);
  const docs = records.map(record => ({
    id: record.id, rel: `${record.id}.html`, title: record.title, kind: 'markdown', format: 'html',
    raw: projectText(record), sha256: descriptor.files[`${record.id}.html`], mtime: descriptor.createdAt,
  }));
  const sections = records.flatMap(record => record.sections.map(section => ({
    docId: record.id, rel: `${record.id}.html`, id: section.id, heading: section.title, level: 2,
    line: null, text: [section.summary, section.details].filter(Boolean).join('\n\n'),
  })));
  const snapshot = {
    ...root, format: 'html', projectId: descriptor.projectId, sourceHash: revision, docs, model: { sections },
    records, descriptor,
  };
  return {
    ...snapshot,
    published: state.publication === revision && state.viewer === renderViewer(snapshot)
      && state.index === JSON.stringify(viewerIndex(snapshot)),
  };
}

export function validateHtmlSnapshot(snapshot) {
  return {
    complete: snapshot.published, project: snapshot.project, projectId: snapshot.projectId,
    sourceHash: snapshot.sourceHash, format: 'html', counts: { docs: snapshot.docs.length, sections: snapshot.model.sections.length },
    missingCount: Number(!snapshot.published),
    missing: snapshot.published ? [] : [{ kind: 'publication', reason: 'stale-or-incomplete' }],
  };
}

function viewerIndex({ descriptor, records, sourceHash }) {
  return {
    schema: 1, revision: sourceHash, previousRevision: descriptor.parent, date: descriptor.createdAt,
    projectId: descriptor.projectId, author: descriptor.author, reason: descriptor.reason, evidence: descriptor.evidence,
    records: records.map(({ id, title, summary, source, status, verifiedAt, related }) =>
      ({ id, title, summary, source, status, verifiedAt, related })),
  };
}

function renderViewer(snapshot) {
  const e = escapeHtml;
  const source = record => {
    if (!record.source) return '';
    const value = record.source;
    if (/^https?:\/\//i.test(value)) {
      return `<p><a href="${e(value)}" rel="noreferrer">Open source</a></p>`;
    }
    if (snapshot.descriptor.migration?.mapping.some(item => item.path === value)) {
      const link = '../' + value.split('/').map(encodeURIComponent).join('/');
      return `<p><a href="${e(link)}">Open original source</a></p>`;
    }
    return `<p>Source <code>${e(value)}</code></p>`;
  };
  const row = record => `<article id="${e(record.id)}"><h2>${e(record.title)}</h2><p class="meta">${e(record.status)}${record.verifiedAt ? ` · Verified ${e(record.verifiedAt)}` : ''}</p><p>${e(record.summary)}</p>${source(record)}<details><summary>Details</summary><pre>${e(projectText(record))}</pre></details></article>`;
  const active = snapshot.records.filter(record => ['active', 'blocked'].includes(record.status));
  const others = snapshot.records.filter(record => !active.includes(record));
  const { descriptor, sourceHash } = snapshot;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="memory-source-hash" content="${sourceHash}"><title>Shared Memory</title>
<style>
:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif}body{max-width:75rem;margin:3rem auto;padding:0 1.25rem}header{border-bottom:1px solid GrayText;padding-bottom:1.25rem;margin-bottom:2rem}h1{font-size:2.4rem;margin:0}h2{margin:.25rem 0}small,.meta{color:GrayText}input{font:inherit;padding:.55rem .8rem;width:min(25rem,90%);border:1px solid GrayText;border-radius:.4rem}article{border:1px solid GrayText;border-radius:.55rem;padding:1.1rem;margin:1rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.92rem}details{margin-top:.8rem}summary{cursor:pointer}code{overflow-wrap:anywhere}
</style><body><header><h1>Shared Memory</h1><p class="meta">Offline snapshot · ${e(descriptor.createdAt)} · ${e(descriptor.author)}</p><p>${e(descriptor.reason)}</p><small>Revision <code>${sourceHash}</code></small></header>
<label for="filter">Search memory</label><br><input id="filter" type="search" autocomplete="off">
<section><h2>Active tasks</h2>${active.length ? active.map(row).join('') : '<p class="meta">No active task records.</p>'}</section>
<section><h2>Records</h2>${others.map(row).join('')}</section>
<section><h2>Revision evidence</h2><ul>${descriptor.evidence.map(item => `<li>${e(item)}</li>`).join('')}</ul></section>
<script>document.querySelector('#filter').addEventListener('input',event=>{const q=event.target.value.toLowerCase().trim();for(const item of document.querySelectorAll('article')) item.hidden=!item.textContent.toLowerCase().includes(q)})</script></body></html>`;
}

export async function publishHtmlMemory(root, expected) {
  const snapshot = await readHtmlSnapshot(root);
  if (!snapshot || (expected && expected !== snapshot.sourceHash)) throw new Error('HTML authority changed before publication.');
  const path = join(root.root, storeName, 'memory.html');
  if (!snapshot.published) {
    await operation(root.root, 'publish', {
      expected: snapshot.sourceHash, viewer: renderViewer(snapshot), index: JSON.stringify(viewerIndex(snapshot)),
    });
  }
  return { revision: snapshot.sourceHash, saved: true, published: true, written: !snapshot.published, path };
}

export async function rollbackHtmlMemory(project, revision, legacy, recoveryPath) {
  const expected = checkedHash(revision);
  const root = await legacy.memoryRootOf(project);
  const state = await operation(root.root, 'read');
  if (state.head !== expected) throw new Error('HTML authority changed before rollback.');
  const current = decodeRevision(state, expected);
  let migration = current;
  while (!migration.descriptor.migration && migration.descriptor.parent) {
    const parent = migration.descriptor.parent;
    migration = decodeRevision(await operation(root.root, 'read', { revision: parent }), parent);
  }
  if (!migration.descriptor.migration) throw new Error('No migration receipt was found.');
  const source = await legacy.buildMemorySnapshot(project);
  if (sourceBaseline(source) !== migration.descriptor.migration.sourceBaseline) {
    throw new Error('The Markdown rollback sources changed after migration.');
  }
  if (migration.revision !== expected) {
    if (typeof recoveryPath !== 'string' || !isAbsolute(recoveryPath)) {
      throw new Error('Supply an absolute recovery file to export HTML-era changes before rollback.');
    }
    await writeFile(recoveryPath, JSON.stringify({
      projectId: current.descriptor.projectId, revision: expected, descriptor: current.descriptor, records: current.records,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  await operation(root.root, 'rollback', { expected, revision });
  return { format: 'markdown', preservedHtmlRevision: expected, ...(recoveryPath ? { recoveryPath } : {}), ...await legacy.refreshMemoryHtml(project).then(({ path, written }) => ({ path, written })) };
}

export function readProjectReminders(root) {
  return operation(root.root, 'reminders-read');
}

export function writeProjectReminders(root, expected, records) {
  if (expected !== null) checkedHash(expected);
  return operation(root.root, 'reminders-write', { expected, records });
}
