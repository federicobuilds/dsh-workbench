import { redactText } from './redaction.mjs';

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
