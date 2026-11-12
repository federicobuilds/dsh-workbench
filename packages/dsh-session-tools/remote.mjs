/** Plain codecs and Typert descriptors for session-tools: no external package imports. */

function stringCodec(typeSymbol, label) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse(value) {
        if (typeof value !== 'string' || value === '') throw new Error(`Invalid ${label}`);
        return value;
      },
      optional() { return this; },
    }),
    jsonSchema: { type: 'string', minLength: 1 },
  };
}

function objectCodec(typeSymbol, fields) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid result');
        }
        for (const [key, kind] of Object.entries(fields)) {
          if (typeof value[key] !== kind) throw new Error('Invalid result');
        }
        return value;
      },
      optional() { return this; },
    }),
    jsonSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.keys(fields).map((key) => [key, { type: fields[key] }])),
      required: Object.keys(fields),
      additionalProperties: false,
    },
  };
}

export const sessionIdCodec = stringCodec('@deepseek-ai/dsh-session/types#SessionId', 'session');
export const workspaceIdCodec = stringCodec('@dsh-workbench/dsh-session-tools#WorkspaceId', 'workspace');
export const deleteResultCodec = objectCodec('@dsh-workbench/dsh-session-tools#DeleteResult', { deleted: 'boolean' });
export const moveResultCodec = objectCodec('@dsh-workbench/dsh-session-tools#MoveResult', { moved: 'boolean' });

/**
 * Build the host Typert contribution. Each descriptor's `invoke` closes over
 * the live service object, so no runtime service lookup can fail.
 */
export function buildTypert(service) {
  const invocations = [
    {
      id: '@dsh-workbench/dsh-session-tools#sessionTools/deleteSession',
      namespace: 'sessionTools',
      method: 'deleteSession',
      service: 'sessionTools',
      invocation: { kind: 'direct' },
      description: 'Permanently delete one chat and its stored transcript after live/running guards.',
      parameters: [
        { name: 'sessionId', wire: 'agentId', source: 'json', codec: sessionIdCodec, strictCodec: sessionIdCodec },
      ],
      cancellation: { parameter: 'signal' },
      result: deleteResultCodec,
      input() {
        return {
          create: () => ({
            parse(raw) {
              if (raw === null || typeof raw !== 'object' || typeof raw.agentId !== 'string' || raw.agentId === '') {
                throw new Error('Invalid deleteSession input: sessionId required');
              }
              return { sessionId: raw.agentId };
            },
          }),
          toJSONSchema: () => ({
            type: 'object', required: ['agentId'], additionalProperties: false,
            properties: { agentId: { type: 'string', minLength: 1 } },
          }),
        };
      },
      invoke(_remote, input, signal) {
        return service.deleteSession(input.sessionId, signal);
      },
    },
    {
      id: '@dsh-workbench/dsh-session-tools#sessionTools/moveSession',
      namespace: 'sessionTools',
      method: 'moveSession',
      service: 'sessionTools',
      invocation: { kind: 'direct' },
      description: 'Rehome one chat into another workspace by committing its working directory there.',
      parameters: [
        { name: 'sessionId', wire: 'agentId', source: 'json', codec: sessionIdCodec, strictCodec: sessionIdCodec },
        { name: 'workspaceId', source: 'json', codec: workspaceIdCodec, strictCodec: workspaceIdCodec },
      ],
      cancellation: { parameter: 'signal' },
      result: moveResultCodec,
      input() {
        return {
          create: () => ({
            parse(raw) {
              if (raw === null || typeof raw !== 'object'
                || typeof raw.agentId !== 'string' || raw.agentId === ''
                || typeof raw.workspaceId !== 'string' || raw.workspaceId === '') {
                throw new Error('Invalid moveSession input: sessionId and workspaceId required');
              }
              return { sessionId: raw.agentId, workspaceId: raw.workspaceId };
            },
          }),
          toJSONSchema: () => ({
            type: 'object', required: ['agentId', 'workspaceId'], additionalProperties: false,
            properties: {
              agentId: { type: 'string', minLength: 1 },
              workspaceId: { type: 'string', minLength: 1 },
            },
          }),
        };
      },
      invoke(_remote, input, signal) {
        return service.moveSession(input.sessionId, input.workspaceId, signal);
      },
    },
  ];

  return Object.freeze({
    package: '@dsh-workbench/dsh-session-tools',
    face: 'host',
    schemas: [],
    invocations,
    model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] },
  });
}
