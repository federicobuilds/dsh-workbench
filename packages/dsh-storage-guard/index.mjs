import { RESOURCE_DOMAIN_SPEC, createResource } from './resource.mjs';

export const name = 'dsh-storage-guard';
export const inject = ['tools'];

export async function apply(ctx, config = {}) {
  let cleanup = () => {};
  ctx.effect?.(() => () => cleanup());
  const storage = ctx.get('storageDomain');
  let domain = storage?.get?.(RESOURCE_DOMAIN_SPEC.name);
  let owned = false;
  if (!domain && storage?.open) {
    domain = await storage.open(RESOURCE_DOMAIN_SPEC);
    owned = true;
  }
  const resource = createResource(ctx, domain, config.resource ?? {});
  const unregister = ctx.get('tools').register(resource.toolDefinition());
  cleanup = async () => {
    unregister?.();
    resource.dispose();
    if (owned) await domain?.close?.();
  };
  return cleanup;
}
