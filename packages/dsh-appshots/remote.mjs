import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const packageName = '@dsh-workbench/dsh-appshots';
const result = {
  mode: 'strict', typeSymbol: packageName + '#CaptureResult', create: () => z.string().nullable(),
  jsonSchema: { type: ['string', 'null'] },
};
export const REMOTE = createTypertRemoteInfo({
  package: packageName,
  methods: {
    'workbenchAppshots/capture': {
      service: 'workbenchAppshots', invocation: { kind: 'direct' },
      parameters: [], cancellation: { parameter: 'signal' }, result,
    },
  },
}, z);

export const TYPERT = {
  package: packageName,
  face: 'host',
  schemas: [],
  get invocations() { return REMOTE.descriptors; },
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] },
};
