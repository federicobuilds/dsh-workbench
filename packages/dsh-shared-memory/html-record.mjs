import { createHash } from 'node:crypto';

export const sha = data => createHash('sha256').update(data).digest('hex');
export const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const statuses = new Set(['active', 'blocked', 'complete', 'reference']);
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const escapable = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const encoded = Object.fromEntries(Object.entries(escapable).map(([key, value]) => [value, key]));
export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => escapable[character]);
const unescapeHtml = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => encoded[entity]);

function text(value, label, maximum, { optional = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || control.test(value)
    || (!optional && !value.trim())) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function object(value, allowed, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label}.`);
  return value;
}

function identifier(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Invalid memory record or section ID.');
  return value;
}

function link(value) {
  if (typeof value !== 'string' || value.length > 2000 || control.test(value)
    || !value.trim() || /^(?:\/\/|\\)/.test(value)
    || (/^[\s]*[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value))) {
    throw new Error('Use an HTTP(S) URL or a project source reference.');
  }
  return value;
}

export function normalizeRecord(input) {
  object(input, ['id', 'title', 'summary', 'details', 'source', 'task', 'sections', 'status', 'verifiedAt', 'related', 'evidence'], 'memory record');
  const {
    id, title, summary, details, source = '', task = null, sections = [],
    status = 'reference', verifiedAt = '', related = [], evidence = [],
  } = input;
  if (source !== '' && typeof source !== 'string') throw new Error('Invalid source reference.');
  if (!statuses.has(status)) throw new Error('Invalid memory record status.');
  if (typeof verifiedAt !== 'string' || (verifiedAt && !Number.isFinite(Date.parse(verifiedAt)))) {
    throw new Error('Invalid verification date.');
  }
  if (!Array.isArray(sections) || sections.length > 500) throw new Error('Invalid memory sections.');
  if (!Array.isArray(related) || related.length > 100) throw new Error('Invalid memory relationships.');
  if (!Array.isArray(evidence) || evidence.length > 100) throw new Error('Invalid record evidence.');
  const normalizedSections = sections.map(section => {
    object(section, ['id', 'title', 'summary', 'details'], 'memory section');
    return {
      id: identifier(section.id),
      title: text(section.title, 'section title', 500),
      summary: text(section.summary ?? '', 'section summary', 4000, { optional: true }),
      details: text(section.details ?? '', 'section details', 1_000_000, { optional: true }),
    };
  });
  if (new Set(normalizedSections.map(section => section.id)).size !== normalizedSections.length) {
    throw new Error('Duplicate section ID.');
  }
  const normalizedTask = task === null ? null : object(task, ['objective', 'constraints', 'state', 'blockers', 'next'], 'task handoff');
  return {
    id: identifier(id),
    title: text(title, 'record title', 500),
    summary: text(summary ?? '', 'record summary', 4000, { optional: true }),
    details: text(details ?? '', 'record details', 1_000_000, { optional: true }),
    source: source ? link(source) : '',
    task: normalizedTask && Object.fromEntries(['objective', 'constraints', 'state', 'blockers', 'next'].map(key =>
      [key, text(normalizedTask[key] ?? '', `task ${key}`, 16_000, { optional: key !== 'objective' })])),
    sections: normalizedSections,
    status,
    verifiedAt,
    related: [...new Set(related.map(identifier))],
    evidence: [...new Set(evidence.map(link))],
  };
}

const taskLabels = { objective: 'Objective', constraints: 'Constraints', state: 'Current state', blockers: 'Blockers', next: 'Next action' };
const field = (name, content, tag = 'p') => `<${tag} data-field="${name}">${escapeHtml(content)}</${tag}>`;
const sectionPattern = /<section id="([A-Za-z][A-Za-z0-9_-]{0,79})"><h2>([^<]*)<\/h2><p data-field="summary">([^<]*)<\/p><pre data-field="details">([^<]*)<\/pre><\/section>/g;

export function renderRecord(value) {
  const record = normalizeRecord(value);
  const task = record.task ? `<dl data-task="true">${Object.entries(taskLabels).map(([key, title]) =>
    `<dt>${title}</dt>${field(key, record.task[key], 'dd')}`).join('')}</dl>` : '';
  return [
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Shared Memory record</title><body>',
    `<article id="${record.id}" data-status="${record.status}">`,
    `<h1>${escapeHtml(record.title)}</h1>`,
    field('summary', record.summary),
    field('details', record.details, 'pre'),
    field('source', record.source),
    ...(record.evidence.length ? [field('evidence', JSON.stringify(record.evidence), 'pre')] : []),
    field('verifiedAt', record.verifiedAt, 'time'),
    field('related', record.related.join(' ')),
    task,
    ...record.sections.map(section => `<section id="${section.id}"><h2>${escapeHtml(section.title)}</h2>${field('summary', section.summary)}${field('details', section.details, 'pre')}</section>`),
    '</article></body></html>',
    '',
  ].join('\n');
}

export function parseRecord(html) {
  const article = /<article id="([^"]+)" data-status="([^"]+)">\n<h1>([^<]*)<\/h1>/.exec(html);
  if (!article) throw new Error('Malformed HTML memory record.');
  const fieldValue = name => unescapeHtml(new RegExp(`data-field="${name}">([^<]*)<`).exec(html)?.[1] ?? '');
  const record = normalizeRecord({
    id: article[1],
    status: article[2],
    title: unescapeHtml(article[3]),
    summary: fieldValue('summary'),
    details: fieldValue('details'),
    source: fieldValue('source'),
    evidence: JSON.parse(fieldValue('evidence') || '[]'),
    verifiedAt: fieldValue('verifiedAt'),
    related: fieldValue('related').split(' ').filter(Boolean),
    task: html.includes('<dl data-task="true">')
      ? Object.fromEntries(Object.keys(taskLabels).map(key => [key, fieldValue(key)])) : null,
    sections: [...html.matchAll(sectionPattern)].map(([, id, title, summary, details]) => ({
      id, title: unescapeHtml(title), summary: unescapeHtml(summary), details: unescapeHtml(details),
    })),
  });
  if (renderRecord(record) !== html) throw new Error('The HTML memory record contains unsupported markup or fields.');
  return record;
}

export function projectText(record) {
  const task = record.task ? Object.entries(taskLabels).map(([key, label]) => `${label}: ${record.task[key]}`) : [];
  return [
    `# ${record.title}`, record.summary, record.details, ...task,
    ...(record.source ? [`Source: ${record.source}`] : []),
    ...(record.evidence ?? []).map(reference => `Evidence: ${reference}`),
    ...record.sections.map(section => `## ${section.title}\n\n${section.summary}\n\n${section.details}`),
  ].filter(Boolean).join('\n\n');
}
