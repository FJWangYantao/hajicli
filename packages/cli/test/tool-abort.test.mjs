import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HookEngine, PermissionEngine, SnapshotEngine, TaskStore } from '@hajicli/core';
import {
  BashTool,
  EditFileTool,
  GlobalFindFilesTool,
  GrepSearchTool,
  ReadFileTool,
  WriteFileTool
} from '@hajicli/plugins';
import { runRipgrep } from '../../plugins/dist/ripgrep.js';
import { SharedToolExecutor } from '../dist/tool-executor.js';

const definition = name => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } }
});

test('file and search tools honor an already-aborted execution context', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-tool-abort-'));
  const previousCwd = process.cwd();
  const target = path.join(cwd, 'target.txt');
  fs.writeFileSync(target, 'before\n');
  process.chdir(cwd);

  try {
    const controller = new AbortController();
    controller.abort();
    const context = { abortSignal: controller.signal };

    assert.equal(await new ReadFileTool().execute({ path: 'target.txt' }, context), '[文件读取已中止]');
    assert.equal(await new WriteFileTool().execute({ path: 'target.txt', content: 'after\n' }, context), '[文件写入已中止]');
    assert.equal(await new EditFileTool().execute({ path: 'target.txt', oldText: 'before', newText: 'after' }, context), '[文件编辑已中止]');
    assert.equal(await new GlobalFindFilesTool().execute({}, context), '[文件查找已中止]');
    assert.equal(await new GrepSearchTool().execute({ query: 'before' }, context), '[Grep 搜索已中止]');
    assert.equal(fs.readFileSync(target, 'utf8'), 'before\n');
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('ripgrep helper terminates an active child when aborted', async () => {
  const controller = new AbortController();
  const promise = runRipgrep(
    ['-e', 'setTimeout(() => {}, 10000)'],
    process.cwd(),
    controller.signal,
    process.execPath
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise, error => error instanceof Error && error.name === 'AbortError');
});

test('shared executor does not start a tool if abort fires during pre-hook', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-executor-abort-'));
  let releaseHook;
  let executed = false;
  const hookEngine = new HookEngine();
  hookEngine.register('PreToolUse', () => new Promise(resolve => { releaseHook = resolve; }));
  const tool = {
    name: 'read',
    definition: definition('read'),
    async execute() {
      executed = true;
      return 'unexpected';
    }
  };
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([['read', tool]]),
    hookEngine,
    permissionEngine: new PermissionEngine(),
    snapshotEngine: new SnapshotEngine(cwd),
    taskStore: new TaskStore(path.join(cwd, '.haji', 'tasks'))
  });
  const controller = new AbortController();

  try {
    const pending = executor.execute('read', {}, { abortSignal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    releaseHook();
    const result = await pending;
    assert.equal(result.output, '[工具执行已中止]');
    assert.equal(result.blocked, true);
    assert.equal(executed, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('shared executor appends mutation warnings instead of silently discarding them', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-mutation-warning-'));
  const tool = {
    name: 'edit',
    definition: definition('edit'),
    async execute() { return '[文件精准编辑成功]'; }
  };
  const snapshotEngine = {
    beginMutation() {
      return { anchorSnapshotId: 'anchor-1', beforeSnapshotId: 'before-1', paths: ['target.txt'] };
    },
    completeMutation() {
      return {
        recordId: 'mutation-1',
        headChanged: true,
        warning: '[快照警告] 工具执行期间 Git HEAD 发生变化；本次 mutation 已记录并标记为不可自动回退。'
      };
    }
  };
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([['edit', tool]]),
    hookEngine: new HookEngine(),
    permissionEngine: new PermissionEngine(),
    snapshotEngine,
    taskStore: new TaskStore(path.join(cwd, '.haji', 'tasks'))
  });

  try {
    const result = await executor.execute('edit', { path: 'target.txt' }, {
      anchorSnapshotId: 'anchor-1',
      permissionMode: 'bypass-permissions'
    });
    assert.match(result.output, /HEAD.*mutation.*不可自动回退/);
    assert.equal(result.blocked, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('successful parent tools expose their verification evidence ID', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-evidence-id-'));
  const tool = {
    name: 'read',
    definition: definition('read'),
    async execute() { return 'file contents'; }
  };
  const recorded = [];
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([['read', tool]]),
    hookEngine: new HookEngine(),
    permissionEngine: new PermissionEngine(),
    snapshotEngine: new SnapshotEngine(cwd),
    taskStore: new TaskStore(path.join(cwd, '.haji', 'tasks')),
    onToolExecuted: event => recorded.push(event)
  });

  try {
    const result = await executor.execute('read', {}, { toolCallId: 'call-parent-read-1' });
    assert.equal(result.blocked, false);
    assert.match(result.output, /\[verification_evidence_id: call-parent-read-1\]$/);
    assert.equal(recorded[0].output, result.output);

    const childResult = await executor.execute('read', {}, {
      agentId: 'sub-child',
      toolCallId: 'call-child-read-1'
    });
    assert.doesNotMatch(childResult.output, /verification_evidence_id/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('bash reports taskkill failure and attempts a fallback kill', async () => {
  const controller = new AbortController();
  const killSignals = [];
  const child = {
    pid: 4242,
    exitCode: null,
    kill(signal) {
      killSignals.push(signal);
      return true;
    }
  };
  const commandExecutor = () => child;
  const cleanupCalls = [];
  const killedPids = [];
  const fileExecutor = (file, _args, _options, callback) => {
    cleanupCalls.push(file);
    queueMicrotask(() => {
      if (file === 'taskkill.exe') {
        const error = Object.assign(new Error('access denied'), { code: 5 });
        callback(error, '', '');
        return;
      }
      callback(null, '5002,5001\n', '');
    });
    return {};
  };
  const tool = new BashTool(commandExecutor, fileExecutor, (pid, signal) => {
    killedPids.push([pid, signal]);
    return true;
  });

  const pending = tool.execute({ command: 'long-running-command' }, { abortSignal: controller.signal });
  controller.abort();
  const output = await pending;

  assert.match(output, /^\[命令已中止\]/);
  assert.match(output, /taskkill 失败.*进程枚举兜底清理/);
  assert.deepEqual(cleanupCalls, ['powershell.exe', 'taskkill.exe']);
  assert.deepEqual(killedPids, [[5002, 'SIGTERM'], [5001, 'SIGTERM']]);
  assert.deepEqual(killSignals, ['SIGTERM']);
});
