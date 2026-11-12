import { isDeepStrictEqual } from 'node:util';

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const TURN_TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'system/message', 'developer/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'llm/retry', 'llm/retry-started', 'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune']);
const PREFIX_LENGTH = 5;

/** Shift an earlier local event reference, refusing malformed or forward references. */
function shiftReference(value, owner) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= owner) throw new Error('History recovery refused an invalid local event reference');
  return value + PREFIX_LENGTH;
}

/** Preserve native range-encoded source references without changing numeric payloads. */
function shiftReferences(values, owner) {
  if (!Array.isArray(values)) throw new Error('History recovery expected a native reference array');
  return values.map(value => Array.isArray(value) ? value.map(item => shiftReference(item, owner)) : shiftReference(value, owner));
}

/** Remap known message-editor coordinates; other source metadata remains unchanged. */
function shiftMessageSource(source, owner) {
  if (!source || source.kind !== 'message-edit-cut') return source;
  const next = { ...source };
  for (const key of ['targetSeq', 'endSeq']) if (next[key] !== undefined) next[key] = shiftReference(next[key], owner);
  return next;
}

/** Shift only native event coordinates and known plugin coordinates, never message content. */
function shiftEvent(event) {
  const next = structuredClone(event);
  next.seq += PREFIX_LENGTH;
  const data = next.data;
  if (TURN_TYPES.has(event.type) && Number.isInteger(data?.turn)) data.turn += 1;
  if (event.sourceEventSeqs !== undefined) next.sourceEventSeqs = shiftReferences(event.sourceEventSeqs, event.seq);
  if (event.surfaceOp && event.surfaceOp !== 'append') {
    next.surfaceOp.startSeq = shiftReference(event.surfaceOp.startSeq, event.seq);
    next.surfaceOp.endSeq = shiftReference(event.surfaceOp.endSeq, event.seq);
  }
  if (event.type === 'command/done' && data.sourceEventSeq !== undefined) data.sourceEventSeq = shiftReference(data.sourceEventSeq, event.seq);
  if (['session/title', 'session/title-llm-request'].includes(event.type)) data.messageSeqs = shiftReferences(data.messageSeqs, event.seq);
  if (event.type === 'developer/message' && data.headerSeq !== undefined) data.headerSeq = shiftReference(data.headerSeq, event.seq);
  if (['compaction/summary', 'compaction/prune'].includes(event.type)) {
    data.shadowedSeqs = shiftReferences(data.shadowedSeqs, event.seq);
    data.shadowedRange.start = shiftReference(data.shadowedRange.start, event.seq);
    data.shadowedRange.end = shiftReference(data.shadowedRange.end, event.seq);
  }
  if (event.type === 'image/offload') for (const target of data.targets) target.seq = shiftReference(target.seq, event.seq);
  if (event.type === 'user/message') data.source = shiftMessageSource(data.source, event.seq);
  if (data?.message?.source) data.message.source = shiftMessageSource(data.message.source, event.seq);
  return next;
}

/** Return immutable message payloads for preservation checks, excluding remapped source coordinates. */
function preservedMessage(event) {
  if (!SURFACE_TYPES.has(event.type)) return null;
  const message = structuredClone(event.data.message ?? event.data);
  if (message.source?.kind === 'message-edit-cut') {
    delete message.source.targetSeq;
    delete message.source.endSeq;
  }
  return message;
}

/** Verify the repair kept every historical event and every user/model/tool payload. */
function assertPreserved(original, repaired) {
  if (repaired.length !== original.length + PREFIX_LENGTH) throw new Error('History recovery changed the historical event count');
  for (const event of original) {
    const next = repaired[event.seq + PREFIX_LENGTH];
    if (next.type !== event.type || next.time !== event.time || next.ignorable !== event.ignorable) throw new Error('History recovery changed historical event identity');
    if (!isDeepStrictEqual(preservedMessage(next), preservedMessage(event))) throw new Error('History recovery changed a historical message');
    if (event.type === 'tool/call' && (next.data.callId !== event.data.callId || next.data.name !== event.data.name || !isDeepStrictEqual(next.data.arguments, event.data.arguments))) throw new Error('History recovery changed a historical tool invocation');
  }
}

/**
 * Construct a copy-only native system baseline repair. The caller supplies the actual
 * installed decoder and a native system message; this function performs no I/O.
 */
export function recoverSystemHead(artifact, { systemMessage, validate }) {
  if (typeof validate !== 'function' || systemMessage?.role !== 'system') throw new Error('Native validation and a native system baseline are required');
  if (artifact?.header?.version !== 4 || !Array.isArray(artifact.events)) throw new Error('History recovery only supports native v4 artifacts');
  for (const [index, event] of artifact.events.entries()) if (event.seq !== index) throw new Error('History recovery requires dense native event sequences');
  let priorError;
  try { validate(artifact); } catch (error) {
    if (!String(error.message).includes('system/message requires a protected first surface head')) throw error;
    priorError = error;
  }
  const firstSurface = artifact.events.find(event => SURFACE_TYPES.has(event.type) && event.surfaceOp);
  if (!firstSurface || firstSurface.type === 'system/message') {
    if (priorError) throw priorError;
    return { artifact: structuredClone(artifact), addedEvents: 0, sequenceOffset: 0, turnOffset: 0 };
  }
  const time = artifact.events[0]?.time ?? artifact.header.createdAt;
  const prefix = [
    { seq: 0, time, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, time, type: 'system/message', data: { turn: 1, step: 1, message: structuredClone(systemMessage) }, surfaceOp: 'append' },
    { seq: 3, time, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 4, time, type: 'turn/end', data: { turn: 1, reason: 'completed' } },
  ];
  let protectedHead = 2;
  const shifted = artifact.events.map(event => {
    const next = shiftEvent(event);
    if (event.type === 'system/message' && event.surfaceOp) {
      if (event.surfaceOp === 'append') {
        next.surfaceOp = { op: 'replace', startSeq: protectedHead, endSeq: protectedHead };
        next.sourceEventSeqs = [...new Set([protectedHead, ...(next.sourceEventSeqs ?? [])])];
      }
      protectedHead = next.seq;
    }
    return next;
  });
  const repaired = {
    ...structuredClone(artifact),
    events: [...prefix, ...shifted],
    inheritedEventCount: artifact.inheritedEventCount ? artifact.inheritedEventCount + PREFIX_LENGTH : 0,
  };
  assertPreserved(artifact.events, repaired.events);
  validate(repaired);
  return { artifact: repaired, addedEvents: PREFIX_LENGTH, sequenceOffset: PREFIX_LENGTH, turnOffset: 1 };
}
