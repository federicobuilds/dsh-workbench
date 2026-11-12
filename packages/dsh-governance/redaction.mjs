/** Shared secret-shape projection for tool results, stored events and UI Remotes.
 * The seven configured patterns match the original DSH governance. This is not
 * universal secret detection. Always redact BEFORE limiting displayed length. */
const SECRET_SOURCE = [
  'sk-or-v1-[A-Za-z0-9]{20,}',
  'sk-[A-Za-z0-9_-]{32,}',
  'gh[pousr]_[A-Za-z0-9]{30,}',
  'github_pat_[A-Za-z0-9_]{40,}',
  '\\bBSA[A-Za-z0-9_-]{20,}',
  '\\bAKIA[0-9A-Z]{16}\\b',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
];
export function secretPatterns() { return SECRET_SOURCE.map(s => new RegExp(s, 'g')); }
export function redactText(text) {
  if (typeof text !== 'string' || !text.length) return { text, hits: 0 };
  let hits = 0;
  let out = text;
  for (const pattern of secretPatterns()) out = out.replace(pattern, () => (hits++, '[REDACTED]'));
  return { text: out, hits };
}
