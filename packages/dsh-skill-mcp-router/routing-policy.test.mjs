import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constrainRecommendation, validateRoutingConfig } from './routing-policy.mjs';

test('history lookup is not message editing and uses the configured DSH history server', () => {
  const result = constrainRecommendation({ decision: 'kilo-edit-msg', mcp: 'chat-search-mcp' }, 'Use chat search to find the chat containing the project table.', { session: {} }, { historySearchServer: 'dsh-chat-search-mcp' });
  assert.equal(result.decision, 'session/recall');
  assert.equal(result.mcp, 'dsh-chat-search-mcp');
});

test('an explicitly named server is never silently substituted', () => {
  const result = constrainRecommendation({ decision: 'session', mcp: 'dsh-chat-search-mcp' }, 'Use @chat-search-mcp to find that old chat.', {}, { historySearchServer: 'dsh-chat-search-mcp' });
  assert.equal(result.mcp, 'chat-search-mcp');
  const absent = constrainRecommendation(result, 'Use @chat-search-mcp to find that old chat.', {}, { mcpServers: ['dsh-chat-search-mcp'] });
  assert.equal(absent.mcp, null);
});

test('an actual message-edit request is not reclassified as history lookup', () => {
  const result = constrainRecommendation({ decision: 'kilo-edit-msg' }, 'Find this chat and edit the message.', { session: {} });
  assert.equal(result.decision, 'kilo-edit-msg');
});

test('unconfigured legacy history recommendations are omitted rather than advertised as active', () => {
  const result = constrainRecommendation({ decision: 'session', mcp: 'chat-search-mcp' }, 'Find the chat about the old table.', {}, {});
  assert.equal(result.mcp, null);
});

test('routing config only accepts server names and unavailable results stay unavailable', () => {
  assert.throws(() => validateRoutingConfig({ historySearchServer: 'server; command' }), /server name/);
  const result = { unavailable: true };
  assert.equal(constrainRecommendation(result, 'Find that chat.', {}), result);
});
