import assert from 'node:assert/strict';
import test from 'node:test';

import { splitPendingUserTurn } from '../dist/turn-lifecycle.js';

test('automatic compaction excludes the latest pending user turn', () => {
  const messages = [
    { role: 'user', content: 'old prompt' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'pending prompt' }
  ];

  assert.deepEqual(splitPendingUserTurn(messages), {
    history: messages.slice(0, 2),
    pendingTurn: messages.slice(2)
  });
});

test('locally appended tool exchange remains part of the pending turn', () => {
  const messages = [
    { role: 'user', content: 'old prompt' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'pending skill prompt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'load_skill', arguments: '{}' } }] },
    { role: 'tool', content: 'skill output', tool_call_id: 'call-1' }
  ];

  assert.deepEqual(splitPendingUserTurn(messages), {
    history: messages.slice(0, 2),
    pendingTurn: messages.slice(2)
  });
});

test('messages without a user turn remain fully compactable', () => {
  const messages = [{ role: 'system', content: 'system' }];
  assert.deepEqual(splitPendingUserTurn(messages), { history: messages, pendingTurn: [] });
});
