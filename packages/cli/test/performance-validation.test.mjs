import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PerformanceMonitor,
  findInvalidToolCall,
  validateToolCall
} from '@hajicli/core';

function toolCall(overrides = {}) {
  return {
    id: 'call-1',
    type: 'function',
    function: {
      name: 'read',
      arguments: '{"path":"a.ts"}'
    },
    ...overrides
  };
}

test('PerformanceMonitor bounds samples and calculates stable aggregates', () => {
  const monitor = new PerformanceMonitor();
  monitor.record('render', Number.NaN);
  monitor.record('render', -1);
  for (let value = 1; value <= 300; value += 1) monitor.record('render', value);

  const metric = monitor.snapshot().metrics.render;
  assert.deepEqual(metric, {
    count: 256,
    averageMs: 172.5,
    p95Ms: 288,
    maxMs: 300
  });
});

test('PerformanceMonitor reset and measurement wrappers preserve operation behavior', async () => {
  const monitor = new PerformanceMonitor();
  assert.equal(monitor.measureSync('sync', () => 42), 42);
  assert.throws(() => monitor.measureSync('sync-error', () => {
    throw new Error('sync failed');
  }), /sync failed/);
  await assert.rejects(
    monitor.measure('async-error', async () => {
      throw new Error('async failed');
    }),
    /async failed/
  );

  const beforeReset = monitor.snapshot(true);
  assert.equal(beforeReset.metrics.sync.count, 1);
  assert.equal(beforeReset.metrics['sync-error'].count, 1);
  assert.equal(beforeReset.metrics['async-error'].count, 1);
  assert.deepEqual(monitor.snapshot().metrics, {});

  monitor.start();
  monitor.start();
  monitor.stop();
  monitor.stop();
});

test('validateToolCall accepts only complete function calls with object arguments', () => {
  assert.deepEqual(validateToolCall(toolCall()), {
    valid: true,
    arguments: { path: 'a.ts' }
  });
  assert.match(validateToolCall(null).error, /不是对象/);
  assert.match(validateToolCall(toolCall({ id: '' })).error, /缺少 id/);
  assert.match(validateToolCall(toolCall({ type: 'custom' })).error, /类型无效/);
  assert.match(validateToolCall(toolCall({ function: { name: '', arguments: '{}' } })).error, /缺少函数名/);
  assert.match(validateToolCall(toolCall({ function: { name: 'read', arguments: null } })).error, /不是 JSON 字符串/);
  assert.match(validateToolCall(toolCall({ function: { name: 'read', arguments: '[]' } })).error, /必须是 JSON 对象/);
  assert.match(validateToolCall(toolCall({ function: { name: 'read', arguments: '{"path":' } })).error, /JSON 不完整或无效/);
});

test('findInvalidToolCall returns the first invalid call with exact indices', () => {
  const invalid = toolCall({
    id: 'broken',
    function: { name: 'write', arguments: '{"content":' }
  });
  const messages = [
    { role: 'system', content: 'rules' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall(), invalid]
    }
  ];

  const result = findInvalidToolCall(messages);
  assert.equal(result.messageIndex, 1);
  assert.equal(result.toolCallIndex, 1);
  assert.equal(result.toolCall, invalid);
  assert.match(result.error, /JSON 不完整或无效/);
  assert.equal(findInvalidToolCall([{ role: 'assistant', content: '', tool_calls: [toolCall()] }]), null);
});
