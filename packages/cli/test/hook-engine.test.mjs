import assert from 'node:assert/strict';
import test from 'node:test';

import { HookEngine } from '@hajicli/core';

test('HookEngine runs handlers in order and stops after an interception', async () => {
  const engine = new HookEngine();
  const calls = [];
  engine.register('PreToolUse', () => { calls.push('first'); });
  engine.register('PreToolUse', async () => {
    calls.push('second');
    return 'blocked';
  });
  engine.register('PreToolUse', () => { calls.push('third'); });

  assert.equal(await engine.trigger('PreToolUse', { toolName: 'write' }), 'blocked');
  assert.deepEqual(calls, ['first', 'second']);
});

test('UserPromptSubmit handlers can update the shared message context', async () => {
  const engine = new HookEngine();
  const context = { messages: [{ role: 'user', content: 'before' }] };
  engine.register('UserPromptSubmit', hookContext => {
    hookContext.messages = [...hookContext.messages, { role: 'system', content: 'after' }];
  });

  assert.equal(await engine.trigger('UserPromptSubmit', context), null);
  assert.deepEqual(context.messages.map(message => message.content), ['before', 'after']);
});
