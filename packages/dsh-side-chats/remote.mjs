import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const packageId = '@dsh-workbench/dsh-side-chats';
const id = z.string().min(1).max(256);
export const linkSchema = z.object({
  sessionId: id,
  sourceKey: z.string().max(512),
  boundary: z.number().int().min(0),
  routed: z.literal(true).optional(),
}).strict();

const sessionId = {
  mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
  create: () => id, jsonSchema: { type: 'string', minLength: 1, maxLength: 256 },
};
const link = {
  mode: 'strict', typeSymbol: packageId + '#Link',
  create: () => linkSchema,
  jsonSchema: { type: 'object', required: ['sessionId', 'sourceKey', 'boundary'], additionalProperties: false,
    properties: {
      sessionId: sessionId.jsonSchema,
      sourceKey: { type: 'string', minLength: 0, maxLength: 512 },
      boundary: { type: 'integer', minimum: 0 },
      routed: { type: 'boolean' },
    } },
};
const result = { mode: 'strict', typeSymbol: packageId + '#Result', create: () => z.json(), jsonSchema: {} };
const params = [{ name: 'childId', source: 'json', codec: sessionId, strictCodec: sessionId }];

const remote = createTypertRemoteInfo({ package: packageId, methods: {
  'dshSideChatLinks/read': { service: 'dshSideChatLinks', invocation: { kind: 'direct' },
    description: 'Read the source location of a side chat.', parameters: params, result },
  'dshSideChatLinks/record': { service: 'dshSideChatLinks', invocation: { kind: 'direct' },
    description: 'Persist a side chat source location after verifying the source event.',
    parameters: [...params, { name: 'link', source: 'json', codec: link, strictCodec: link }], result },
} }, z);

export const TYPERT = {
  package: packageId, face: 'host', schemas: [],
  get invocations() { return remote.descriptors; },
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] },
};
