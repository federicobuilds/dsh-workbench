import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const idCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string().min(1), jsonSchema: { type: 'string', minLength: 1 } };
const textCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-prompt-enhancer#PromptText', create: () => z.string(), jsonSchema: { type: 'string' } };
const modelCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-prompt-enhancer#EnhanceModel', create: () => z.string().optional(), jsonSchema: { type: 'string' } };
const resultCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-prompt-enhancer#EnhanceResult', create: () => z.object({ text: z.string(), route: z.string() }), jsonSchema: { type: 'object', properties: { text: { type: 'string' }, route: { type: 'string' } }, required: ['text', 'route'] } };

export const REMOTE = createTypertRemoteInfo({ package: '@dsh-workbench/dsh-prompt-enhancer', methods: {
  'promptEnhancer/enhance': {
    service: 'promptEnhancer', invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    description: 'Enhance a session draft using an approved model.',
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec },
      { name: 'text', source: 'json', codec: textCodec, strictCodec: textCodec },
      { name: 'model', source: 'json', codec: modelCodec, strictCodec: modelCodec, optional: true },
    ], cancellation: { parameter: 'signal' }, result: resultCodec,
  },
} }, z);
export const TYPERT = { package: '@dsh-workbench/dsh-prompt-enhancer', face: 'host', schemas: [],
  get invocations() { return REMOTE.descriptors; },
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] } };
