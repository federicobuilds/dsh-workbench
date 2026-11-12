import { z } from 'zod';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const idCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string().min(1), jsonSchema: { type: 'string', minLength: 1 } };
const resultCodec = { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-skill-mcp-router#Recommendation', create: () => z.json(), jsonSchema: {} };
const REMOTE = createTypertRemoteInfo({ package: '@dsh-workbench/dsh-skill-mcp-router', methods: {
  'routerRecommendationUi/latest': {
    service: 'routerRecommendationUi', invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
    description: 'Read the latest router recommendation for this session.',
    parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: idCodec, strictCodec: idCodec }],
    cancellation: { parameter: 'signal' }, result: resultCodec,
  },
} }, z);
const TYPERT = { package: '@dsh-workbench/dsh-skill-mcp-router', face: 'host', schemas: [],
  get invocations() { return REMOTE.descriptors; },
  model: { services: [], objects: [], types: [], events: [], contexts: [], lookups: [] } };

export function registerRecommendationRemote(ctx) {
  const initializers = [];
  class RouterRecommendationUi extends TypertRemoteService {
    constructor() {
      super(ctx, 'routerRecommendationUi');
      for (const initialize of initializers) initialize.call(this);
    }
    async latest(agent, signal) { return this.ctx.get('routerRecommendation').latest(agent.session.id); }
  }
  Remote(RouterRecommendationUi.prototype.latest, {
    kind: 'method', name: 'latest', static: false, private: false,
    addInitializer(fn) { initializers.push(fn); },
  });
  ctx.get('typert').register(TYPERT);
  new RouterRecommendationUi();
}
