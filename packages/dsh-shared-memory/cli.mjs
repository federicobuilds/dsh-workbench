#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  activateHtmlMemory,
  publishMemory,
  readProjectReminders,
  rollbackHtmlMemory,
  sharedMemory,
  stageHtmlMemory,
  updateHtmlMemory,
} from './memory.mjs';

const [action, project, argument, page, ...extra] = process.argv.slice(2);
const readActions = ['index', 'search', 'read', 'resume', 'verify'];
const writeActions = ['publish', 'stage-html', 'activate-html', 'update', 'rollback-html'];
try {
  if (!project || extra.length || ![...readActions, ...writeActions, 'reminders'].includes(action)) {
    throw new Error('Usage: dsh-shared-memory <index|search|read|resume|verify|reminders|publish|stage-html|activate-html|update|rollback-html> <absolute-project-root> [selector-or-request] [offset]');
  }
  let result;
  if (readActions.includes(action)) {
    const options = { action };
    if (action === 'read' || action === 'resume') options.selector = argument;
    if (action === 'search') options.query = argument;
    if (action === 'index' && argument !== undefined) options.offset = Number(argument);
    if (page !== undefined) options.offset = Number(page);
    result = await sharedMemory(project, options);
  } else if (action === 'reminders') {
    result = await readProjectReminders(project);
    result = { ...result, records: result.records.filter(record => record.status === 'open').map(({ documentHashes: _hashes, ...record }) => record) };
  } else if (action === 'publish') {
    result = await publishMemory(project);
  } else if (action === 'activate-html') {
    result = await activateHtmlMemory(project, argument);
  } else if (action === 'rollback-html') {
    result = await rollbackHtmlMemory(project, argument, page);
  } else {
    if (!argument) throw new Error('Provide a JSON request file.');
    const request = JSON.parse(await readFile(argument, 'utf8'));
    result = action === 'update' ? await updateHtmlMemory(project, request) : await stageHtmlMemory(project, request);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.published === false || (['verify', 'publish'].includes(action) && !result.verified)) process.exitCode = 1;
} catch (error) {
  console.error(error.code === 'MEMORY_REVISION_CONFLICT'
    ? JSON.stringify({ error: error.message, revision: error.revision })
    : error.message);
  process.exitCode = 1;
}
