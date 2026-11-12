import { MCP_SKILL, mcpCalls, mcpGateDecision, redactText } from './gates.mjs';

/** Recognize a successful native skill load or direct entrypoint read. */
export function loadedMcpRouter(exec, result) {
  if (result?.isError !== false) return false;
  if (exec.name === 'skill') return exec.arguments?.name === 'mcp-router';
  if (exec.name !== 'read') return false;
  const path = exec.arguments?.file_path ?? exec.arguments?.path;
  return typeof path === 'string' && MCP_SKILL.test(path);
}

export function classifyMcpResult(result) {
  const text = [result?.value?.stdout?.text, result?.value?.stderr?.text,
    ...(Array.isArray(result?.content) ? result.content.filter(block => block?.type === 'text').map(block => block.text) : [])];
  return text.some(value => typeof value === 'string' && /^Error executing tool [A-Za-z0-9_.-]+: \S/.test(value)) ? 'BACKEND' : null;
}

/** Native Bash reports command failures as successful TOOL calls. Only its
 * canonical settled foreground result can establish a discovery receipt. */
export function completedDiscovery(exec, result, seen) {
  if (result?.isError !== false || classifyMcpResult(result) === 'BACKEND') return [];
  const value = result.value;
  if (value?.kind !== 'foreground' || value.exitCode !== 0 || value.signal !== null
      || value.timedOut !== false || value.aborted !== false
      || value.stdout?.truncated !== false || value.stderr?.truncated !== false
      || typeof value.stdout?.text !== 'string' || !value.stdout.text.trim()) return [];
  const calls = mcpCalls(exec.arguments?.command);
  const plain = exec.arguments.command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q').replace(/\b2>&1(?=\s|$|[;|])/g, '');
  if (calls.length !== 1 || /[#;|\n<>&]/.test(plain) || !mcpGateDecision(exec.arguments.command, seen).ok || /(?:^|\s)--(?:head|jq|limit)(?:\s|=|$)/.test(plain)) return [];
  const out = [];
  for (const call of calls) {
    if (call.discovery) out.push({ kind: 'server', server: call.server });
    else if (call.toolHelp && seen?.servers.has(call.server)) out.push({ kind: 'tool', server: call.server, tool: call.tool });
    else return [];
  }
  return out;
}

/** Copy a JSON result, replacing detected secret shapes in string VALUES. Keys
 * and primitive types stay unchanged. Native tool values must already be JSON. */
export function redactJsonValue(value, depth = 0) {
  if (depth > 128) throw new Error('Tool value exceeds redaction depth');
  if (typeof value === 'string') {
    const redacted = redactText(value);
    return { value: redacted.text, hits: redacted.hits };
  }
  if (value === null || typeof value !== 'object') return { value, hits: 0 };
  const output = Array.isArray(value) ? [] : {};
  let hits = 0;
  for (const [key, item] of Object.entries(value)) {
    const redacted = redactJsonValue(item, depth + 1);
    Object.defineProperty(output, key, { value: redacted.value, enumerable: true, writable: true, configurable: true });
    hits += redacted.hits;
  }
  return { value: output, hits };
}

/** DSH permits replacing content OR value, not both. Replacing a canonical
 * value re-renders its content using the declared renderer. When canonical
 * value is clean, a content-only replacement leaves no hidden secret value. */
export function redactToolResult(result) {
  const canonical = redactJsonValue(result?.value);
  const rendered = redactJsonValue(result?.content);
  const other = redactJsonValue({ error: result?.error, meta: result?.meta, additionalContexts: result?.additionalContexts });
  if (other.hits) return { hits: canonical.hits + rendered.hits + other.hits,
    decision: { kind: 'block', feedback: [{ type: 'text', text: 'Tool result blocked: sensitive data in structured metadata or context. Do not retry the same tool arguments; use a narrower, non-secret source or ask the user to handle the protected file.' }] } };
  if (canonical.hits) return { hits: canonical.hits + rendered.hits,
    decision: { kind: 'accept', value: canonical.value } };
  if (rendered.hits) return { hits: rendered.hits,
    decision: { kind: 'accept', content: rendered.value } };
  return { hits: 0, decision: null };
}
