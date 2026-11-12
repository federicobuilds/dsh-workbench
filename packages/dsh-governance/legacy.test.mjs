import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPresetId, legacyPresetId, isLegacyPresetId, isRoleEvent, legacyEnv, LEGACY_ROLE_EVENT } from './legacy.mjs';

test('legacy identifiers map only the intended prefixes and role events', () => {
  assert.equal(legacyPresetId('dsh-coder'), 'kilo-coder');
  assert.equal(legacyPresetId('standard'), 'standard');
  assert.equal(canonicalPresetId('kilo-coder'), 'dsh-coder');
  assert.equal(canonicalPresetId('standard'), 'standard');
  assert.equal(canonicalPresetId(null), null);
  assert.equal(isLegacyPresetId('kilo-coder'), true);
  assert.equal(isLegacyPresetId('dsh-coder'), false);
  assert.equal(isRoleEvent(LEGACY_ROLE_EVENT), true);
  assert.equal(isRoleEvent('plugin:dsh-governance/role'), true);
  assert.equal(isRoleEvent('plugin:other/role'), false);
});

test('legacy environment lookup gives canonical values precedence including empty values', () => {
  const oldCanonical = process.env.DSH_JUDGE_PYTHON;
  const oldLegacy = process.env.KILO_JUDGE_PYTHON;
  try {
    delete process.env.DSH_JUDGE_PYTHON;
    process.env.KILO_JUDGE_PYTHON = 'legacy';
    assert.equal(legacyEnv('DSH_JUDGE_PYTHON', 'KILO_JUDGE_PYTHON'), 'legacy');
    process.env.DSH_JUDGE_PYTHON = 'canonical';
    assert.equal(legacyEnv('DSH_JUDGE_PYTHON', 'KILO_JUDGE_PYTHON'), 'canonical');
    process.env.DSH_JUDGE_PYTHON = '';
    assert.equal(legacyEnv('DSH_JUDGE_PYTHON', 'KILO_JUDGE_PYTHON'), '');
  } finally {
    if (oldCanonical === undefined) delete process.env.DSH_JUDGE_PYTHON; else process.env.DSH_JUDGE_PYTHON = oldCanonical;
    if (oldLegacy === undefined) delete process.env.KILO_JUDGE_PYTHON; else process.env.KILO_JUDGE_PYTHON = oldLegacy;
  }
});
