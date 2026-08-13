import assert from 'node:assert/strict';
import test from 'node:test';

import { performanceMonitor } from '@hajicli/core';
import {
  createToolCallBatches,
  MAX_PARALLEL_READ_ONLY_TOOLS,
  runToolCallBatch
} from '../dist/tool-batch.js';

const call = (id, name) => ({ id, function: { name } });

test('tool batching parallelizes only contiguous allowlisted read-only calls', () => {
  const batches = createToolCallBatches([
    call('1', 'read'),
    call('2', 'grep'),
    call('3', 'global'),
    call('4', 'projectinfo'),
    call('5', 'edit'),
    call('6', 'read'),
    call('7', 'tasklist'),
    call('8', 'webfetch')
  ]);

  assert.equal(MAX_PARALLEL_READ_ONLY_TOOLS, 3);
  assert.deepEqual(batches.map(batch => ({
    ids: batch.calls.map(item => item.id),
    parallel: batch.parallel
  })), [
    { ids: ['1', '2', '3'], parallel: true },
    { ids: ['4'], parallel: false },
    { ids: ['5'], parallel: false },
    { ids: ['6'], parallel: false },
    { ids: ['7'], parallel: false },
    { ids: ['8'], parallel: false }
  ]);
});

test('tool batching caps concurrency at three and treats bash, Skill and task calls as barriers', () => {
  const batches = createToolCallBatches([
    call('1', 'read'),
    call('2', 'grep'),
    call('3', 'global'),
    call('4', 'read'),
    call('5', 'bash'),
    call('6', 'loadskill'),
    call('7', 'taskcreate'),
    call('8', 'listskillresources'),
    call('9', 'readskillresource')
  ]);

  assert.deepEqual(batches.map(batch => batch.calls.map(item => item.id)), [
    ['1', '2', '3'],
    ['4'],
    ['5'],
    ['6'],
    ['7'],
    ['8', '9']
  ]);
  assert.deepEqual(batches.map(batch => batch.parallel), [true, false, false, false, false, true]);
});

test('parallel batch preserves result order, bounds active work and records savings metrics', async () => {
  performanceMonitor.snapshot(true);
  let active = 0;
  let maxActive = 0;
  const batch = createToolCallBatches([
    call('slow', 'read'),
    call('fast', 'grep'),
    call('middle', 'global')
  ])[0];
  const delays = new Map([['slow', 90], ['fast', 20], ['middle', 55]]);

  const result = await runToolCallBatch(batch, async item => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const duration = delays.get(item.id);
    await new Promise(resolve => setTimeout(resolve, duration));
    active -= 1;
    return { id: item.id, duration };
  });

  assert.equal(maxActive, 3);
  assert.deepEqual(result.results.map(item => item.id), ['slow', 'fast', 'middle']);
  assert.equal(result.serialEstimateMs, 165);
  assert.ok(result.wallTimeMs < 150, `并发墙钟时间应小于串行估算，实际 ${result.wallTimeMs}`);
  assert.ok(result.savedTimeMs > 15);

  const metrics = performanceMonitor.snapshot(true).metrics;
  assert.equal(metrics['tool.batch.wall_time'].count, 1);
  assert.equal(metrics['tool.batch.serial_estimate'].count, 1);
  assert.equal(metrics['tool.batch.saved_time'].count, 1);
});

test('parallel batch lets one normal failed result coexist with successful siblings', async () => {
  performanceMonitor.snapshot(true);
  const batch = createToolCallBatches([
    call('ok-1', 'read'),
    call('failed', 'grep'),
    call('ok-2', 'global')
  ])[0];
  const result = await runToolCallBatch(batch, async item => ({
    id: item.id,
    duration: 1,
    blocked: item.id === 'failed'
  }));
  assert.deepEqual(result.results.map(item => [item.id, item.blocked]), [
    ['ok-1', false],
    ['failed', true],
    ['ok-2', false]
  ]);
  performanceMonitor.snapshot(true);
});
