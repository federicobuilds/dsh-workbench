const passSchema = {
  parse(val) {
    return val;
  },
  optional() {
    return this;
  },
  readonly() {
    return this;
  },
};

export const sessionProjectionStateSchema = {
  parse(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || (raw.sessionId !== null && typeof raw.sessionId !== 'string')
      || typeof raw.workspace !== 'string'
      || !Array.isArray(raw.activeJobIds) || raw.activeJobIds.some(id => typeof id !== 'string')) {
      throw new Error('Invalid taskProgress projection state');
    }
    return raw;
  },
};

export const sessionProjectionViewSchema = {
  parse(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid taskProgress projection view');
    }
    return raw;
  },
};

const idCodec = {
  mode: 'strict',
  typeSymbol: '@dsh-workbench/dsh-task-progress#SessionId',
  create: () => ({
    parse(val) {
      if (typeof val !== 'string' || !val) throw new Error('Invalid sessionId');
      return val;
    },
    optional() {
      return this;
    },
  }),
  jsonSchema: { type: 'string', minLength: 1 },
};

const resultCodec = {
  mode: 'strict',
  typeSymbol: '@dsh-workbench/dsh-task-progress#Snapshot',
  create: () => passSchema,
  jsonSchema: {},
};

const snapshotParameters = [
  {
    name: 'agent',
    wire: 'agentId',
    source: 'lookup',
    lookup: 'agent',
    codec: idCodec,
    strictCodec: idCodec,
  },
];

const snapshotInputSchema = {
  parse(input) {
    if (!input || typeof input !== 'object' || typeof input.agentId !== 'string' || !input.agentId) {
      throw new Error('Invalid snapshot input: agentId required');
    }
    return { agentId: input.agentId };
  },
};

export const snapshotDescriptor = Object.freeze({
  id: '@dsh-workbench/dsh-task-progress#taskProgress/snapshot',
  namespace: 'taskProgress',
  method: 'snapshot',
  service: 'taskProgress',
  invocation: { kind: 'direct' },
  scope: { context: 'agent', wire: 'agentId' },
  description: 'Read the Host-calibrated EVM, analogy, survival, and stoplight forecast snapshot for the caller session.',
  parameters: snapshotParameters,
  cancellation: { parameter: 'signal' },
  result: resultCodec,
  input() {
    return {
      create: () => snapshotInputSchema,
      toJSONSchema: () => ({
        type: 'object',
        required: ['agentId'],
        additionalProperties: false,
        properties: { agentId: { type: 'string', minLength: 1 } },
      }),
    };
  },
  invoke(remote, input, signal) {
    return remote.taskProgress.snapshot(input.agentId, signal);
  },
});

export const TYPERT = Object.freeze({
  package: '@dsh-workbench/dsh-task-progress',
  face: 'host',
  schemas: [],
  invocations: [snapshotDescriptor],
  model: {
    services: [],
    objects: [],
    types: [],
    events: [],
    contexts: [],
    lookups: [],
  },
});
