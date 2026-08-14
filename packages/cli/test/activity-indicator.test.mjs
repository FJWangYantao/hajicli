import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActivityIndicator,
  buildActivityFrame,
  formatActivityDuration
} from '../dist/activity-indicator.js';

test('formats activity duration without noisy sub-second precision', () => {
  assert.equal(formatActivityDuration(-1), '0s');
  assert.equal(formatActivityDuration(9_999), '9s');
  assert.equal(formatActivityDuration(65_000), '1m05s');
});

test('activity frames expose active, waiting and stalled states', () => {
  const state = {
    phase: 'thinking',
    label: '思考中',
    detail: '等待模型事件',
    startedAt: 1_000,
    lastProgressAt: 2_000
  };

  const active = buildActivityFrame(state, 0, 5_000, 12_000, 30_000);
  const waiting = buildActivityFrame(state, 1, 15_000, 12_000, 30_000);
  const stalled = buildActivityFrame(state, 2, 33_000, 12_000, 30_000);

  assert.equal(active.tone, 'active');
  assert.equal(waiting.tone, 'waiting');
  assert.match(waiting.idleText, /13s 无新事件/);
  assert.equal(stalled.tone, 'stalled');
  assert.match(stalled.idleText, /31s 无新事件/);
  assert.notEqual(active.icon, waiting.icon);
  assert.notEqual(active.meter, waiting.meter);
});

test('permission is an explicit waiting phase instead of a false stall', () => {
  const frame = buildActivityFrame({
    phase: 'permission',
    label: '等待授权',
    startedAt: 0,
    lastProgressAt: 0
  }, 0, 90_000, 12_000, 30_000);

  assert.equal(frame.tone, 'waiting');
  assert.equal(frame.idleText, undefined);
  assert.equal(frame.elapsed, '1m30s');
});

test('indicator owns one timer and progress resets idle detection', () => {
  let now = 1_000;
  let scheduled;
  let cancelled = 0;
  const frames = [];
  const indicator = new ActivityIndicator({
    render: frame => frames.push(frame),
    now: () => now,
    intervalMs: 100,
    waitingAfterMs: 1_000,
    stalledAfterMs: 2_000,
    schedule: callback => {
      scheduled = callback;
      return { unref() {} };
    },
    cancel: () => { cancelled += 1; }
  });

  indicator.start('tool', '执行工具', 'read');
  assert.equal(frames.at(-1).tone, 'active');

  now = 2_500;
  scheduled();
  assert.equal(frames.at(-1).tone, 'waiting');

  indicator.progress('read: 50%');
  now = 2_600;
  scheduled();
  assert.equal(frames.at(-1).tone, 'active');
  assert.equal(frames.at(-1).detail, 'read: 50%');

  indicator.transition('responding', '生成回复');
  assert.equal(cancelled, 1);
  assert.equal(frames.at(-1).phase, 'responding');

  indicator.stop();
  assert.equal(cancelled, 2);
  assert.equal(frames.at(-1), undefined);
});
