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
    await manager.flush();
    const file = path.join(dir, `session_${manager.getCurrentSession().id}.json`);
    const firstMtime = fs.statSync(file).mtimeMs;

    await new Promise(resolve => setTimeout(resolve, 25));
    manager.saveCurrentSession(messages);
    assert.equal(fs.statSync(file).mtimeMs, firstMtime);

    messages.push({ role: 'assistant', content: 'world' });
    manager.saveCurrentSession(messages);
    await manager.flush();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).messages.length, 2);

    messages[1].content = 'stream finished';
    manager.saveCurrentSession(messages);
    await manager.flush();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).messages[1].content, 'stream finished');
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
    assert.match(file, /\.meta\.json$/);
    const trace = await SessionTracker.readSession(tracker.getSessionId(), dir);
    assert.ok(trace);
    assert.equal(trace.events.length, 20);
    assert.ok(trace.endTime);
    const eventsFile = path.join(dir, `session_${tracker.getSessionId()}.events.jsonl`);
    assert.equal(fs.readFileSync(eventsFile, 'utf8').trim().split('\n').length, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trace bounds large LLM payloads while preserving call metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-trace-bounded-'));
  try {
    const tracker = new SessionTracker(dir);
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index === 0 ? 'system' : 'user',
      content: `${index}:` + 'x'.repeat(20_000)
    }));
    tracker.recordLlmCall({
      id: 'call-large',
      timestamp: new Date().toISOString(),
      model: 'test-model',
      messages,
      ttft: 10,
      duration: 20,
      speed: 30,
      content: 'done'
    });
    await tracker.save();

    const trace = await SessionTracker.readSession(tracker.getSessionId(), dir);
    const call = trace.events[0].data;
    assert.equal(call.messageCount, 100);
    assert.equal(call.messages.length, 12);
    assert.equal(call.omittedMessageCount, 88);
    const eventsFile = path.join(dir, `session_${tracker.getSessionId()}.events.jsonl`);
    assert.ok(fs.statSync(eventsFile).size < 200_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
