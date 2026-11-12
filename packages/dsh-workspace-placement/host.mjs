import { PLACEMENT_NAMESPACE, TYPERT } from './protocol.mjs';
import { createPlacementOperations } from './placement.mjs';

export const name = 'workspace-placement';
export const inject = ['typert', 'sessionPersistence', 'workspaceRegistry', 'sessions', 'agents', 'storageDomain'];

export function apply(ctx) {
  const lifetime = new AbortController();
  const running = new Set();
  const placement = createPlacementOperations({
    storageDomain: ctx.get('storageDomain'), persistence: ctx.get('sessionPersistence'), registry: ctx.get('workspaceRegistry'),
    sessions: ctx.get('sessions'), agents: ctx.get('agents'),
    activity: id => ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])),
  });
  function invokePlacement(service, method, args, signal) {
    const invocation = service.ctx.invocation;
    const peer = invocation?.peer;
    if (invocation?.service !== PLACEMENT_NAMESPACE || peer?.principal?.kind !== 'owner' || !peer.signal || peer.signal.aborted) return Promise.resolve({ ok: false, reason: 'unauthorized' });
    const signals = [peer.signal, lifetime.signal, ...(signal ? [signal] : [])];
    if (signals.some(item => item.aborted)) return Promise.resolve({ ok: false, reason: 'unavailable' });
    const promise = placement[method](...args, AbortSignal.any(signals));
    running.add(promise);
    promise.finally(() => running.delete(promise)).catch(() => {});
    return promise;
  }
  const placementService = {
    ctx,
    [Symbol.for('cordis.tracker')]: { property: 'ctx', associate: PLACEMENT_NAMESPACE },
    moveSessionReference(sessionId, workspaceId, signal) { return invokePlacement(this, 'moveSessionReference', [sessionId, workspaceId], signal); },
    appendTaskReference(fields, signal) { return invokePlacement(this, 'appendTaskReference', [fields], signal); },
    detachReference(eventId, signal) { return invokePlacement(this, 'detachReference', [eventId], signal); },
    listReferences(signal) { return invokePlacement(this, 'listReferences', [], signal); },
  };
  placementService.typertRemote = Object.freeze({ service: placementService, serviceKey: PLACEMENT_NAMESPACE, namespace: PLACEMENT_NAMESPACE });
  ctx.provide(PLACEMENT_NAMESPACE, placementService);
  ctx.effect(() => ctx.get('typert').register(TYPERT));
  ctx.effect(() => async () => {
    lifetime.abort();
    placement.dispose();
    await Promise.allSettled([...running]);
  });
}
