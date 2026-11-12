import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePolicy } from './policy.mjs';
import { trackPolicyReader } from './tracks.mjs';
import { createEventStore, makeEvent } from './event-store.mjs';
import { redactText } from './redaction.mjs';

export const EFF_V = 1;
export const EFF_POLICY_V = 2;
export const EFF_FACTS = 20;
export const EFF_EXCERPT = 512;
export const OBJ_REQUESTS = 3;
export const OBJ_CHARS = 4000;
export const EFF_REASON_MAX = 300;
export const EFF_IDS_MAX = 4;
export const EFF_ENVELOPE_MAX = 1024;
export const OBJ_SEP = '\n---\n';

const CONTINUE_TEXT = /^\s*(continue|proceed|go on|keep going)\s*[.!]?\s*$/i;
const INTERNAL_TEXT = /^\s*(<task_result>|<task[\s>]|task_id:|<system-reminder>|\[(wakeup|cron|scheduled)\b|Completion gate \(harness\))/i;
const EFF_ENVELOPE = /^kilo\.efficiency_override[ \t]+(\{.*\})$/m;

const sha1 = (data) => createHash('sha1').update(data).digest('hex');

/**
 * Clip stored requests, newest first, so their joined form fits OBJ_CHARS;
 * a clipped request stays marked so the objective can never read complete.
 */
export function boundRequests(requests) {
  let budget = OBJ_CHARS - OBJ_SEP.length * (requests.length - 1);
  return requests
    .slice()
    .reverse()
    .map((r) => {
      const text = r.text.slice(0, Math.max(0, budget));
      budget -= text.length;
      return {
        id: r.id,
        text,
        ...(r.clipped || text.length < r.text.length ? { clipped: true } : {}),
      };
    })
    .reverse();
}

export const unknownObjective = (
  goal_source = 'missing',
  provenance = [],
  origin = 'unknown',
  requests = [],
) => ({
  v: EFF_V,
  objective_state: 'unknown',
  text: null,
  goal_source,
  provenance,
  origin,
  complete: false,
  requests,
});

/**
 * Fold one user-role message into the objective: internal text supplements,
 * a bare continue carries the goal, anything else becomes the newest of at most
 * three requests. Over 4000 characters the objective is truncated and unknown.
 */
export function foldObjective(prev, text, id = 'unknown', origin = 'observed') {
  const t = String(text ?? '').trim();
  if (!t) return prev ?? unknownObjective('missing');
  if (prev?.requests?.at(-1)?.id === id && id !== 'unknown') return prev;
  const seen = [...(prev?.provenance ?? []), id].slice(-8);
  if (INTERNAL_TEXT.test(t)) {
    return prev ? { ...prev, provenance: seen } : unknownObjective('ambiguous', [id], origin);
  }
  if (CONTINUE_TEXT.test(t)) {
    return prev?.complete
      ? { ...prev, goal_source: 'carried', provenance: seen }
      : prev?.requests?.length
        ? { ...prev, provenance: seen }
        : unknownObjective('missing', [id], origin);
  }
  const requests = boundRequests([...(prev?.requests ?? []), { id, text: t }].slice(-OBJ_REQUESTS));
  const ids = requests.map((r) => r.id);
  if (requests.some((r) => r.clipped)) return unknownObjective('truncated', ids, origin, requests);
  return {
    v: EFF_V,
    objective_state: 'known',
    text: requests.map((r) => r.text).join(OBJ_SEP),
    goal_source: 'newest',
    provenance: ids,
    origin,
    complete: true,
    requests,
  };
}

export function validObjective(o) {
  return Boolean(
    o?.v === EFF_V
    && ['known', 'unknown'].includes(o.objective_state)
    && (o.text === null || typeof o.text === 'string')
    && ['newest', 'carried', 'missing', 'ambiguous', 'truncated'].includes(o.goal_source)
    && Array.isArray(o.provenance)
    && o.provenance.every((x) => typeof x === 'string')
    && ['observed', 'unknown'].includes(o.origin)
    && typeof o.complete === 'boolean'
    && Array.isArray(o.requests)
    && o.requests.length <= OBJ_REQUESTS
    && o.requests.every(
      (r) => typeof r?.id === 'string'
        && typeof r?.text === 'string'
        && (r.clipped === undefined || r.clipped === true),
    )
    && o.requests.reduce((n, r) => n + r.text.length, 0) <= OBJ_CHARS
    && (o.complete || o.text === null)
    && o.complete === (
      o.objective_state === 'known'
      && typeof o.text === 'string'
      && o.text.length <= OBJ_CHARS
      && !o.requests.some((r) => r.clipped)
      && o.text === o.requests.map((r) => r.text).join(OBJ_SEP)
    ),
  );
}

export function validFact(f) {
  return Boolean(
    typeof f?.id === 'string'
    && typeof f.tool === 'string'
    && typeof f.key === 'string'
    && typeof f.excerpt === 'string'
    && f.excerpt.length <= EFF_EXCERPT
    && (f.fingerprint === null || typeof f.fingerprint === 'string')
    && typeof f.state === 'string'
    && (f.linkage === undefined || f.linkage === null || typeof f.linkage === 'string')
    && (f.scope === undefined || f.scope === null || typeof f.scope === 'string')
    && (f.brief === undefined || (typeof f.brief === 'string' && f.brief.length <= 1200)),
  );
}

export function envelopeOf(text) {
  if (typeof text !== 'string') return null;
  const m = EFF_ENVELOPE.exec(text);
  if (!m || Buffer.byteLength(m[1]) > EFF_ENVELOPE_MAX) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export const stripEnvelope = (text) =>
  typeof text === 'string' ? text.replace(new RegExp(EFF_ENVELOPE.source, 'gm'), '').trim() : '';

export function effOverrideOf(raw, valid) {
  const reason = raw?.efficiency_override_reason ?? raw?.reason;
  const ids = raw?.evidence_ids;
  if (typeof reason !== 'string' || /[\r\n]/.test(reason)) return null;
  const r = reason.trim();
  if (!r || r.length > EFF_REASON_MAX || /^#?\s*OVERRIDE\b/i.test(r)) return null;
  if (!Array.isArray(ids) || !ids.length || ids.length > EFF_IDS_MAX) return null;
  if (!ids.every((i) => typeof i === 'string' && valid.has(i))) return null;
  return { reason: r, evidence_ids: ids };
}

export function effAssess(r, alts, protectedWhy = null) {
  if (protectedWhy) return { decision: 'proceed', alternative_id: 'none', evidence_ids: [], why: protectedWhy };
  const alt = r?.decision === 'reconsider' ? alts.find((a) => a.id === r.alternative_id) : undefined;
  if (alt) {
    return {
      decision: 'reconsider',
      alternative_id: alt.id,
      evidence_ids: alt.evidence_ids,
      why: String(r.why ?? ''),
    };
  }
  return {
    decision: r?.decision === 'proceed' ? 'proceed' : 'unknown',
    alternative_id: 'none',
    evidence_ids: [],
    why: String(r?.why ?? ''),
  };
}

export function effPolicy(decision, override) {
  if (decision !== 'reconsider' || override) return 'allow';
  return 'block';
}

const unitIDs = (text) => {
  try {
    const value = JSON.parse(text);
    if (typeof value?.unit === 'string') return [value.unit.toUpperCase()];
  } catch { /* prose */ }
  return [...new Set([...String(text).matchAll(/\bunit:?\s+([A-Z0-9][\w.-]*)/gi)].map((m) => m[1].toUpperCase()))];
};

export function taskScope(args) {
  const brief = String(args?.brief ?? args?.prompt ?? '');
  const explicit = unitIDs(brief);
  const named = /^Package:\s*([A-Za-z][\w.-]*)/im.exec(brief)?.[1];
  const references = [...brief.matchAll(/\b([A-Z]\d+[a-z]?)-(?:brief|handback|diffs)\b/g)].map((m) => m[1]);
  const units = [...new Set(explicit.length ? explicit : named ? [named] : references)].sort();
  const seat = String(args?.seat ?? args?.subagent_type ?? '');
  const role = /^(executor|reviewer|critic|auditor|explore)/.exec(seat)?.[1];
  return role && units.length ? `${role}:${units.join(',')}` : null;
}

const taskBody = (text) =>
  (/<task_result>([\s\S]*?)<\/task_result>/.exec(text)?.[1] ?? String(text ?? '').replace(/^task_id:.*$/gm, '')).trim();

const isDelegationTool = (tool) => tool === 'task' || tool === 'dsh_dispatch';

export function actionKey(tool, args) {
  if (isDelegationTool(tool)) {
    const seat = args?.seat ?? args?.subagent_type ?? '';
    const prompt = args?.brief ?? args?.prompt ?? '';
    return `task ${seat} ${sha1(stripEnvelope(String(prompt)))}`;
  }
  if (tool === 'read') {
    const filePath = args?.file_path ?? args?.filePath ?? '';
    return `read ${JSON.stringify({
      filePath: resolve(String(filePath)),
      offset: args?.offset ?? 1,
      limit: args?.limit ?? 2000,
    })}`;
  }
  return `${tool} ${JSON.stringify(args ?? {})}`;
}

const svc = (ctx, name) => {
  if (ctx == null) return undefined;
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
};

/** Create the efficiency observer and `efficiency_override` tool handler. */
export function createEfficiency(ctx, config = {}) {
  const objectives = new Map();
  const factsBy = new Map();
  const assessments = new Map();
  const checkpoints = new Map();
  const editsBy = new Map();
  const sharedEvents = config.events ?? null;
  const readFingerprintFn = config.readFingerprint ?? async function defaultReadPrint(args) {
    const filePath = String(args?.file_path ?? args?.filePath ?? '');
    if (!filePath) return null;
    const data = await readFile(resolve(filePath)).catch(() => null);
    return data ? `sha1:${sha1(data)}` : null;
  };

  async function journal(sessionId, decision, reason, extra = {}) {
    try {
      const store = sharedEvents ?? (() => {
        const d = svc(ctx, 'storageDomain')?.get?.('dsh_governance_events');
        return d ? createEventStore(d) : null;
      })();
      if (!store) return;
      const ev = makeEvent({ kind: 'efficiency', session: sessionId, decision, reason, ...extra });
      ev.id = randomUUID();
      ev.permissionGranted = false;
      await store.record(ev);
    } catch { /* best-effort */ }
  }

  function editMark(sessionId) {
    if (typeof config.editMark === 'function') return config.editMark(sessionId);
    const verification = svc(ctx, 'verification') ?? config.verification;
    if (verification && typeof verification.editRevision === 'function') {
      return `rev:${verification.editRevision(sessionId)}`;
    }
    return `rev:${editsBy.get(sessionId) ?? 0}`;
  }

  function noteMessage(sessionId, text, id = 'unknown', origin = 'observed') {
    const redacted = redactText(String(text ?? '')).text;
    if (!redacted.trim()) return objectives.get(sessionId) ?? unknownObjective('missing');
    const prev = objectives.get(sessionId);
    const next = foldObjective(
      prev && (prev.requests.length || prev.provenance.length) ? prev : undefined,
      redacted,
      String(id),
      origin,
    );
    objectives.set(sessionId, next);
    return next;
  }

  function getObjective(sessionId, agent) {
    const known = objectives.get(sessionId);
    if (known) return known;
    const derived = agent?.session?.deriveMessages?.() ?? [];
    let folded;
    for (const m of derived.filter((msg) => msg?.role === 'user').slice(-10)) {
      const text = (m.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) folded = foldObjective(folded, redactText(text).text, String(m.id ?? 'unknown'), 'unknown');
    }
    if (folded) {
      objectives.set(sessionId, folded);
      return folded;
    }
    const goals = svc(ctx, 'goals');
    const goal = agent ? goals?.get?.(agent) : null;
    if (typeof goal?.objective === 'string' && goal.objective.trim()) {
      const built = foldObjective(undefined, redactText(goal.objective).text, String(goal.id ?? 'goal'), 'observed');
      objectives.set(sessionId, built);
      return built;
    }
    const missing = unknownObjective('missing');
    objectives.set(sessionId, missing);
    return missing;
  }

  async function recordFact(sessionId, tool, args, output) {
    const normalizedTool = isDelegationTool(tool) ? 'task' : tool;
    if (normalizedTool !== 'read' && normalizedTool !== 'task') return null;
    const text = typeof output === 'string'
      ? output
      : typeof output?.output === 'string'
        ? output.output
        : typeof output?.value === 'string'
          ? output.value
          : JSON.stringify(output?.value ?? output ?? '');
    const linkage = output?.childSessionId
      ?? output?.sessionId
      ?? output?.metadata?.sessionId
      ?? output?.metadata?.sessionID
      ?? output?.value?.childSessionId
      ?? null;
    const state = normalizedTool === 'read'
      ? 'completed'
      : typeof linkage !== 'string'
        ? 'unknown-linkage'
        : /<task_result>[\s\S]*\S[\s\S]*<\/task_result>/.test(text) || output?.status === 'dispatched' || output?.status === 'returned'
          ? 'returned'
          : 'started';
    const key = actionKey(normalizedTool, args);
    const body = normalizedTool === 'task' ? taskBody(text) : text;
    const prompt = String(args?.brief ?? args?.prompt ?? '');
    const fact = {
      id: `ev-${sha1(`${key}\0${sha1(body)}`).slice(0, 12)}`,
      tool: normalizedTool,
      key,
      excerpt: redactText(body).text.slice(0, EFF_EXCERPT),
      fingerprint: normalizedTool === 'read' ? await readFingerprintFn(args) : editMark(sessionId),
      state,
      ...(normalizedTool === 'task'
        ? {
            linkage: typeof linkage === 'string' ? linkage : null,
            scope: taskScope(args),
            brief: redactText(stripEnvelope(prompt)).text.slice(0, 1200),
          }
        : {}),
    };
    const facts = factsBy.get(sessionId) ?? [];
    if (facts.some((f) => f.id === fact.id && f.fingerprint === fact.fingerprint && f.state === fact.state)) {
      return fact;
    }
    factsBy.set(sessionId, [...facts.filter((f) => f.id !== fact.id), fact].slice(-EFF_FACTS));
    return fact;
  }

  function validEvidenceIds(sessionId) {
    const obj = objectives.get(sessionId);
    const facts = factsBy.get(sessionId) ?? [];
    return new Set([...(obj?.provenance ?? []), ...facts.map((f) => f.id)]);
  }

  async function checkpoint(sessionId, tool, args, exec = {}) {
    const normalizedTool = isDelegationTool(tool) ? 'task' : tool;
    if (normalizedTool !== 'task' && normalizedTool !== 'read') return null;
    const obj = getObjective(sessionId, exec.agent);
    if (!obj.complete) return null;
    const facts = factsBy.get(sessionId) ?? [];
    const mark = editMark(sessionId);
    if (mark === null) return null;
    const key = actionKey(normalizedTool, args);
    let alternatives = [];
    let readFingerprint = null;
    if (normalizedTool === 'task') {
      const scope = taskScope(args);
      alternatives = facts
        .filter(
          (f) => f.tool === 'task'
            && (f.key === key || (scope && f.scope === scope))
            && ['returned', 'started'].includes(f.state)
            && f.fingerprint === mark
            && f.linkage,
        )
        .map((f) => ({
          id: `alt-${f.id}`,
          kind: 'reuse_local_result',
          summary: `Inspect worker_messages session_id=${f.linkage} before repeating this ${f.state} delegation. Prior brief: ${(f.brief ?? '').slice(0, 250)}. Evidence: ${f.excerpt.slice(0, 220)}`,
          evidence_ids: [f.id],
        }));
    } else if (normalizedTool === 'read') {
      if (!facts.some((f) => f.tool === 'read' && f.key === key)) return null;
      readFingerprint = await readFingerprintFn(args);
      alternatives = facts
        .filter((f) => f.tool === 'read' && f.key === key && readFingerprint !== null && f.fingerprint === readFingerprint)
        .map((f) => ({
          id: `alt-${f.id}`,
          kind: 'reuse_local_result',
          summary: f.excerpt,
          evidence_ids: [f.id],
        }));
    }
    if (!alternatives.length) return null;

    const signature = sha1(
      JSON.stringify({
        policy: EFF_POLICY_V,
        session: sessionId,
        action: key,
        objective: obj.text,
        facts: facts.map((f) => `${f.id}\0${f.fingerprint}\0${f.state}`).sort(),
        mark,
      }),
    );
    const checkpointId = `ec-${signature.slice(0, 16)}`;
    const prompt = String(args?.brief ?? args?.prompt ?? '');
    const rawEnvelope = normalizedTool === 'task' ? envelopeOf(prompt) : null;
    const saved = checkpoints.get(checkpointId);
    const validIds = new Set([...obj.provenance, ...facts.map((f) => f.id)]);
    const override = effOverrideOf(rawEnvelope, validIds)
      ?? (saved?.session === sessionId && saved.signature === signature ? saved.override ?? null : null);

    const filePath = args?.file_path ?? args?.filePath ?? '';
    const seat = args?.seat ?? args?.subagent_type ?? '?';
    const action = normalizedTool === 'task'
      ? `delegate to ${seat}: ${stripEnvelope(prompt).slice(0, 1000)}`
      : `read ${filePath}`;

    let assessment = assessments.get(signature);
    if (!assessment) {
      let family = 'off';
      try { family = resolvePolicy(sessionId, trackPolicyReader(ctx)).mode ?? 'off'; } catch { /* default off */ }
      const judgeService = svc(ctx, 'dshJudge');
      let r = { decision: 'UNSURE', unavailable: true };
      if (judgeService && typeof judgeService.decide === 'function') {
        try {
          r = await judgeService.decide(
            {
              operation: 'efficiency',
              family,
              state: {
                objective: obj.text,
                action: redactText(action).text,
                alternatives: alternatives.map(({ id, kind, summary }) => ({ id, kind, summary })),
                evidence: facts.slice(-8).map((f) => ({ id: f.id, tool: f.tool, state: f.state, excerpt: f.excerpt })),
              },
            },
            { signal: exec.signal },
          );
        } catch {
          r = { decision: 'UNSURE', unavailable: true };
        }
      }
      if (r?.error || r?.unavailable) return null;
      assessment = effAssess(r, alternatives, null);
      assessments.set(signature, assessment);
    }

    const currentObjective = getObjective(sessionId, exec.agent);
    if (
      !currentObjective.complete
      || currentObjective.text !== obj.text
      || editMark(sessionId) !== mark
      || (normalizedTool === 'read' && (await readFingerprintFn(args)) !== readFingerprint)
    ) {
      return null;
    }

    if (override) {
      checkpoints.delete(checkpointId);
      await journal(sessionId, 'override-used', `Efficiency override consumed for ${checkpointId}: ${override.reason}`, {
        tool: normalizedTool,
      });
    }

    if (effPolicy(assessment.decision, override) === 'block') {
      const alternative = alternatives.find((alt) => alt.id === assessment.alternative_id);
      checkpoints.set(checkpointId, {
        session: sessionId,
        signature,
        evidence: [...obj.provenance, ...alternative.evidence_ids],
      });
      if (checkpoints.size > 100) checkpoints.delete(checkpoints.keys().next().value);
      const msg = redactText(
        `Efficiency checkpoint ${checkpointId}: this action appears to repeat work without new value.\n` +
        `${assessment.why}\n` +
        `Simpler route: ${alternative.summary}\n` +
        `Evidence IDs: ${alternative.evidence_ids.join(', ')}\n` +
        `Use that route. If fresh work is genuinely needed, call efficiency_override with checkpoint_id="${checkpointId}", ` +
        'a specific reason and relevant evidence_ids, then retry the identical action once. ' +
        'No safety, review, permission or disk requirement is waived.',
      ).text;
      await journal(sessionId, 'blocked', `Efficiency checkpoint ${checkpointId}: ${assessment.why}`, {
        tool: normalizedTool,
      });
      return msg;
    }
    return null;
  }

  async function override(args, exec = {}) {
    const sessionId = exec?.agent?.session?.id ?? exec?.sessionID ?? exec?.sessionId ?? '';
    const checkpointId = String(args?.checkpoint_id ?? '');
    const record = checkpoints.get(checkpointId);
    if (!record || record.session !== sessionId) {
      throw new Error(
        'Unknown or expired checkpoint for this session; retry the proposed action to obtain a current checkpoint.',
      );
    }
    const parsed = effOverrideOf(
      { efficiency_override_reason: args?.reason, evidence_ids: args?.evidence_ids },
      new Set(record.evidence),
    );
    if (!parsed || parsed.reason.length < 10) {
      throw new Error('Provide a specific single-line reason (10-300 chars) and evidence IDs from this checkpoint.');
    }
    record.override = { ...parsed, reason: redactText(parsed.reason).text };
    await journal(sessionId, 'override-granted', `Efficiency override recorded for ${checkpointId}: ${record.override.reason}`, {
      tool: 'efficiency_override',
    });
    const message = `Justification recorded for ${checkpointId}. Retry the identical action once. Changed evidence or objective invalidates this grant; other gates still apply.`;
    return {
      status: 'recorded',
      checkpoint_id: checkpointId,
      evidence_ids: parsed.evidence_ids,
      permissionGranted: false,
      message,
    };
  }

  // Async check: tools.guard is synchronous, so this must be a pre-execute waterfall step.
  const disposeGuard = typeof ctx?.on === 'function'
    ? ctx.on('tools/pre-execute', async (exec, next) => {
        const toolName = exec?.name;
        if (toolName !== 'read' && !isDelegationTool(toolName)) return next();
        const sessionId = exec?.agent?.session?.id;
        if (!sessionId) return next();
        try {
          const stop = await checkpoint(sessionId, toolName, exec.arguments ?? {}, exec);
          if (stop) return { kind: 'deny', reason: stop };
        } catch { /* best-effort */ }
        return next();
      })
    : null;

  const disposePreStep = typeof ctx?.on === 'function'
    ? ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
        try {
          const sid = agent?.session?.id;
          if (sid && Array.isArray(messages)) {
            const last = [...messages].reverse().find((m) => m?.role === 'user' && m.source?.kind === 'user');
            const text = (last?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
            if (text) noteMessage(sid, text, String(last.id ?? 'unknown'), 'observed');
          }
        } catch { /* best-effort */ }
        return next();
      })
    : null;

  const disposeResult = typeof ctx?.on === 'function'
    ? ctx.on('tools/result', async (exec, result) => {
        const sid = exec?.agent?.session?.id;
        if (!sid || result?.isError) return;
        if (['edit', 'write', 'apply_patch'].includes(exec.name)) {
          editsBy.set(sid, (editsBy.get(sid) ?? 0) + 1);
          return;
        }
        if (exec.name === 'read' || isDelegationTool(exec.name)) {
          await recordFact(sid, exec.name, exec.arguments ?? {}, result.value ?? result).catch(() => {});
        }
      })
    : null;

  function toolDefinition() {
    return {
      name: 'efficiency_override',
      description:
        'Justify one blocked redundant action using its checkpoint and existing evidence. ' +
        'The grant is caller/action scoped and single-use; it does not waive safety, review, test, resource or permission gates.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['checkpoint_id', 'reason', 'evidence_ids'],
        properties: {
          checkpoint_id: { type: 'string' },
          reason: { type: 'string', minLength: 10, maxLength: EFF_REASON_MAX },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            maxItems: EFF_IDS_MAX,
            items: { type: 'string' },
          },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      execute: (args, exec) => override(args, exec),
    };
  }

  return {
    noteMessage,
    getObjective,
    recordFact,
    checkpoint,
    override,
    validEvidenceIds,
    factsFor: (sessionId) => [...(factsBy.get(sessionId) ?? [])],
    toolDefinition,
    dispose() {
      objectives.clear();
      factsBy.clear();
      assessments.clear();
      checkpoints.clear();
      editsBy.clear();
      disposeGuard?.();
      disposePreStep?.();
      disposeResult?.();
    },
  };
}
