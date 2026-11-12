import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from './index.mjs';

test('guidance is scoped to sessions with the native computer use tool', () => {
  let section;
  const scope = {};
  let available = false;
  apply({
    systemPrompt: {
      getSectionOrder: () => 20,
      section: value => { section = value; },
    },
    provide() {},
    tools: { guard() {}, get(name, activeScope) {
      assert.equal(name, 'cua');
      assert.equal(activeScope, scope);
      return available;
    } },
  });
  assert.equal(section.order, 21);
  assert.equal(section.text({ scope }), '');
  available = true;
  assert.match(section.text({ scope }), /screenshot/i);
});

test('computer-use policy preserves access for an owner root and denies delegated calls', async () => {
  const { ownerToolRefusal } = await import('./policy.mjs');
  const owner = { session: { header: { origin: 'user' } } };
  const worker = { session: { header: { origin: 'subagent' } } };
  const agents = { roots: () => [owner] };
  assert.equal(ownerToolRefusal({ name: 'cua', agent: owner }, agents), undefined);
  assert.match(ownerToolRefusal({ name: 'cua', agent: worker }, agents), /owner chat/);
  assert.equal(ownerToolRefusal({ name: 'read', agent: worker }, agents), undefined);
});
