import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installBoundedSummarizer } from './bounded-summarizer.mjs';

/** Build text-only test input large enough to require multiple bounded requests. */
function input(text = 'archived context '.repeat(160)) {
  return { messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
}

/** Produce a native-style summary without making a model call. */
function result(text = 'Retain current goal, decisions and unfinished work.') {
  return { summary: [{ type: 'text', text }], provider: 'synthetic', model: 'synthetic', rawOutput: [{ type: 'text', text }], llmStreamCall: true };
}

test('large histories are passed in bounded quoted sections, never as one oversized request', async () => {
  const calls = [];
  const engine = { async summarize(value) { calls.push(value); return result(); } };
  const release = installBoundedSummarizer(engine, { maxRequestCharacters: 1600, maxSummaryCharacters: 200, maxCallsPerRun: 20 });
  const value = await engine.summarize(input(), { session: { id: 'one' } });
  assert.ok(calls.length > 1);
  for (const call of calls) {
    assert.ok(JSON.stringify(call.messages).length <= 1600);
    assert.deepEqual(call.tools, []);
    assert.match(call.messages[0].content[0].text, /historical data/);
  }
  assert.equal(value.summary[0].text, result().summary[0].text);
  release();
});

test('a cancelled attempt resumes completed sections and a completed result is reused', async () => {
  const control = new AbortController();
  let calls = 0;
  const engine = { async summarize() { calls++; if (calls === 2) control.abort(); return result(); } };
  const release = installBoundedSummarizer(engine, { maxRequestCharacters: 1600, maxSummaryCharacters: 200, maxCallsPerRun: 20 });
  const value = input();
  const agent = { session: { id: 'resume' } };
  await assert.rejects(engine.summarize(value, agent, control.signal), { name: 'AbortError' });
  const before = calls;
  await engine.summarize(value, agent, new AbortController().signal);
  assert.ok(calls > before);
  const completedCalls = calls;
  await engine.summarize(value, agent);
  assert.equal(calls, completedCalls);
  release();
});

test('empty or oversized summaries fail before being cached as progress', async () => {
  const engine = { async summarize() { return result(''); } };
  const release = installBoundedSummarizer(engine, { maxRequestCharacters: 1600, maxSummaryCharacters: 200 });
  await assert.rejects(engine.summarize(input(), { session: { id: 'empty' } }), /empty/);
  release();
  engine.summarize = async () => result('x'.repeat(201));
  const second = installBoundedSummarizer(engine, { maxRequestCharacters: 1600, maxSummaryCharacters: 200 });
  await assert.rejects(engine.summarize(input(), { session: { id: 'oversize' } }), /200/);
  second();
});

test('per-run budget reports retained progress instead of silently retrying forever', async () => {
  let calls = 0;
  const engine = { async summarize() { calls++; return result(); } };
  const release = installBoundedSummarizer(engine, { maxRequestCharacters: 1600, maxSummaryCharacters: 200, maxCallsPerRun: 1 });
  const value = input();
  const agent = { session: { id: 'budget' } };
  await assert.rejects(engine.summarize(value, agent), error => error.code === 'COMPACTION_PROGRESS_SAVED');
  assert.equal(calls, 1);
  await assert.rejects(engine.summarize(value, agent), error => error.code === 'COMPACTION_PROGRESS_SAVED');
  assert.equal(calls, 2);
  release();
});

test('different sessions and model routes never share cached summaries', async () => {
  let calls = 0;
  const engine = { config: { summarizationModel: 'route-one' }, async summarize() { calls++; return result(); } };
  const release = installBoundedSummarizer(engine, { maxRequestCharacters: 1600, maxSummaryCharacters: 200, maxCallsPerRun: 20 });
  const value = input();
  await engine.summarize(value, { session: { id: 'a' } });
  const first = calls;
  await engine.summarize(value, { session: { id: 'b' } });
  assert.equal(calls, first * 2);
  engine.config.summarizationModel = 'route-two';
  await engine.summarize(value, { session: { id: 'b' } });
  assert.equal(calls, first * 3);
  release();
});

test('small requests keep native input semantics and disposal restores the original method', async () => {
  const original = async value => { assert.equal(value, small); return result(); };
  const small = input('Small recent history.');
  const engine = { summarize: original };
  const release = installBoundedSummarizer(engine);
  await engine.summarize(small, { session: { id: 'small' } });
  release();
  assert.equal(engine.summarize, original);
});
