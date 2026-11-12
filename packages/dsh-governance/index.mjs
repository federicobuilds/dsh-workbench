/** @dsh-workbench/dsh-governance — the full DSH governance port for DSH.
 * Composes the complete runtime: lane/route gate + dispatch/review facade,
 * judge tool, MCP discipline gate, secret redaction, role->model bindings,
 * verification (`check` + foreground/background exit correlation + testGuard),
 * resource ledger (`resource` + disk floor + docker labels), efficiency
 * observer (`efficiency_override`), descendant worker inspection (`worker_messages`),
 * project memory preview + companion validation (`memory_preview`), system prompt
 * rules/style/model notes + search-scope gate, and a single durable decision/event log.
 */
import { applyFacade } from './facade-core.mjs';
import { applyGates } from './gates-core.mjs';
import { applyBindings, compactionAssignment } from './bindings.mjs';
import { toolDefinition as judgeToolDefinition } from './judge.mjs';
import { EVENTS_DOMAIN_SPEC, createEventStore } from './event-store.mjs';
import { decisionEvent, recordDecision, withLogOutcome } from './decision-events.mjs';
import { TRACK_DOMAIN_SPEC } from './tracks.mjs';
import { WORKER_DOMAIN_SPEC, createWorkerGuard } from './worker-guard.mjs';
import { VERIFICATION_DOMAIN_SPEC, createVerification } from './verification.mjs';
import { RESOURCE_DOMAIN_SPEC, createResource } from './resource.mjs';
import { createEfficiency } from './efficiency.mjs';
import { createWorkerMessages } from './worker-messages.mjs';
import { createMemoryPreview } from './memory-preview.mjs';
import { applySystemHooks } from './system-hooks.mjs';

export const name = 'dsh-governance';
export const inject = ['tools'];

const svc = (ctx, n) => { if (ctx == null) return undefined; return typeof ctx.get === 'function' ? ctx.get(n) : ctx[n]; };

export async function apply(ctx, config) {
  const disposers = [];
  let cleanupRef = () => {};
  const enableVerificationLedger = config?.disableBundledVerificationLedger !== true;
  const enableMemoryViewer = config?.disableBundledMemoryViewer !== true;
  const enableMcpGate = config?.disableBundledMcpGate !== true;
  // Register ctx.effect synchronously BEFORE any await so Cordis always binds it to this fiber.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { cleanupRef(); });
  }

  const realTools = svc(ctx, 'tools');
  // Wrap tools.guard so an async function can NEVER be registered on synchronous checkGuards
  // (async guards are bridged to tools/pre-execute waterfall; sync guards strictly return string | undefined).
  const safeTools = realTools ? {
    ...realTools,
    register: (def, opts) => {
      const d = realTools.register(def, opts);
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    guard: (fn) => {
      // tools.guard is synchronous; a Promise return value would deny every tool call.
      if (fn?.constructor?.name === 'AsyncFunction') {
        throw new TypeError('dsh-governance: tools.guard requires a synchronous function; use ctx.on("tools/pre-execute") for async checks');
      }
      const d = realTools.guard((exec) => {
        try {
          const reason = fn(exec);
          return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
        } catch {
          return 'kilo harness guard failure: tool denied (fail closed)';
        }
      });
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
  } : undefined;

  const safeCtx = {
    get: (n) => (n === 'tools' ? safeTools : svc(ctx, n)),
    on: (event, fn) => {
      if (typeof ctx.on !== 'function') return () => {};
      const d = ctx.on(event, fn);
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
  };

  const bindingsDispose = applyBindings(safeCtx);
  if (typeof bindingsDispose === 'function') disposers.push(bindingsDispose);
  const sysHooksDispose = applySystemHooks(safeCtx, undefined, config);
  if (typeof sysHooksDispose === 'function') disposers.push(sysHooksDispose);

  const storageDomain = svc(ctx, 'storageDomain');
  const openOrReuse = async (spec) => {
    if (!storageDomain) return null;
    try {
      const existing = storageDomain.get?.(spec.name);
      if (existing) return existing;
      return await storageDomain.open?.(spec);
    } catch {
      return storageDomain.get?.(spec.name) ?? null;
    }
  };

  const domain = await openOrReuse(EVENTS_DOMAIN_SPEC);
  const sharedEvents = domain ? createEventStore(domain) : null;
  const tracks = await openOrReuse(TRACK_DOMAIN_SPEC);
  const workers = await openOrReuse(WORKER_DOMAIN_SPEC);

  const split = compactionAssignment?.target?.indexOf('/') ?? -1;
  const compactionRoute = split > 0 ? { provider:compactionAssignment.target.slice(0,split), model:compactionAssignment.target.slice(split+1), effort:compactionAssignment.variant ?? null } : null;
  const workerGuard = createWorkerGuard(safeCtx, workers, { compactionRoute });

  const verificationDomain = enableVerificationLedger ? await openOrReuse(VERIFICATION_DOMAIN_SPEC) : null;
  const verification = enableVerificationLedger ? createVerification(safeCtx, verificationDomain, config?.verification ?? {}) : null;

  const resourceDomain = enableVerificationLedger ? await openOrReuse(RESOURCE_DOMAIN_SPEC) : null;
  const resource = enableVerificationLedger ? createResource(safeCtx, resourceDomain, { ...(config?.resource ?? {}), events: sharedEvents }) : null;
  const efficiency = enableVerificationLedger ? createEfficiency(safeCtx, { ...(config?.efficiency ?? {}), events: sharedEvents, verification }) : null;
  const workerMessages = createWorkerMessages(safeCtx);
  const memoryPreview = enableMemoryViewer ? createMemoryPreview(safeCtx, config?.memory ?? {}) : null;

  if (safeTools && typeof safeTools.register === 'function') {
    if (enableVerificationLedger) {
      safeTools.register({
      name: 'check',
      description: 'Decide whether verification runs fresh, reuses valid proof, skips or uses a registered equivalent alternative. Never executes commands. Pass credit requires native successful execution after the last edit.',
      parameters: { type: 'object', additionalProperties: false, required: ['target', 'purpose'], properties: { target: { type: 'string' }, purpose: { type: 'string' }, override_reason: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => verification.decide(args, exec),
      });
      safeTools.register(resource.toolDefinition());
      safeTools.register(efficiency.toolDefinition());
    }
    safeTools.register(workerMessages.toolDefinition());
    if (enableMemoryViewer) safeTools.register(memoryPreview.toolDefinition());
  }

  const facadeDispose = await applyFacade(safeCtx, config, sharedEvents, workerGuard, {
    coordinatorDefaultOnStandard: config?.defaultCoordinatorOnStandard !== false,
  });
  if (typeof facadeDispose === 'function') disposers.push(facadeDispose);
  if (enableMcpGate) {
    const gatesDispose = await applyGates(safeCtx, sharedEvents);
    if (typeof gatesDispose === 'function') disposers.push(gatesDispose);
  }

  if (safeTools && typeof safeTools.register === 'function') {
    const judgeDefinition = judgeToolDefinition();
    const executeJudge = judgeDefinition.execute;
    judgeDefinition.execute = async (args, exec) => {
      const raw = await executeJudge(args, exec);
      if (args?.action !== 'dispatch') return raw;
      const receipt = JSON.parse(raw);
      const event = { ...decisionEvent('judge', exec, receipt), tool: 'dsh_judge' };
      const recorded = await recordDecision(sharedEvents, event);
      return JSON.stringify(withLogOutcome(receipt, recorded));
    };
    safeTools.register(judgeDefinition);
  }

  cleanupRef = async () => {
    for (const d of disposers.splice(0)) { try { await d(); } catch { /* best-effort */ } }
    try { workerGuard.dispose(); } catch {}
    if (enableVerificationLedger) {
      try { verification.dispose(); } catch {}
      try { resource.dispose(); } catch {}
      try { efficiency.dispose(); } catch {}
    }
    if (enableMemoryViewer) {
      try { await memoryPreview.dispose(); } catch {}
    }
    try { await resourceDomain?.close?.(); } catch {}
    try { await verificationDomain?.close?.(); } catch {}
    try { await workers?.close?.(); } catch {}
    try { await tracks?.close?.(); } catch {}
    try { await domain?.close?.(); } catch {}
  };

  return cleanupRef;
}
