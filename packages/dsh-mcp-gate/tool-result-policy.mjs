import { MCP_SKILL, mcpCalls, mcpGateDecision } from './gates.mjs';

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
