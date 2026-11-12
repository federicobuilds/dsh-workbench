import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from './redaction.mjs';

const canaries = ['sk-or-v1-' + 'X'.repeat(25), 'sk-' + 'Y'.repeat(36), 'ghp_' + 'Z'.repeat(32), 'github_pat_' + 'Q'.repeat(44), 'BSA' + 'A'.repeat(25), 'AKIA' + 'A'.repeat(16)];

test('configured secret shapes are redacted consistently', () => {
  for (const canary of canaries) {
    const result = redactText('before ' + canary + ' after');
    assert.equal(result.hits, 1);
    assert.equal(result.text, 'before [REDACTED] after');
  }
});
