import { applyGates } from './gates-core.mjs';
import { EVENTS_DOMAIN_SPEC, createEventStore } from './event-store.mjs';

export const name = 'dsh-mcp-gate';
export const inject = ['tools'];

export async function apply(ctx) {
  let cleanup = () => {};
  ctx.effect?.(() => () => cleanup());
  const storage = ctx.get('storageDomain');
  let domain = storage?.get?.(EVENTS_DOMAIN_SPEC.name);
  let owned = false;
  if (!domain && storage?.open) {
    domain = await storage.open(EVENTS_DOMAIN_SPEC);
    owned = true;
  }
  let disposePreStep;
  const scoped = {
    get: (key) => ctx.get(key),
    on: (event, fn) => {
      const dispose = ctx.on(event, fn);
      if (event === 'agent/pre-step') disposePreStep = dispose;
      return dispose;
    },
  };
  const disposeGates = await applyGates(scoped, domain ? createEventStore(domain) : null);
  cleanup = async () => {
    disposeGates();
    disposePreStep?.();
    if (owned) await domain?.close?.();
  };
  return cleanup;
}
