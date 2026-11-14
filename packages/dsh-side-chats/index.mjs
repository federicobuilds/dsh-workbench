import { isDeepStrictEqual } from 'node:util';
import { Remote, RemoteError, principalOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT, linkSchema } from './remote.mjs';

export const name = 'dsh-side-chats';
export const inject = ['typert', 'storageDomain', 'sessionQuery'];

const domainSpec = { name: 'dsh_side_chats', version: 1, tables: { links: { valueSchema: linkSchema } } };
const initializers = [];

function assertOwner(ctx) {
  if (!ctx.invocation || principalOf(ctx.invocation) !== undefined) {
    throw new RemoteError('gateway/bad-request', 'Side chat links are available to the owner only.');
  }
}

class SideChatLinks extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'dshSideChatLinks');
    for (const initialize of initializers) initialize.call(this);
  }

  async table() {
    this.domain ??= Promise.resolve().then(() => {
      const store = this.ctx.get('storageDomain');
      return store.get(domainSpec.name) ?? store.open(domainSpec);
    }).catch(error => {
      this.domain = undefined;
      throw error;
    });
    return (await this.domain).table('links');
  }

  async read(childId) {
    assertOwner(this.ctx);
    return (await this.table()).get(childId) ?? null;
  }

  async record(childId, link) {
    assertOwner(this.ctx);
    if (childId === link.sessionId) throw new Error('A side chat and its parent must be different.');
    const table = await this.table();
    const stored = table.get(childId);
    if (stored) {
      if (!isDeepStrictEqual(stored, link)) throw new Error('This side chat already has a source.');
      return stored;
    }
    const query = this.ctx.get('sessionQuery');
    const child = await query.observeSession(childId);
    try {
      const parent = await query.observeSession(link.sessionId);
      try {
        const inherited = child.events[link.boundary];
        const original = parent.events[link.boundary];
        if (link.routed) {
          if (!original || child.inheritedEventCount > 0 || child.events.some(event => event.type === 'user/message')) {
            throw new Error('A routed chat must be empty and have a valid parent event.');
          }
        } else if (!link.sourceKey || child.inheritedEventCount !== link.boundary + 1 || !original || !isDeepStrictEqual(inherited, original)) {
          throw new Error('The side chat does not match the proposed parent event.');
        }
        await table.put(childId, link);
        return link;
      } finally {
        parent[Symbol.dispose]();
      }
    } finally {
      child[Symbol.dispose]();
    }
  }
}

for (const method of ['read', 'record']) {
  Remote(SideChatLinks.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer(initialize) { initializers.push(initialize); },
  });
}

export function apply(ctx) {
  ctx.get('typert').register(TYPERT);
  new SideChatLinks(ctx);
}
