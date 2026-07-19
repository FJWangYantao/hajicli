import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HookEngine, PermissionEngine, SnapshotEngine, SubagentRunner, TaskStore } from '@hajicli/core';
import { BashTool, SubagentTool } from '@hajicli/plugins';
import { SharedToolExecutor } from '../dist/tool-executor.js';

const definition = name => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } }
});

test('subagent uses fresh context, filters recursive/task tools and returns only final result', async () => {
  const calls = [];
  const provider = {
    async complete(messages, options) {
      calls.push({ messages: structuredClone(messages), tools: options.tools.map(tool => tool.function.name) });
      options.onUsage?.({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      if (calls.length === 1) {
        options.onToolCall([{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }]);
        return '';
      }
      return JSON.stringify({
        summary: '已完成隔离调研',
        filesChanged: [],
        verification: ['read a.ts'],
        unresolved: []
      });
    },
    async *completeStream() {}
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
  assert.deepEqual(events.map(event => event.type), ['start', 'usage', 'tool', 'usage', 'done']);
});

test('subagent rejects recursive invocation before calling the provider', async () => {
  let providerCalls = 0;
  const runner = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => ({
      async complete() { providerCalls += 1; return ''; },
      async *completeStream() {}
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
  assert.equal(await tool.execute({ description: 'review code', role: 'review' }, { abortSignal: controller.signal }), 'ok');
  assert.equal(received.request.role, 'review');
  assert.equal(received.context.abortSignal, controller.signal);
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
