/** Connect the version-matched Chat editor to installed DSH command APIs. */
export async function commandEdit(ctx, sessionId, role, messageId, targetSeq, text, revision, action, modelSelection) {
  const carried = await ctx.remote.commands.execute(sessionId, '/message-edit ' + JSON.stringify({
    version: 3, role, messageId, targetSeq, text, revision, action,
    ...(modelSelection ? { modelSelection } : {}),
  }), [])
  if (!carried.ok) return carried
  let result
  try {
    if (!carried.value?.result?.text) throw new Error('No editor settlement')
    result = JSON.parse(carried.value.result.text)
  } catch {
    return { ok: false, error: { code: 'gateway/internal', message: 'The editor returned no valid settlement.', details: {} } }
  }
  if (result.ok) {
    return { ok: true, value: action === 'fork'
      ? { kind: 'edited', childSessionId: result.value.childSessionId, seq: result.value.revision }
      : { seq: result.value.revision, childSessionId: result.value.childSessionId } }
  }
  const error = result.error
  return { ok: false, error: {
    code: error.code === 'conflict' ? 'session/edit-conflict'
      : error.code === 'busy' ? 'session/agent-busy'
        : ['invalid', 'invalid-target', 'compacted', 'no-text'].includes(error.code) ? 'session/edit-target-invalid' : 'gateway/internal',
    message: error.message, details: error.details ?? {},
  } }
}
