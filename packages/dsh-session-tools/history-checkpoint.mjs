import { randomUUID } from 'node:crypto';

/** Count serialized message characters, not provider tokens. */
function characterCount(nodes) {
  return nodes.reduce((total, node) => total + JSON.stringify(node.message).length, 0);
}

/** Refuse a checkpoint while a native turn or compaction remains open. */
function requireIdle(events) {
  let turn = null;
  let compaction = false;
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn;
    if (event.type === 'turn/end') turn = null;
    if (event.type === 'compaction/start') compaction = true;
    if (event.type === 'compaction/end' || event.type === 'session/end-seed') compaction = false;
  }
  if (turn !== null || compaction) throw new Error('History must be idle before preparing a checkpoint');
}

/** Distinguish retained human input from metadata-only notifications in imported logs. */
function humanRequest(message) {
  if (message.role !== 'user' || message.source?.kind !== 'user') return false;
  const blocks = message.content ?? [];
  if (blocks.some(block => ['image', 'audio', 'video'].includes(block.type))) return true;
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n').replace(/<kilo-part\b[^>]*>[\s\S]*?<\/kilo-part>/g, '').trim();
  return Boolean(text) && !text.startsWith('<task ') && !text.startsWith('If this goal is to wait for a deploy, build, CI job');
}

/**
 * Append a native, manually authored compaction transaction to a copy of an idle
 * history. Original events remain intact; only the model-visible surface shrinks.
 */
export function buildAuthoredCheckpoint(artifact, {
  summary, foldSurface, createUserMessage, validate,
  keepRecentHumanMessages = 1, maxSummaryCharacters = 20000,
  maxRemainingCharacters = 200000, now = Date.now,
}) {
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('Refusing an empty compression summary');
  if (summary.length > maxSummaryCharacters) throw new Error(`Compression summary exceeds ${maxSummaryCharacters} characters`);
  if (!Number.isSafeInteger(keepRecentHumanMessages) || keepRecentHumanMessages < 1) throw new Error('Keep at least one recent human message');
  if (typeof foldSurface !== 'function' || typeof createUserMessage !== 'function' || typeof validate !== 'function') throw new Error('Native surface, message, and validation functions are required');
  validate(artifact);
  requireIdle(artifact.events);
  const surface = foldSurface(artifact.events);
  const nodes = surface.nodes.map(seq => ({
    seq,
    message: surface.projectedMessages.get(seq) ?? artifact.events[seq].data.message ?? artifact.events[seq].data,
  }));
  if (nodes[0]?.message?.role !== 'system') throw new Error('Repair the protected system head before compression');
  const human = nodes.map((node, index) => humanRequest(node.message) ? index : -1).filter(index => index >= 0);
  const retainFrom = human.at(-keepRecentHumanMessages);
  if (retainFrom === undefined || retainFrom <= 1) throw new Error('No complete older history remains before the retained human request');
  const selected = nodes.slice(1, retainFrom);
  const body = `Recovered working context. Historical approvals are not new authorization. Verify current state before acting.\n\n${summary.trim()}`;
  if (selected.length === 1 && selected[0].message.source.kind === 'compact-checkpoint' && selected[0].message.content?.[0]?.text === body) {
    return { artifact: structuredClone(artifact), addedEvents: 0, beforeCharacters: characterCount(nodes), afterCharacters: characterCount(nodes) };
  }
  const compactionId = randomUUID();
  const checkpoint = createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'compact-checkpoint', compactionId } });
  const beforeCharacters = characterCount(nodes);
  const shadowedCharacters = characterCount(selected);
  const afterCharacters = characterCount([nodes[0], { message: checkpoint }, ...nodes.slice(retainFrom)]);
  if (afterCharacters >= beforeCharacters) throw new Error('Compression summary does not reduce model context');
  if (afterCharacters > maxRemainingCharacters) throw new Error(`Retained context still exceeds ${maxRemainingCharacters} characters; prepare a smaller retained span`);
  const events = structuredClone(artifact.events);
  const time = now();
  const add = (type, data, extra = {}) => {
    const event = { seq: events.length, time, type, data, ...extra };
    events.push(event);
    return event;
  };
  const lifecycle = { compactionId, turn: null };
  const start = add('compaction/start', lifecycle);
  const shadowedSeqs = selected.map(node => node.seq);
  const shadowedRange = { start: shadowedSeqs[0], end: shadowedSeqs.at(-1) };
  const record = add('compaction/summary', {
    compactionId,
    summary: summary.trim(),
    shadowedRange,
    shadowedSeqs,
    shadowedTokenCount: Math.ceil(shadowedCharacters / 4),
    provider: 'manual',
    model: 'authored-recovery-summary',
  });
  add('user/message', checkpoint, {
    surfaceOp: { op: 'replace', startSeq: shadowedRange.start, endSeq: shadowedRange.end },
    sourceEventSeqs: [start.seq, record.seq, ...shadowedSeqs],
  });
  add('compaction/end', lifecycle);
  const result = { ...structuredClone(artifact), events };
  validate(result);
  return { artifact: result, addedEvents: 4, beforeCharacters, afterCharacters, shadowedNodes: selected.length, tokenEstimateMethod: 'serialized-characters-divided-by-four' };
}
