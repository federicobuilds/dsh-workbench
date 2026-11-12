import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const idCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string().min(1), jsonSchema: { type: 'string', minLength: 1 } };
const statusCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-workspace-index#Status', create: () => z.json(), jsonSchema: {} };
const method = description => ({
  service: 'workspaceIndexUi', invocation: { kind: 'direct' },
  scope: { context: 'agent', wire: 'agentId' }, description,
  parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec }],
  cancellation: { parameter: 'signal' }, result: statusCodec,
});

export const REMOTE = createTypertRemoteInfo({ package: '@dsh-workbench/dsh-workspace-index', methods: {
  'workspaceIndexUi/getStatus': method('Read the workspace index status.'),
  'workspaceIndexUi/rebuild': method('Rebuild the current session workspace index.'),
} }, z);
export const TYPERT = { package: '@dsh-workbench/dsh-workspace-index', face: 'host', schemas: [],
  get invocations() { return REMOTE.descriptors; },
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] } };
