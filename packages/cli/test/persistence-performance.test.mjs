import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionManager, SessionTracker } from '@hajicli/core';

test('session persistence skips duplicate snapshots but saves new messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-session-perf-'));
  try {
    const manager = new SessionManager(dir);
    const messages = [{ role: 'user', content: 'hello' }];
    manager.saveCurrentSession(messages);
    const file = path.join(dir, `session_${manager.getCurrentSession().id}.json`);
    const firstMtime = fs.statSync(file).mtimeMs;

    await new Promise(resolve => setTimeout(resolve, 25));
    manager.saveCurrentSession(messages);
    assert.equal(fs.statSync(file).mtimeMs, firstMtime);

    messages.push({ role: 'assistant', content: 'world' });
    manager.saveCurrentSession(messages);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).messages.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trace writes are serialized and final save contains every queued event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-trace-perf-'));
  try {
    const tracker = new SessionTracker(dir);
    for (let index = 0; index < 20; index += 1) tracker.recordUserInput(`message-${index}`);
    const file = await tracker.save();
    const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(trace.events.length, 20);
    assert.ok(trace.endTime);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
