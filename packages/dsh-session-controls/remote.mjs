import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const idCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string().min(1), jsonSchema: { type: 'string', minLength: 1 } };
const roleCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#RoleId', create: () => z.string().min(1).max(120), jsonSchema: { type: 'string', minLength: 1, maxLength: 120 } };

export const REMOTE = createTypertRemoteInfo({ package: '@dsh-workbench/dsh-session-controls', methods: {
  'dshSessionControlsUi/status': { service: 'dshSessionControlsUi', invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    description: 'Read caller-session harness state and redacted decisions. No model request or mutation.',
    parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#Status', create: () => z.json(), jsonSchema: {} },
  },
  'dshSessionControlsUi/setTrack': { service: 'dshSessionControlsUi', invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    description: 'Owner-only compare-and-set of the receiving session worker track; does not change the lead model.',
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec },
      { name: 'mode', source: 'json', codec: { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#Track', create: () => z.enum(['off','free','simple','advanced']), jsonSchema: { type: 'string', enum: ['off','free','simple','advanced'] } } },
      { name: 'expectedRevision', source: 'json', codec: { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#TrackRevision', create: () => z.number().int().min(0), jsonSchema: { type: 'integer', minimum: 0 } } },
    ], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#Status', create: () => z.json(), jsonSchema: {} },
  },
  'dshSessionControlsUi/setRole': { service: 'dshSessionControlsUi', invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    description: 'Owner-only mid-session role and assigned model switch.',
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec },
      { name: 'roleId', source: 'json', codec: roleCodec, strictCodec: roleCodec },
    ], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-session-controls#Status', create: () => z.json(), jsonSchema: {} },
  },

} }, z);
export const TYPERT = { package: '@dsh-workbench/dsh-session-controls', face: 'host', schemas: [],
  get invocations() { return REMOTE.descriptors; },
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] } };
