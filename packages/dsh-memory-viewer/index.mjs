import { createMemoryPreview } from './memory-preview.mjs';

export const name = 'dsh-memory-viewer';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const preview = createMemoryPreview(ctx, config);
  const unregister = ctx.get('tools').register(preview.toolDefinition());
  const cleanup = async () => {
    unregister?.();
    await preview.dispose();
  };
  ctx.effect?.(() => () => cleanup());
  return cleanup;
}
