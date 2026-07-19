import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repairToolCallPairs, runCompactionPipeline, snipCompact } from '@hajicli/core';

const messages = [
  { role: 'system', content: 'system rules' },
  { role: 'user', content: 'first request', snapshotId: 'snapshot-1' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second request', snapshotId: 'snapshot-2' },
  { role: 'assistant', content: 'second answer' },
  { role: 'user', content: 'latest request', snapshotId: 'snapshot-3' }
];

const toolCall = id => ({
  id,
  type: 'function',
  function: { name: 'read', arguments: '{}' }
});

function assertValidToolPairs(history) {
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role === 'tool') {
      assert.fail(`orphan tool message at ${i}`);
    }
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const expected = new Set(message.tool_calls.map(call => call.id));
    const seen = new Set();
    let cursor = i + 1;
    while (cursor < history.length && history[cursor].role === 'tool') {
      seen.add(history[cursor].tool_call_id);
      cursor += 1;
    }
    assert.deepEqual(seen, expected);
    i = cursor - 1;
  }
}

test('tool-pair repair removes incomplete exchanges and preserves valid ones', () => {
  const valid = [
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: '', tool_calls: [toolCall('call-a'), toolCall('call-b')] },
    { role: 'tool', tool_call_id: 'call-a', content: 'a' },
    { role: 'tool', tool_call_id: 'call-b', content: 'b' },
    { role: 'user', content: 'continue' }
  ];
  assert.equal(repairToolCallPairs(valid), valid);

  const invalid = [
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'visible preface', tool_calls: [toolCall('call-a'), toolCall('call-b')] },
    { role: 'tool', tool_call_id: 'call-a', content: 'only one result' },
    { role: 'tool', tool_call_id: 'orphan', content: 'orphan result' },
    { role: 'user', content: 'continue' }
  ];
  const repaired = repairToolCallPairs(invalid);
  assert.equal(repaired.some(message => message.role === 'tool'), false);
  assert.equal(repaired.find(message => message.content === 'visible preface')?.tool_calls, undefined);
  assertValidToolPairs(repaired);
});

test('L2 never keeps a head tool call after cutting away its result', () => {
  const history = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: '', tool_calls: [toolCall('cut-at-head')] },
    { role: 'tool', tool_call_id: 'cut-at-head', content: 'old result' }
  ];
  for (let i = 0; i < 42; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message-${i}` });
  }

  const compacted = snipCompact(history, 40);
  assert.equal(compacted.some(message => message.tool_calls?.some(call => call.id === 'cut-at-head')), false);
  assertValidToolPairs(compacted);
});

test('pipeline repairs an already-broken resumed history before the next provider call', async () => {
  const broken = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: '', tool_calls: [toolCall('missing-result')] },
    { role: 'user', content: 'continue after resume' }
  ];
  const result = await runCompactionPipeline(broken, { maxCharsThreshold: 1_000_000 });
  assert.ok(result.layersApplied.includes('协议:工具调用配对修复'));
  assertValidToolPairs(result.messages);
  assert.equal(result.messages.some(message => message.tool_calls?.length), false);
});

test('L4 sends the full history to the model and preserves the latest two user turns', async () => {
  const previousCwd = process.cwd();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-compact-'));
  process.chdir(cwd);
  try {
    let summarizedMessages;
    const result = await runCompactionPipeline(messages, {
      forceL4: true,
      summaryProvider: async sourceMessages => {
        summarizedMessages = sourceMessages;
        return 'model generated task summary';
      }
    });

    assert.deepEqual(summarizedMessages, messages);
    assert.equal(result.summaryMode, 'model');
    assert.ok(result.layersApplied.includes('L4:模型结构化摘要'));
    assert.match(result.messages[0].content, /model generated task summary/);
    assert.equal(result.messages.some(message => message.content === 'first request'), false);
    assert.equal(result.messages.some(message => message.content === 'second request'), true);
    assert.equal(result.messages.some(message => message.content === 'latest request'), true);
    assert.equal(result.messages.find(message => message.content === 'latest request')?.snapshotId, 'snapshot-3');

    const transcriptDir = path.join(cwd, '.haji', 'transcripts');
    const transcriptFiles = fs.readdirSync(transcriptDir);
    assert.equal(transcriptFiles.length, 1);
    const transcript = fs.readFileSync(path.join(transcriptDir, transcriptFiles[0]), 'utf8');
    assert.equal(transcript.split('\n').length, messages.length);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('L4 reports fallback mode when the model summary fails', async () => {
  const previousCwd = process.cwd();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-compact-'));
  process.chdir(cwd);
  try {
    const result = await runCompactionPipeline(messages, {
      forceL4: true,
      summaryProvider: async () => {
        throw new Error('provider unavailable');
      }
    });

    assert.equal(result.summaryMode, 'fallback');
    assert.ok(result.layersApplied.includes('L4:本地降级摘要'));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('inactive local layers are not reported as applied', async () => {
  const result = await runCompactionPipeline(messages, { maxCharsThreshold: 1_000_000 });
  assert.deepEqual(result.layersApplied, []);
  assert.equal(result.summaryMode, 'none');
});
