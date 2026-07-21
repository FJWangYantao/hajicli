import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PERMISSION_MODES, PermissionEngine, SystemPromptManager, TaskStore } from '@hajicli/core';
import {
  ALL_TASKS_COMPLETE_MARKER,
  PLAN_READY_MARKER,
  TaskCreateTool,
  TaskFinishTool,
  UpdateTaskTool
} from '@hajicli/plugins';

test('Plan Mode exposes planning tools but blocks implementation tools', async () => {
  assert.ok(PERMISSION_MODES.some(mode => mode.value === 'plan'));
  const engine = new PermissionEngine();
  const base = { mode: 'plan', args: {}, userIntent: 'inspect and plan' };
  for (const toolName of ['read', 'grep', 'taskcreate', 'tasklist', 'updatetask', 'subagent', 'verifyagent']) {
    assert.equal((await engine.evaluate({ ...base, toolName })).action, 'allow');
  }
  for (const toolName of ['write', 'edit', 'bash', 'taskfinish']) {
    assert.equal((await engine.evaluate({ ...base, toolName })).action, 'deny');
  }
});

test('Plan prompt describes incremental task creation and approval boundary', async () => {
  const manager = new SystemPromptManager();
  const context = { cwd: 'C:/repo', os: 'Windows', tools: ['read', 'taskcreate', 'tasklist', 'updatetask'], reasoningEffort: 'medium' };
  const prompt = await manager.generatePrompt({ ...context, permissionMode: 'plan' });
  assert.match(prompt, /当前权限模式：Plan/);
  assert.match(prompt, /一条一条创建任务/);
  assert.match(prompt, /finalize=true/);
  assert.match(prompt, /优先 4-8 个汉字/);
  assert.match(prompt, /最多 12 个字符/);
  assert.match(prompt, /单独输出一次面向用户审阅的方案正文/);
  assert.match(prompt, /此轮不得调用工具/);
  assert.match(prompt, /创建任务前必须先调用 tasklist/);
});

test('taskfinish prompt keeps orchestration guidance without repeating its schema', async () => {
  const manager = new SystemPromptManager();
  const prompt = await manager.generatePrompt({
    cwd: 'C:/repo',
    os: 'Windows',
    tools: ['updatetask', 'taskfinish'],
    reasoningEffort: 'medium',
    permissionMode: 'default'
  });

  assert.match(prompt, /taskfinish：提交该任务的实际验证结果/);
  assert.doesNotMatch(prompt, /taskfinish：.*updatetask\(in_progress\).*taskfinish/);
});

test('plan titles are kept concise', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-plan-title-'));
  try {
    const store = new TaskStore(cwd);
    store.setTaskScope('session-a');
    const create = new TaskCreateTool(store);
    const output = await create.execute({
      title: 'hajicli 代码重构实施计划',
      id: 'inspect',
      content: 'inspect flow'
    });
    assert.match(output, /^错误: 计划标题最多 12 个字符/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('task workflow enforces dependencies, verification and removal from active list', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-plan-'));
  try {
    const store = new TaskStore(cwd);
    store.setTaskScope('session-a');
    const create = new TaskCreateTool(store);
    const update = new UpdateTaskTool(store);
    const finish = new TaskFinishTool(store);
    await create.execute({ title: 'Plan mode', id: 'inspect', content: 'inspect flow' });
    const ready = await create.execute({ id: 'implement', content: 'implement flow', blockedBy: ['inspect'], finalize: true });
    assert.match(ready, new RegExp(PLAN_READY_MARKER.replace(/[\[\]]/g, '\\$&')));
    assert.match(await finish.execute({ taskId: 'inspect', verification: 'tests passed' }), /updatetask.*in_progress/);
    assert.match(finish.definition.function.description, /updatetask\(in_progress\).*实施.*验证.*taskfinish/);
    assert.match(await update.execute({ taskId: 'implement', status: 'in_progress' }), /^错误:/);
    await update.execute({ taskId: 'inspect', status: 'in_progress' });
    await finish.execute({ taskId: 'inspect', verification: 'tests passed' });
    assert.equal(store.getPlan().tasks.some(task => task.id === 'inspect'), false);
    await update.execute({ taskId: 'implement', status: 'in_progress' });
    const completed = await finish.execute({ taskId: 'implement', verification: 'build passed' });
    assert.match(completed, new RegExp(ALL_TASKS_COMPLETE_MARKER.replace(/[\[\]]/g, '\\$&')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('approval offers exactly three choices and defaults to Auto Execute', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /\[系统计划审阅要求\].*停止调用工具.*方案正文/);
  assert.match(source, /permissionMode === 'plan' && planReadyForReview[\s\S]*!textContent\.trim\(\)[\s\S]*本次不进入审批/);
  assert.match(source, /value: 'auto', label: 'Auto Execute'/);
  assert.match(source, /value: 'manual', label: 'Approve Manually'/);
  assert.match(source, /value: 'no', label: 'No, Revise Plan'/);
  assert.match(source, /selectedValue: 'auto'/);
  assert.match(source, /review\.value === 'auto' \? 'auto' : 'default'/);
  assert.match(source, /每个任务都严格按 updatetask\(in_progress\).*实际验证.*taskfinish/);
});

test('Plan Mode sends only read-only, planning and isolated subagent tool definitions', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /permissionMode === 'plan'/);
  assert.match(source, /\['subagent', 'verifyagent'\]\.includes\(tool\.name\)/);
  assert.match(source, /\['taskcreate', 'tasklist', 'updatetask'\]/);
  assert.doesNotMatch(source, /\['taskcreate', 'tasklist', 'updatetask', 'taskfinish'\]/);
});

test('the large HAJI logo remains until the first ordinary user message', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const terminalSource = fs.readFileSync(new URL('../src/terminal-input.ts', import.meta.url), 'utf8');
  assert.match(source, /console\.log\(LOGO\)/);
  assert.match(source, /header: LOGO\.trim\(\),\s*compactHeader: colors\.boldPurple\('HAJI'\)/);
  assert.match(source, /if \(!trimmedInput\.startsWith\('\/'\)\) \{\s*ui\.dismissStartupHeader\(\)/);
  assert.match(terminalSource, /dismissStartupHeader\(\): void/);
  assert.doesNotMatch(terminalSource, /startupHeaderDurationMs/);
  assert.match(terminalSource, /const headerRows = header \? wrapAnsi\(header, width\) : \[\]/);
});
