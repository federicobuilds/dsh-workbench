const SERVER = /^[a-z][a-z0-9-]{0,80}$/;

/** Validate only the public server-name configuration, never credentials or executable rules. */
export function validateRoutingConfig(config = {}) {
  if (config.historySearchServer != null && !SERVER.test(config.historySearchServer)) throw new Error('historySearchServer must be an MCP server name');
  if (config.mcpServers != null && (!Array.isArray(config.mcpServers) || config.mcpServers.some(name => typeof name !== 'string' || !SERVER.test(name)))) throw new Error('mcpServers must be an array of server names');
  return config;
}

/** Keep recommendations within the current request and configured server names. */
export function constrainRecommendation(result, message, skills, config = {}) {
  if (result?.unavailable) return result;
  const next = { ...result };
  const text = String(message ?? '');
  const named = [];
  for (const match of text.matchAll(/(?:^|\s)@([a-z][a-z0-9-]{0,80})\b/gi)) {
    const before = text.slice(Math.max(0, match.index - 80), match.index);
    if (!/(?:do not|don't|avoid|skip|without)\b[^.!?;\n]*$/i.test(before)) named.push(match[1]);
  }
  const servers = [...new Set(named)];
  const lookup = /\b(?:chat|conversation|history)\b/i.test(text) && /\b(?:search|find|lookup|retrieve|recover|locate)\b/i.test(text);
  const edit = /\b(?:edit|rewrite|modify|delete|remove)\s+(?:(?:the|this|that|my|a|an|saved|previous)\s+)*(?:message|response|chat|conversation)\b/i.test(text);
  if (lookup && !edit) {
    if (typeof next.decision === 'string' && /(?:edit-msg|message-edit)/i.test(next.decision)) next.decision = Object.hasOwn(skills, 'session') ? 'session/recall' : 'none';
    if (!servers.length) {
      if (config.historySearchServer) next.mcp = config.historySearchServer;
      else if (next.mcp === 'chat-search-mcp') next.mcp = null;
    }
  }
  if (servers.length && !servers.includes(next.mcp)) next.mcp = servers.length === 1 ? servers[0] : null;
  if (Array.isArray(config.mcpServers) && next.mcp && !config.mcpServers.includes(next.mcp)) next.mcp = null;
  return next;
}
