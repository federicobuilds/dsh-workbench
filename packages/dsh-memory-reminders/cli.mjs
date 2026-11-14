#!/usr/bin/env node
import { loadMemoryEngine } from '@dsh-workbench/dsh-shared-memory/memory';
import { presentReminder } from './reminders.mjs';
import { projectReminders, recordMemoryEvent, resolveReminder } from './project-store.mjs';

const [action, project, id, selector, reason] = process.argv.slice(2);
try {
  let result;
  if (action === 'list') {
    const engine = await loadMemoryEngine();
    const snapshot = await engine.buildMemorySnapshot(project);
    const open = await projectReminders(project, 'list', snapshot.projectId);
    result = { openCount: open.length, reminders: open.map(presentReminder) };
  } else if (action === 'milestone' || action === 'handoff') {
    if (!id || !selector) throw new Error('Give a session ID and a stable event ID.');
    result = await recordMemoryEvent(project, { sessionId: id, source: action + ':' + selector, reason });
  } else if (action === 'resolve' || action === 'dismiss') {
    result = await resolveReminder(project, {
      id, reason: action === 'dismiss' ? selector : reason, selector, dismiss: action === 'dismiss',
    });
  } else {
    throw new Error('Use list PROJECT, resolve PROJECT ID DOCUMENT REASON, dismiss PROJECT ID REASON, or milestone|handoff PROJECT SESSION EVENT REASON.');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
