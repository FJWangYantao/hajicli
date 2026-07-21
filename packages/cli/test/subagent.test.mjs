import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HookEngine,
  isAbortError,
  normalizeAbortError,
  PermissionEngine,
  SnapshotEngine,
  SubagentRunner,
  TaskStore
} from '@hajicli/core';
import { BashTool, SubagentTool } from '@hajicli/plugins';
import { SharedToolExecutor } from '../dist/tool-executor.js';

const definition = name => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } }
});

test('subagent uses fresh context, filters recursive/task tools and returns only final result', async () => {
  const calls = [];
  const provider = {
    async *completeStream(messages, options) {
      calls.push({ messages: structuredClone(messages), tools: options.tools.map(tool => tool.function.name) });
      if (calls.length === 1) options.onReasoning?.('正在检查');
      options.onUsage?.({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      if (calls.length === 1) {
        options.onToolCall([{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }]);
        return;
      }
      const result = JSON.stringify({
        summary: '已完成隔离调研',
        filesChanged: [],
        verification: ['read a.ts'],
        unresolved: []
      });
      yield result.slice(0, 12);
      yield result.slice(12);
    }
  };
  const tools = ['read', 'write', 'taskfinish', 'subagent'].map(name => ({
    name,
    definition: definition(name),
    async execute() { return name; }
  }));
  const executed = [];
  const events = [];
  const runner = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => provider,
    getModel: () => 'test-model',
    getReasoningEffort: () => 'low',
    getTools: () => tools,
    executeTool: async (toolCall, args, context) => {
      executed.push({ toolCall, args, context });
      return 'file contents';
    },
    onEvent: event => events.push(event)
  });

  const output = await runner.run(
    { description: '只检查 a.ts', taskId: 'inspect', role: 'research' },
    { depth: 0, permissionMode: 'plan', anchorSnapshotId: 'anchor-1' }
  );

  assert.equal(calls[0].messages.length, 2);
  assert.equal(calls[0].messages[1].content, '任务 inspect：只检查 a.ts');
  assert.deepEqual(calls[0].tools, ['read', 'write']);
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.equal(executed[0].context.depth, 1);
  assert.equal(executed[0].context.anchorSnapshotId, 'anchor-1');
  assert.match(output, /^\[SUBAGENT_RESULT - UNVERIFIED\]/);
  assert.match(output, /已完成隔离调研/);
  assert.deepEqual(events.map(event => event.type), [
    'start', 'reasoning_delta', 'usage', 'tool', 'tool_done', 'text_delta', 'text_delta', 'usage', 'done'
  ]);
});

test('subagent forwards per-agent model, provider, effort and protected instructions', async () => {
  let providerRequest;
  let requestedModel;
  let requestedEffort;
  let systemPrompt;
  const provider = {
    async *completeStream(messages, options) {
      providerRequest = options;
      systemPrompt = messages[0].content;
      yield JSON.stringify({ summary: 'configured', filesChanged: [], verification: [], unresolved: [] });
    }
  };
  const runner = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: request => { requestedModel = request.model; return provider; },
    getModel: request => { requestedModel = request.model; return request.model || 'fallback'; },
    getReasoningEffort: request => { requestedEffort = request.reasoningEffort; return request.reasoningEffort || 'low'; },
    getTools: () => [],
    executeTool: async () => ''
  });

  const result = await runner.runResult({
    description: '按指定配置审查',
    model: 'glm-5.2',
    provider: 'volcengine',
    reasoningEffort: 'high',
    instructions: '只关注竞态条件'
  });

  assert.equal(result.status, 'completed');
  assert.equal(requestedModel, 'glm-5.2');
  assert.equal(requestedEffort, 'high');
  assert.equal(providerRequest.model, 'glm-5.2');
  assert.equal(providerRequest.reasoningEffort, 'high');
  assert.match(systemPrompt, /只关注竞态条件/);
  assert.match(systemPrompt, /不得覆盖以上安全约束/);
});

test('subagent stops after exceeding its cumulative token budget', async () => {
  let requestedMaxTokens;
  const events = [];
  const runner = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => ({
      async *completeStream(_messages, options) {
        requestedMaxTokens = options.maxTokens;
        options.onUsage?.({ prompt_tokens: 900, completion_tokens: 101, total_tokens: 1001 });
        yield '{"summary":"should not be accepted"}';
      }
    }),
    getModel: () => 'test-model',
    getReasoningEffort: () => 'low',
    getTools: () => [],
    executeTool: async () => '',
    onEvent: event => events.push(event)
  });

  const result = await runner.runResult({ description: 'bounded research', maxTokens: 1000 });
  assert.equal(requestedMaxTokens, 1000);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.unresolved, ['max_tokens_exceeded']);
  assert.match(result.summary, /1000 Token.*实际 1001/);
  assert.deepEqual(events.map(event => event.type), ['start', 'text_delta', 'usage', 'done']);
});

test('subagent estimates usage and warns when a provider omits token statistics', async () => {
  const events = [];
  const runner = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => ({
      async *completeStream() {
        yield '{"summary":"estimated usage"}';
      }
    }),
    getModel: () => 'test-model',
    getReasoningEffort: () => 'low',
    getTools: () => [],
    executeTool: async () => '',
    onEvent: event => events.push(event)
  });

  const result = await runner.runResult({ description: 'provider without usage', maxTokens: 1000 });
  assert.equal(result.status, 'completed');
  assert.equal(events.filter(event => event.type === 'warning').length, 1);
  assert.ok(events.find(event => event.type === 'usage').usage.total_tokens > 0);
  assert.match(events.find(event => event.type === 'warning').message, /估算/);
});

test('abort helpers normalize DOM and Node abort error shapes without treating timeout as abort', () => {
  assert.equal(isAbortError(new DOMException('cancelled', 'AbortError')), true);
  assert.equal(isAbortError({ name: 'Error', code: 'ABORT_ERR' }), true);
  assert.equal(isAbortError(new Error('timeout')), false);
  const normalized = normalizeAbortError(new DOMException('cancelled', 'AbortError'));
  assert.equal(normalized.name, 'AbortError');
  assert.equal(normalized.code, 'ABORT_ERR');
});

test('subagent refuses a tool batch that would exceed its tool-call budget', async () => {
  let executed = 0;
  const runner = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => ({
      async *completeStream(_messages, options) {
        options.onToolCall?.([
          { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } },
          { id: 'grep-1', type: 'function', function: { name: 'grep', arguments: '{}' } }
        ]);
      }
    }),
    getModel: () => 'test-model',
    getReasoningEffort: () => 'low',
    getTools: () => [],
    executeTool: async () => { executed += 1; return ''; }
  });

  const result = await runner.runResult({ description: 'bounded tools', maxToolCalls: 1 });
  assert.equal(executed, 0);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.unresolved, ['max_tool_calls_exceeded']);
});

test('subagent converts provider stream failures and cancellation into stable results', async () => {
  const failing = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => ({
      async *completeStream() {
        yield 'partial';
        throw new Error('stream disconnected');
      }
    }),
    getModel: () => 'test-model',
    getReasoningEffort: () => 'low',
    getTools: () => [],
    executeTool: async () => ''
  });
  const failed = await failing.runResult({ description: 'handle stream error' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.summary, /stream disconnected/);
  assert.deepEqual(failed.unresolved, ['runtime_error']);

  const controller = new AbortController();
  const cancelled = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => ({
      async *completeStream() {
        yield 'partial';
        controller.abort();
        const error = new Error('cancelled');
        error.name = 'AbortError';
        throw error;
      }
    }),
    getModel: () => 'test-model',
    getReasoningEffort: () => 'low',
    getTools: () => [],
    executeTool: async () => ''
  });
  const aborted = await cancelled.runResult(
    { description: 'handle cancellation' },
    { abortSignal: controller.signal }
  );
  assert.equal(aborted.status, 'aborted');
  assert.deepEqual(aborted.unresolved, ['aborted']);
});

test('subagent rejects recursive invocation before calling the provider', async () => {
  let providerCalls = 0;
  const runner = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => ({
      async *completeStream() { providerCalls += 1; }
    }),
    getModel: () => 'test-model',
    getReasoningEffort: () => 'low',
    getTools: () => [],
    executeTool: async () => ''
  });
  const output = await runner.run({ description: 'delegate again' }, { depth: 1, agentId: 'sub-parent' });
  assert.equal(providerCalls, 0);
  assert.match(output, /recursive_subagent_denied/);
});

test('Plan Mode allows the subagent facade while child operations remain separately checked', async () => {
  const engine = new PermissionEngine();
  const result = await engine.evaluate({ mode: 'plan', toolName: 'subagent', args: {}, userIntent: 'research' });
  assert.equal(result.action, 'allow');
  assert.equal((await engine.evaluate({ mode: 'plan', toolName: 'write', args: {}, userIntent: 'research' })).action, 'deny');
});

test('task store persists nested subagent state', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-subagent-task-'));
  try {
    const store = new TaskStore(cwd);
    store.setTaskScope('session-a');
    store.createTask({ title: '子代理接入', id: 'implement', content: '实现运行时' });
    store.setTaskAgent('implement', { id: 'sub-1234', role: 'implement', status: 'running' });
    assert.deepEqual(store.getPlan().tasks[0].agent, {
      id: 'sub-1234', role: 'implement', status: 'running', summary: undefined
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('subagent tool validates input and forwards execution context', async () => {
  const controller = new AbortController();
  let received;
  const tool = new SubagentTool(async (request, context) => {
    received = { request, context };
    return 'ok';
  });
  assert.match(await tool.execute({}), /^错误:/);
  assert.match(await tool.execute({ description: 'review code', timeoutMs: 50 }), /timeoutMs/);
  assert.match(await tool.execute({ description: 'review code', maxTokens: 999 }), /maxTokens/);
  assert.match(await tool.execute({ description: 'review code', maxToolCalls: 0 }), /maxToolCalls/);
  assert.equal(await tool.execute({
    description: 'review code',
    role: 'review',
    timeoutMs: 45000,
    maxTokens: 12000,
    maxToolCalls: 8
  }, { abortSignal: controller.signal }), 'ok');
  assert.equal(received.request.role, 'review');
  assert.equal(received.request.timeoutMs, 45000);
  assert.equal(received.request.maxTokens, 12000);
  assert.equal(received.request.maxToolCalls, 8);
  assert.equal(received.context.abortSignal, controller.signal);
});

test('subagent tool validates and forwards per-agent runtime configuration', async () => {
  let received;
  const tool = new SubagentTool(async request => {
    received = request;
    return 'ok';
  });
  assert.match(await tool.execute({ description: 'review', provider: 'other' }), /provider/);
  assert.match(await tool.execute({ description: 'review', reasoningEffort: 'extreme' }), /reasoningEffort/);
  assert.match(await tool.execute({ description: 'review', instructions: '' }), /instructions/);
  assert.equal(await tool.execute({
    description: 'review',
    model: 'glm-5.2',
    provider: 'volcengine',
    reasoningEffort: 'high',
    instructions: '只关注并发'
  }), 'ok');
  assert.equal(received.model, 'glm-5.2');
  assert.equal(received.provider, 'volcengine');
  assert.equal(received.reasoningEffort, 'high');
  assert.equal(received.instructions, '只关注并发');
});

test('bash tool stops promptly when its abort signal fires', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const tool = new BashTool();
  const startedAt = Date.now();
  const promise = tool.execute({ command: 'node -e "setTimeout(() => {}, 10000)"' }, { abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.match(await promise, /^\[命令已中止\]/);
  assert.ok(Date.now() - startedAt < 3000);
});

test('shared executor applies hooks and records child edits for rewind', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-subagent-executor-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git('init');
    git('config', 'user.name', 'Haji Test');
    git('config', 'user.email', 'haji@example.test');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.haji/\n');
    fs.writeFileSync(path.join(cwd, 'target.txt'), 'before\n');
    git('add', '.gitignore', 'target.txt');
    git('commit', '-m', 'initial');

    const hooks = new HookEngine();
    const seen = [];
    hooks.register('PreToolUse', context => { seen.push(['pre', context.agentId]); });
    hooks.register('PostToolUse', context => { seen.push(['post', context.agentId]); });
    const snapshots = new SnapshotEngine(cwd);
    snapshots.setScope('session-a');
    const anchor = snapshots.createAnchor('before parent turn');
    const edit = {
      name: 'edit',
      definition: definition('edit'),
      async execute(args, context) {
        assert.equal(context.agentId, 'sub-child');
        fs.writeFileSync(path.join(cwd, String(args.path)), 'after\n');
        return 'edited';
      }
    };
    const executor = new SharedToolExecutor({
      cwd,
      tools: new Map([['edit', edit]]),
      hookEngine: hooks,
      permissionEngine: new PermissionEngine(),
      snapshotEngine: snapshots,
      taskStore: new TaskStore(path.join(cwd, '.haji', 'tasks'))
    });
    const result = await executor.execute('edit', { path: 'target.txt' }, {
      toolCallId: 'edit-1',
      agentId: 'sub-child',
      depth: 1,
      permissionMode: 'bypass-permissions',
      anchorSnapshotId: anchor
    });
    assert.equal(result.blocked, false);
    assert.deepEqual(seen, [['pre', 'sub-child'], ['post', 'sub-child']]);
    assert.equal(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'after\n');
    assert.equal(snapshots.rollbackOwnedChanges(anchor).ok, true);
    assert.equal(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'before\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
