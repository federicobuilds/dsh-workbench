import { randomUUID } from 'node:crypto';
import { redactText } from './redaction.mjs';
import { redactToolResult } from './tool-result-policy.mjs';

export const name = 'dsh-secret-redactor';

export function apply(ctx) {
  const dispose = ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const redacted = redactToolResult(result);
      if (!redacted.decision) return next();
      try {
        const domain = ctx.get('storageDomain')?.get?.('dsh_governance_events');
        const id = randomUUID();
        const event = { v: 1, id, ts: Date.now(), kind: 'redaction', session: exec?.agent?.session?.id ?? null,
          decision: redacted.decision.kind === 'block' ? 'blocked' : 'redacted',
          reason: `${redacted.hits} detected secret shape(s) removed from the tool result` };
        if (exec?.name !== undefined) event.tool = redactText(String(exec.name)).text.slice(0, 80);
        if (domain) void Promise.resolve(domain.table('events').put(id, event)).catch(() => {});
      } catch {}
      return redacted.decision;
    } catch {
      return { kind: 'block', feedback: [{ type: 'text', text: 'Tool result withheld: secret redaction could not complete safely.' }] };
    }
  });
  ctx.effect?.(() => dispose);
  return dispose;
}
