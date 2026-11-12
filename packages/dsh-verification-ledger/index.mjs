import { VERIFICATION_DOMAIN_SPEC, createVerification } from './verification.mjs';
import { createEfficiency } from './efficiency.mjs';

export const name = 'dsh-verification-ledger';
export const inject = ['tools'];

export async function apply(ctx, config = {}) {
  let cleanup = () => {};
  ctx.effect?.(() => () => cleanup());
  const storage = ctx.get('storageDomain');
  const owned = [];
  const open = async (spec) => {
    const existing = storage?.get?.(spec.name);
    if (existing) return existing;
    if (!storage?.open) return null;
    const domain = await storage.open(spec);
    owned.push(domain);
    return domain;
  };
  const verificationDomain = await open(VERIFICATION_DOMAIN_SPEC);
  const verification = createVerification(ctx, verificationDomain, config.verification ?? {});
  const efficiency = createEfficiency(ctx, { ...(config.efficiency ?? {}), verification });
  const tools = ctx.get('tools');
  const unregisterCheck = tools.register({
    name: 'check',
    description: 'Decide whether verification runs fresh, reuses valid proof, skips or uses a registered equivalent alternative. Never executes commands.',
    parameters: { type: 'object', additionalProperties: false, required: ['target', 'purpose'], properties: { target: { type: 'string' }, purpose: { type: 'string' }, override_reason: { type: 'string' } } },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => verification.decide(args, exec),
  });
  const unregisterEfficiency = tools.register(efficiency.toolDefinition());
  cleanup = async () => {
    unregisterCheck?.();
    unregisterEfficiency?.();
    verification.dispose();
    efficiency.dispose();
    for (const domain of owned) await domain?.close?.();
  };
  return cleanup;
}
