const ownerTools = new Set(['cua', 'plugin_manager', 'plugin_market', 'cordis_inspect_list', 'cordis_inspect_query'])

export function ownerToolRefusal(exec, agents) {
  if (!ownerTools.has(exec.name)) return undefined
  const agent = exec.agent
  if (agent && agent.session?.header?.origin !== 'subagent' && agents.roots().includes(agent)) return undefined
  return 'This action requires the owner chat. Return the requested action and verification target to the owner.'
}
