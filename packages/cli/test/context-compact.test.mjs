import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AGENT_VERIFICATION_CONTEXT_END,
  AGENT_VERIFICATION_CONTEXT_START,
  AUTO_COMPACTION_TRIGGER_RATIO,
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateMessagesTokens,
  getContextCompactionThresholds,
  repairToolCallPairs,
  runCompactionPipeline,
  shouldTriggerAutoCompaction,
  snipCompact,
  validateToolCall
} from '@hajicli/core';
import { getModelContextWindowTokens } from '../dist/context-policy.js';
import { MODEL_CONTEXT_WINDOWS, MODEL_REGISTRY } from '@hajicli/plugins';

const messages = [
  { role: 'system', content: 'system rules' },
  { role: 'user', content: 'first request', snapshotId: 'snapshot-1' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second request', snapshotId: 'snapshot-2' },
  { role: 'assistant', content: 'second answer' },
  { role: 'user', content: 'latest request', snapshotId: 'snapshot-3' }
];

test('message token estimation exposes a named includeSystem option', () => {
  const withoutSystem = estimateMessagesTokens(messages);
  const withSystem = estimateMessagesTokens(messages, { includeSystem: true });

  assert.ok(withSystem > withoutSystem);
  assert.equal(withSystem, estimateMessagesTokens(messages, true));
});

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

test('malformed tool arguments are rejected and removed even when the tool result is paired', () => {
  const truncatedCall = {
    id: 'truncated-write',
    type: 'function',
    function: {
      name: 'write',
      arguments: '{"content":"unfinished document'
    }
  };
  const validation = validateToolCall(truncatedCall);
  assert.equal(validation.valid, false);
  assert.match(validation.error, /JSON/);

  const broken = [
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'writing now', reasoning_content: 'reasoning', tool_calls: [truncatedCall] },
    { role: 'tool', tool_call_id: 'truncated-write', content: '错误: 缺少 path 参数。' },
    { role: 'user', content: 'continue' }
  ];
  const repaired = repairToolCallPairs(broken);

  assert.equal(repaired.some(message => message.role === 'tool'), false);
  assert.equal(repaired.some(message => message.tool_calls?.length), false);
  assert.equal(repaired.find(message => message.content === 'writing now')?.reasoning_content, 'reasoning');
  assert.equal(repaired.at(-1)?.content, 'continue');
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
  const result = await runCompactionPipeline(broken, { maxTokensThreshold: 1_000_000 });
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

test('L4 preserves current and legacy unverified subagent context across repeated compaction', async () => {
  const previousCwd = process.cwd();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-agent-compact-'));
  process.chdir(cwd);
  try {
    const pendingContext = [
      AGENT_VERIFICATION_CONTEXT_START,
      'Agent sub-current：当前结构化待验证结果',
      AGENT_VERIFICATION_CONTEXT_END
    ].join('\n');
    const history = [
      {
        role: 'system',
        content: `system rules\n\n[Compacted Context Summary]\nold summary\n\n${pendingContext}`
      },
      { role: 'user', content: 'first request' },
      {
        role: 'system',
        content: '[系统手动 Agent 结果] sub-legacy completed。该结果尚未验证。'
      },
      { role: 'user', content: 'latest request' }
    ];

    const first = await runCompactionPipeline(history, {
      forceL4: true,
      summaryProvider: async () => 'new summary'
    });
    const second = await runCompactionPipeline(first.messages, {
      forceL4: true,
      summaryProvider: async () => 'newer summary'
    });
    const systemContent = second.messages[0].content;

    assert.match(systemContent, /Agent sub-current/);
    assert.match(systemContent, /sub-legacy completed/);
    assert.equal(systemContent.split(AGENT_VERIFICATION_CONTEXT_START).length - 1, 1);
    assert.equal(systemContent.split(AGENT_VERIFICATION_CONTEXT_END).length - 1, 1);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('inactive local layers are not reported as applied', async () => {
  const result = await runCompactionPipeline(messages, { maxTokensThreshold: 1_000_000 });
  assert.deepEqual(result.layersApplied, []);
  assert.equal(result.summaryMode, 'none');
});

test('automatic pipeline never snips unsummarized history below the token threshold', async () => {
  const history = [{ role: 'system', content: 'rules' }];
  for (let i = 0; i < 60; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `important-message-${i}` });
  }

  const result = await runCompactionPipeline(history, { maxTokensThreshold: 1_000_000 });
  assert.equal(result.summaryMode, 'none');
  assert.equal(result.layersApplied.includes('L2:中间对话裁剪'), false);
  assert.equal(result.messages.some(message => message.content === 'important-message-20'), true);
  assert.equal(result.messages.some(message => /\[已裁切中间/.test(message.content)), false);
});

test('automatic L4 uses the token threshold and reports token usage', async () => {
  const history = [
    { role: 'system', content: '规则' },
    { role: 'user', content: '旧需求'.repeat(1_000) },
    { role: 'assistant', content: '旧结论'.repeat(1_000) },
    { role: 'user', content: '第二个需求' },
    { role: 'assistant', content: '第二个结论' },
    { role: 'user', content: '最新需求' }
  ];
  const result = await runCompactionPipeline(history, {
    maxTokensThreshold: 100,
    summaryProvider: async () => '结构化摘要'
  });

  assert.equal(result.summaryMode, 'model');
  assert.ok(result.originalTokens > 100);
  assert.ok(result.compactedTokens < result.originalTokens);
});

test('automatic compaction policy uses 70/50 percent hysteresis with a 90 percent emergency', () => {
  const thresholds = getContextCompactionThresholds(1_000_000);
  assert.equal(
    DEFAULT_COMPACTION_TOKEN_THRESHOLD,
    Math.round(DEFAULT_CONTEXT_WINDOW_TOKENS * AUTO_COMPACTION_TRIGGER_RATIO)
  );
  assert.deepEqual(thresholds, {
    contextWindowTokens: 1_000_000,
    triggerTokens: 700_000,
    rearmTokens: 500_000,
    emergencyTokens: 900_000
  });
  assert.equal(shouldTriggerAutoCompaction(699_999, thresholds, true), false);
  assert.equal(shouldTriggerAutoCompaction(700_000, thresholds, true), true);
  assert.equal(shouldTriggerAutoCompaction(800_000, thresholds, false), false);
  assert.equal(shouldTriggerAutoCompaction(900_000, thresholds, false), true);
});

test('model context window accepts a validated environment override', () => {
  assert.equal(getModelContextWindowTokens('deepseek-v4-flash', {}), 1_000_000);
  assert.equal(getModelContextWindowTokens('doubao-pro-32k', {}), 32_768);
  assert.equal(getModelContextWindowTokens('unknown-model', {}), 128_000);
  assert.equal(getModelContextWindowTokens('deepseek-v4-flash', {
    HAJI_CONTEXT_WINDOW_TOKENS: '262144.4'
  }), 262_144);
  assert.equal(getModelContextWindowTokens('deepseek-v4-flash', {
    HAJI_CONTEXT_WINDOW_TOKENS: 'invalid'
  }), 1_000_000);
  assert.equal(getModelContextWindowTokens('deepseek-v4-flash', {
    HAJI_CONTEXT_WINDOW_TOKENS: '999'
  }), 1_000_000);
});

test('model context windows come from the shared provider registry', () => {
  assert.equal(MODEL_REGISTRY.length, 5);
  assert.equal(MODEL_CONTEXT_WINDOWS['deepseek-v4-flash'], 1_000_000);
  assert.equal(MODEL_CONTEXT_WINDOWS['doubao-pro-32k'], 32_768);
  assert.equal(getModelContextWindowTokens('glm-5.2', {}), MODEL_CONTEXT_WINDOWS['glm-5.2']);
});
