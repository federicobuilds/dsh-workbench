import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const packageName = '@dsh-workbench/dsh-maps';
const query = z.object({
  area: z.string().trim().min(1).max(180),
  place: z.string().trim().max(180),
  location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).optional(),
});
const requestCodec = {
  mode: 'strict',
  typeSymbol: packageName + '#SearchRequest',
  create: () => query,
  jsonSchema: {
    type: 'object',
    properties: {
      area: { type: 'string', minLength: 1, maxLength: 180 },
      place: { type: 'string', maxLength: 180 },
      location: { type: 'object', required: ['lat', 'lon'], properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lon: { type: 'number', minimum: -180, maximum: 180 },
      } },
    },
    required: ['area', 'place'],
  },
};
const resultCodec = {
  mode: 'strict', typeSymbol: packageName + '#SearchResult', create: () => z.json(), jsonSchema: {},
};

export const REMOTE = createTypertRemoteInfo({
  package: packageName,
  methods: {
    'workbenchMaps/search': {
      service: 'workbenchMaps',
      invocation: { kind: 'direct' },
      description: 'Search OpenStreetMap place data through the configured Photon service.',
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec, strictCodec: requestCodec }],
      cancellation: { parameter: 'signal' },
      result: resultCodec,
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
