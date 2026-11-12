export function legacyPresetId(canonicalId) {
  return typeof canonicalId === 'string' && canonicalId.startsWith('dsh-')
    ? `kilo-${canonicalId.slice(4)}`
    : canonicalId
}

export function canonicalPresetId(id) {
  return typeof id === 'string' && id.startsWith('kilo-')
    ? `dsh-${id.slice(5)}`
    : id
}

export function isLegacyPresetId(id) {
  return typeof id === 'string' && id.startsWith('kilo-')
}

export const LEGACY_ROLE_EVENT = 'plugin:kilo-harness/role'
export const LEGACY_ROLE_PROJECTION_KEY = 'kiloActiveRole'

export function isRoleEvent(type) {
  return type === 'plugin:dsh-governance/role' || type === LEGACY_ROLE_EVENT
}

export function legacyEnv(canonicalName, legacyName, env = process.env) {
  return env[canonicalName] ?? env[legacyName]
}
