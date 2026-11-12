import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldObjective,
  validObjective,
  validFact,
  createEfficiency,
} from './efficiency.mjs';

test('foldObjective accumulates up to 3 requests, carries on continue, and marks >4000 chars truncated', () => {
  let obj = foldObjective(undefined, 'First user request', 'm1', 'observed');
  assert.equal(validObjective(obj), true);
  assert.equal(obj.complete, true);
  assert.equal(obj.goal_source, 'newest');
  assert.equal(obj.requests.length, 1);

  obj = foldObjective(obj, 'Second user request', 'm2', 'observed');
  obj = foldObjective(obj, 'Third user request', 'm3', 'observed');
  obj = foldObjective(obj, 'Fourth user request drops oldest', 'm4', 'observed');
  assert.equal(validObjective(obj), true);
  assert.equal(obj.requests.length, 3);
  assert.deepEqual(obj.provenance, ['m2', 'm3', 'm4']);

  // Internal messages preserve objective and append provenance
  const withInternal = foldObjective(obj, '<system-reminder>internal note</system-reminder>', 'm5', 'observed');
  assert.equal(withInternal.complete, true);
  assert.equal(withInternal.text, obj.text);
  assert.ok(withInternal.provenance.includes('m5'));

  // "continue" carries the known objective
  const carried = foldObjective(obj, 'continue', 'm6', 'observed');
  assert.equal(validObjective(carried), true);
  assert.equal(carried.goal_source, 'carried');
  assert.equal(carried.complete, true);

  // Over 4000 chars marks clipped and incomplete (truncated)
  const over = foldObjective(undefined, 'x'.repeat(4100), 'm-big', 'observed');
  assert.equal(validObjective(over), true);
  assert.equal(over.complete, false);
  assert.equal(over.objective_state, 'unknown');
  assert.equal(over.goal_source, 'truncated');
});

test('efficiency checkpoint blocks redundant read and single-use efficiency_override allows exactly one retry', async () => {
  const events = [];
  let fileVersion = 'sha1:aaa111';
  let judgeCall = null;

  const ctx = {
    get(name) {
      return {
        dshJudge: {
          decide: async (req) => {
            judgeCall = req;
            return {
              decision: 'reconsider',
              alternative_id: req.state.alternatives[0].id,
              why: 'identical file was just read with no edits',
            };
          },
        },
        tools: { guard: () => () => {} },
      }[name];
    },
    on: () => () => {},
  };

  const eff = createEfficiency(ctx, {
    readFingerprint: async () => fileVersion,
    events: {
      record: async (ev) => { events.push(ev); return ev; },
    },
  });

  eff.noteMessage('sess-1', 'Inspect config.mjs and report exports', 'req-1', 'observed');
  const fact = await eff.recordFact('sess-1', 'read', { file_path: '/repo/config.mjs' }, 'export const x = 1;');
  assert.equal(validFact(fact), true);

  const agent = { session: { id: 'sess-1' } };
  const stop1 = await eff.checkpoint('sess-1', 'read', { file_path: '/repo/config.mjs' }, { agent });
  assert.ok(stop1);
  assert.match(stop1, /Efficiency checkpoint (ec-[0-9a-f]{16})/);
  assert.equal(judgeCall.operation, 'efficiency');

  const checkpointId = /Efficiency checkpoint (ec-[0-9a-f]{16})/.exec(stop1)[1];

  // Wrong session or invalid evidence_ids are rejected
  await assert.rejects(
    () => eff.override({ checkpoint_id: checkpointId, reason: 'Need to re-verify line numbers', evidence_ids: [fact.id] }, { sessionId: 'other-sess' }),
    /Unknown or expired checkpoint/,
  );
  await assert.rejects(
    () => eff.override({ checkpoint_id: checkpointId, reason: 'Need to re-verify line numbers', evidence_ids: ['ev-nonexistent'] }, { agent }),
    /evidence IDs from this checkpoint/,
  );

  // Valid override grants single-use pass
  const granted = await eff.override(
    {
      checkpoint_id: checkpointId,
      reason: 'Need full context after truncated excerpt',
      evidence_ids: [fact.id],
    },
    { agent },
  );
  assert.equal(granted.status, 'recorded');

  // First retry is allowed
  const retry1 = await eff.checkpoint('sess-1', 'read', { file_path: '/repo/config.mjs' }, { agent });
  assert.equal(retry1, null);

  // Second retry without a new override is blocked again (single-use)
  const retry2 = await eff.checkpoint('sess-1', 'read', { file_path: '/repo/config.mjs' }, { agent });
  assert.ok(retry2);
  assert.match(retry2, /Efficiency checkpoint/);

  // Changing the file fingerprint allows the read naturally
  fileVersion = 'sha1:bbb222';
  const afterChange = await eff.checkpoint('sess-1', 'read', { file_path: '/repo/config.mjs' }, { agent });
  assert.equal(afterChange, null);

  assert.ok(events.some((e) => e.kind === 'efficiency' && e.decision === 'blocked'));
  assert.ok(events.some((e) => e.kind === 'efficiency' && e.decision === 'override-granted'));
  assert.ok(events.some((e) => e.kind === 'efficiency' && e.decision === 'override-used'));
});
