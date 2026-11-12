import { createHash } from 'node:crypto';
export function userText(message) { return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'); }
export function routerInput(step) {
  if (step.agent?.session?.header?.origin === 'subagent') return null;
  const message = [...(step.messages ?? [])].reverse().find(m => m.role === 'user' && m.source?.kind === 'user');
  if (!message || !message.id) return null;
  const text = userText(message);
  if (text.split(/\s+/).filter(Boolean).length < 6) return null;
  const first = step.agent.session.deriveMessages?.().find(m => m.role === 'user' && m.source?.kind === 'user');
  return { id: message.id, digest: createHash('sha256').update(text).digest('hex'),
    state: { message: text.slice(0,4000), ...(first && first.id !== message.id ? { task: userText(first).slice(0,600) } : {}) } };
}

/** The judge may pick one pack/reference and one MCP. Notes never execute them
 * or invent a leaf skill; all recommendations remain subordinate to the user. */
export function routerNote(result, catalog) {
  const lines = [];
  const picked = result?.decision;
  if (typeof picked === 'string' && !['none','UNSURE'].includes(picked)) {
    const pack = picked.split('/')[0];
    if (Object.hasOwn(catalog, pack)) {
      lines.push(`Relevant skill: ${pack}. Load it with skill(name="${pack}") before following its instructions.`);
      if (picked.includes('/') && typeof result.path === 'string' && result.path === catalog[pack].path) lines.push('Use the pack router to choose the relevant reference.');
      else if (picked.includes('/')) lines.push('The judge selected a pack reference; after loading the pack, read that reference using its declared resource base.');
    }
  }
  if (typeof result?.mcp === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(result.mcp)) {
    lines.push(`MCP router: ${result.mcp} may fit. Load mcp-router, then separately read mcp2cli @${result.mcp} --list and the chosen tool's --help before invoking. Never replace a user-named server or start unrequested maintenance.`);
  }
  return lines.length ? `Router (judge skill):\n${lines.join('\n')}\nIgnore suggestions that do not fit the actual user request. This note grants no permission.` : null;
}
