import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const packageId = '@dsh-workbench/dsh-task-organization';
const text = (typeSymbol, maxLength) => ({
  mode: 'strict', typeSymbol, create: () => z.string().min(1).max(maxLength),
  jsonSchema: { type: 'string', minLength: 1, maxLength },
});
const sessionId = text('@deepseek-ai/dsh-session/types#SessionId', 256);
const draft = text(`${packageId}#Draft`, 6000);
const candidates = {
  mode: 'strict', typeSymbol: `${packageId}#CandidateTitles`,
  create: () => z.array(z.string().min(1).max(160)).max(8),
  jsonSchema: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } },
};
const result = {
  mode: 'strict', typeSymbol: `${packageId}#Suggestion`,
  create: () => z.json(), jsonSchema: {},
};

const remote = createTypertRemoteInfo({ package: packageId, methods: {
  'dshTaskOrganization/suggest': {
    service: 'dshTaskOrganization', invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    description: 'Ask the configured Judge for an advisory destination for an unsent draft.',
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: sessionId, strictCodec: sessionId },
      { name: 'draft', source: 'json', codec: draft, strictCodec: draft },
      { name: 'candidates', source: 'json', codec: candidates, strictCodec: candidates },
    ],
    cancellation: { parameter: 'signal' }, result,
  },
} }, z);

export const TYPERT = {
  package: packageId, face: 'host', schemas: [],
  get invocations() { return remote.descriptors; },
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] },
};
