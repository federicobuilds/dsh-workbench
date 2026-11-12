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
    tools: { get(name, activeScope) {
      assert.equal(name, 'cua');
      assert.equal(activeScope, scope);
      return available;
    } },
  });
  assert.equal(section.order, 22);
  assert.equal(section.text({ scope }), '');
  available = true;
  assert.match(section.text({ scope }), /screenshot/i);
});
