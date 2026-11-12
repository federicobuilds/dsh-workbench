import { createDeleteOperations } from './delete.mjs';
import { TYPERT, NAMESPACE } from './protocol.mjs';
import { guardSessionSystemHead } from './history-write-guard.mjs';
import { installBoundedSummarizer } from './bounded-summarizer.mjs';

export const name = 'session-tools';
export const inject = ['typert', 'sessionPersistence', 'workspaceRegistry', 'sessions', 'agents', 'storageDomain'];

export function apply(ctx) {
  const lifetime = new AbortController();
  const running = new Set();
  const historyGuards = new Set();
  const compactionGuards = new WeakMap();
  const compactionReferences = new Set();
  /** Cover root and per-agent compaction services without retaining unloaded agents. */
  function protectCompaction(engine) {
    if (typeof engine?.summarize !== 'function' || compactionGuards.has(engine)) return;
    compactionGuards.set(engine, installBoundedSummarizer(engine, {
      onProgress: progress => console.info('[historyCompaction] progress', progress),
    }));
    compactionReferences.add(new WeakRef(engine));
  }
  /** Install before the agent loop can append a system prompt to imported history. */
  function protectHistory({ agent }) {
    if (agent?.session) historyGuards.add(guardSessionSystemHead(agent.session));
    protectCompaction(agent?.ctx?.get?.('compaction') ?? ctx.get('compaction'));
  }
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on('agent/created', protectHistory));
  protectCompaction(ctx.get('compaction'));
  const operations = createDeleteOperations({
    persistence: ctx.get('sessionPersistence'), registry: ctx.get('workspaceRegistry'),
    sessions: ctx.get('sessions'), agents: ctx.get('agents'),
    activity: id => ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])),
    cache: ctx.get('storageDomain').get('session_projcache')?.table('sessions'),
    onRefusal: info => console.warn('[chatDelete] refusal', info),
  });
  function invoke(service, method, args, signal) {
    const invocation = service.ctx.invocation;
    const peer = invocation?.peer;
    if (invocation?.service !== NAMESPACE || peer?.principal?.kind !== 'owner' || peer.signal.aborted) {
      throw new Error('Chat deletion requires an authenticated owner connection.');
    }
    const control = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const promise = operations[method](...args, peer.id, control);
    running.add(promise);
    promise.finally(() => running.delete(promise)).catch(() => {});
    return promise;
  }
  const service = {
    ctx,
    // Cordis Service.tracker contract: the gateway caller's context supplies invocation.
    [Symbol.for('cordis.tracker')]: { property: 'ctx', associate: NAMESPACE },
    prepare(sessionId, signal) { return invoke(this, 'prepare', [sessionId], signal); },
    commit(sessionId, token, signal) { return invoke(this, 'commit', [sessionId, token], signal); },
  };
  service.typertRemote = Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE });
  ctx.provide(NAMESPACE, service);
  ctx.effect(() => ctx.get('typert').register(TYPERT));
  ctx.effect(() => async () => {
    lifetime.abort();
    operations.dispose();
    for (const release of historyGuards) release();
    historyGuards.clear();
    for (const reference of compactionReferences) {
      const engine = reference.deref();
      if (engine) compactionGuards.get(engine)?.();
    }
    compactionReferences.clear();
    await Promise.allSettled([...running]);
  });
}
