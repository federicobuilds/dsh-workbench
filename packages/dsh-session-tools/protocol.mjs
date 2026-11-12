export const PACKAGE = '@dsh-workbench/dsh-session-tools';
export const NAMESPACE = 'chatDelete';

function codec(name, jsonSchema, parse) {
  return { mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, jsonSchema, create: () => ({ parse, nonoptional() { return this; } }) };
}
const string = codec('String', { type: 'string', minLength: 1 }, value => {
  if (typeof value !== 'string' || !value) throw new Error('Expected a non-empty string');
  return value;
});
const diagnosticSchema = { type: 'object', properties: Object.fromEntries(['stage', 'name', 'code'].map(key => [key, { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_.-]{0,64}(?![\\s\\S])' }])), required: ['stage', 'name', 'code'], additionalProperties: false };
const result = codec('Result', { type: 'object', properties: { diagnostic: diagnosticSchema } }, value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a result object');
  if (value.diagnostic !== undefined) {
    const diagnostic = value.diagnostic;
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic) || Object.keys(diagnostic).length !== 3 || ['stage', 'name', 'code'].some(key => typeof diagnostic[key] !== 'string' || diagnostic[key].length > 64 || /[^A-Za-z0-9_.-]/.test(diagnostic[key]))) throw new Error('Invalid diagnostic');
  }
  return value;
});

export const descriptors = ['prepare', 'commit'].map(method => ({
  id: `${PACKAGE}#${NAMESPACE}/${method}`, namespace: NAMESPACE, service: NAMESPACE, method,
  invocation: { kind: 'direct' },
  parameters: (method === 'prepare' ? ['sessionId'] : ['sessionId', 'token']).map(name => ({
    name, wire: name, source: 'json', codec: string, strictCodec: string,
  })),
  cancellation: { parameter: 'signal' }, result,
}));
export const TYPERT = {
  package: PACKAGE, face: 'host', schemas: [], invocations: descriptors,
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] },
};
