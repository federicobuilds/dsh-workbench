/** Discovery state is supplied by the session; values and commands are not logged. */

export const MCP_SKILL = /(?:^|\/)skills\/mcp-router\/SKILL\.md$/;
export const MAINTENANCE = /(rebuild|re-?index|update-index|update-embeddings|embed|migrat|backfill|bulk|batch|import|purge|wipe|reset|drop|delete|forget|memory-(add|update))/i;
export const VALUE_FLAGS = new Set(["--head", "--jq", "--limit", "--timeout", "--env", "--cache-key", "--cache-ttl", "--transport", "--base-url", "--auth-header", "--oauth-client-id", "--oauth-client-secret", "--oauth-scope"]);
export const SHELL_TOOLS = new Set(["bash", "background_process"]);

// Compatibility export; the authoritative implementation is the public leaf.
export { secretPatterns, redactText } from './redaction.mjs';

/** Parse the mcp2cli calls in a shell command. Quoted strings are blanked first so a
 * --jq expression or argument value is never mistaken for a tool name. (mirrors mcpCalls) */
export function mcpCalls(command) {
  if (typeof command !== 'string') return [];
  const plain = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q').replace(/\b2>&1(?=\s|$|[;|])/g, '');
  const calls = [];
  for (const seg of plain.split(/&&|\|\||;|\||\n/)) {
    const tokens = seg.trim().split(/\s+/);
    const token = tokens[0];
    if (!(token === 'mcp2cli' || ((token.startsWith('/') || token.startsWith('~/') || /^[\w./-]+\//.test(token)) && token.endsWith('/mcp2cli')))) continue;
    const at = tokens.findIndex((x) => x.startsWith('@'));
    if (at < 0) continue;
    const rest = tokens.slice(at + 1);
    let tool = null;
    for (let i = 0; i < rest.length; i++) {
      if (VALUE_FLAGS.has(rest[i])) i++;
      else if (!rest[i].startsWith('-')) { tool = rest[i]; break; }
    }
    calls.push({ server: tokens[at].slice(1), tool, discovery: !tool && (rest.includes('--list') || rest.includes('--help')), toolHelp: !!tool && rest.includes('--help') });
  }
  return calls;
}

/** Per-session discovery state shape. */
export function emptySeen() { return { skill: false, servers: new Set(), tools: new Set() }; }

/** Recognize only non-executing file/command inspection, without shell expansion or redirects. */
export function passiveInspection(command) {
  if (typeof command === 'string') command = command.replace(/\b2>&1(?=\s|$|[;|])/g, '');
  if (typeof command !== 'string' || /[$`\\<>#()\r\n]/.test(command) || /(?:^|[^&])&(?:[^&]|$)/.test(command)) return false;
  const readers = new Set(['ls', 'grep', 'file', 'head', 'tail', 'stat', 'readlink', 'realpath', 'which', 'pwd']);
  const segments = command.split(/&&|\|\||[;|]/).map(segment => segment.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(segment => {
    const words = segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    const executable = words[0]?.split('/').at(-1);
    return readers.has(executable) || (executable === 'command' && words[1] === '-v');
  });
}

export function hasObfuscatedMcpExecutable(command) {
  if (typeof command !== 'string') return false;
  const words = command.match(/(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\[\s\S]|[^\s;&|()'"\\])+|[;&|()\n]|[ \t\r]+/g) ?? [];
  let commandStart = true, wrapper = false;
  for (const word of words) {
    if (/^[;&|()\n]$/.test(word)) { commandStart = true; wrapper = false; continue; }
    if (/^[ \t\r]+$/.test(word) || !commandStart) continue;
    const literal = word.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\([\s\S])/g, (_, single, double, escaped) => {
      if (single !== undefined) return single;
      if (double !== undefined) return double.replace(/\\([\\"$`])/g, '$1').replace(/\\\n/g, '');
      return escaped === '\n' ? '' : escaped;
    });
    const name = literal.split('/').at(-1);
    if (name === 'mcp2cli' && !/^(?:~\/(?:[\w./-]+\/)?|[\w./-]*\/)?mcp2cli$/.test(word)) return true;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(literal)) continue;
    if (wrapper && literal.startsWith('-')) continue;
    if (['env', 'command', 'exec'].includes(name)) { wrapper = true; continue; }
    commandStart = false;
  }
  return false;
}

/** Decide whether a shell command passes the MCP discipline gate.
 * Returns { ok:true } or { ok:false, problems:[...], discovery:[...] } where discovery
 * lists server/tool pairs the command itself establishes (for the caller to record).
 * `seen` is prior discovery state; `grants` contains exact authorized server/tool pairs.
 * (mirrors mcpGate; read-only on `seen` — caller records discovery after the fact.) */
export function mcpGateDecision(command, seen, grants = new Set()) {
  if (passiveInspection(command)) return { ok: true, discovery: [] };
  if (hasObfuscatedMcpExecutable(command)) return { ok: false, category: 'SYNTAX', problems: ['ambiguous mcp2cli invocation; use a direct structured command'], discovery: [] };
  if (typeof command === 'string' && command.includes('mcp2cli')) {
    const plain = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q').replace(/\b2>&1(?=\s|$|[;|])/g, '');
    const mentions = text => (text.match(/mcp2cli/g) ?? []).length;
    const segments = plain.split(/&&|\|\||;|\||\n/).filter(segment => segment.includes('mcp2cli'));
    const activeDoubleQuote = (command.match(/'[^']*'|"(?:[^"\\]|\\.)*"/g) ?? [])
      .some(quoted => quoted.startsWith('"') && /\$(?=[A-Za-z0-9_([{?@*#$!-])/.test(quoted));
    const ambiguous = mentions(command) !== mentions(plain) || /[$`\\]/.test(plain) || /[`\\]/.test(command) || activeDoubleQuote
      || segments.some(segment => {
        if (!/^\s*(?:[\w./~-]*\/)?mcp2cli(?:\s|$)/.test(segment) || /[<>(){}]/.test(segment)) return true;
        const calls = mcpCalls(segment);
        if (!calls.length) return !/^\s*(?:[\w./~-]*\/)?mcp2cli\s+(?:--help|--list\s+--help|bake\s+list)\s*$/.test(segment);
        return calls.length !== 1 || !/^[A-Za-z0-9][\w.-]*$/.test(calls[0].server)
          || (calls[0].tool !== null && (calls[0].tool === 'Q' || !/^[A-Za-z0-9][\w.-]*$/.test(calls[0].tool)));
      });
    if (ambiguous) return { ok: false, category: 'SYNTAX', problems: ['ambiguous mcp2cli invocation; use a direct structured command'], discovery: [] };
  }
  const calls = mcpCalls(command);
  if (!calls.length) return { ok: true, discovery: [] };
  const problems = [];
  const discovery = [];
  let maintenanceDenied = false;
  for (const c of calls) {
    if (c.discovery) { discovery.push({ kind: 'server', server: c.server }); continue; }
    if (c.toolHelp) { if (!seen.servers.has(c.server)) problems.push(`run \`mcp2cli @${c.server} --list\` and read it first (rule 4)`); else discovery.push({ kind: 'tool', server: c.server, tool: c.tool }); continue; }
    if (!c.tool) continue;
    const key = `${c.server}/${c.tool}`;
    if (!seen.skill) problems.push('read the mcp-router skill before the first MCP call (MCP Discipline rule 1)');
    else if (!seen.servers.has(c.server)) problems.push(`run \`mcp2cli @${c.server} --list\` and read it first (rule 4)`);
    else if (!seen.tools.has(key)) problems.push(`run \`mcp2cli @${c.server} ${c.tool} --help\` and read it first (rule 4)`);
    const exactRefresh = (c.server === 'chat-search-mcp' || c.server === 'dsh-chat-search-mcp') && c.tool === 'update-index';
    if (MAINTENANCE.test(c.tool) && !grants.has(key) && !exactRefresh) {
      maintenanceDenied = true;
      problems.push(`\`${c.tool}\` looks like a maintenance, batch, or write tool, and the user did not request that exact operation in this session (rule 3); these are external-terminal jobs`);
    }
  }
  if (problems.length) return { ok: false, category: maintenanceDenied ? 'MAINTENANCE_DENIED' : 'DISCOVERY', problems: [...new Set(problems)], discovery };
  return { ok: true, discovery };
}
