export const PACKAGE = '@dsh-workbench/dsh-workspace-placement';
function codec(name, jsonSchema, parse) {
  return { mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, jsonSchema, create: () => ({ parse, nonoptional() { return this; } }) };
}
const result = codec('Result', { type: 'object' }, value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a result object');
  return value;
});

export const PLACEMENT_NAMESPACE = 'chatPlacement';
const placementString = codec('PlacementString', { type: 'string', minLength: 1, pattern: '\\S' }, value => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a non-blank string');
  return value;
});
const taskFields = ['taskId', 'originalParentSessionId', 'successorSessionId', 'workerSessionId'];
const task = codec('PlacementTask', { type: 'object', properties: { taskId: placementString.jsonSchema, originalParentSessionId: placementString.jsonSchema, successorSessionId: { anyOf: [placementString.jsonSchema, { type: 'null' }] }, workerSessionId: { anyOf: [placementString.jsonSchema, { type: 'null' }] } }, required: taskFields, additionalProperties: false }, value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || !taskFields.every(key => Object.hasOwn(value, key)) || !value.taskId?.trim?.() || !value.originalParentSessionId?.trim?.() || ![null, 'string'].includes(value.successorSessionId === null ? null : typeof value.successorSessionId) || ![null, 'string'].includes(value.workerSessionId === null ? null : typeof value.workerSessionId) || value.successorSessionId !== null && !value.successorSessionId.trim() || value.workerSessionId !== null && !value.workerSessionId.trim() || value.successorSessionId === null && value.workerSessionId === null) throw new Error('Invalid task reference');
  return value;
});
export const placementDescriptors = Object.entries({ moveSessionReference: ['sessionId', 'workspaceId'], appendTaskReference: ['fields'], detachReference: ['eventId'], listReferences: [] }).map(([method, names]) => ({
  id: `${PACKAGE}#${PLACEMENT_NAMESPACE}/${method}`, namespace: PLACEMENT_NAMESPACE, service: PLACEMENT_NAMESPACE, method,
  invocation: { kind: 'direct' }, parameters: names.map(name => ({ name, wire: name, source: 'json', codec: name === 'fields' ? task : placementString, strictCodec: name === 'fields' ? task : placementString })),
  cancellation: { parameter: 'signal' }, result,
}));
export const TYPERT = {
  package: PACKAGE, face: 'host', schemas: [], invocations: placementDescriptors,
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] },
};
