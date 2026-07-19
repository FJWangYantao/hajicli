import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AGENT_VERIFICATION_CONTEXT_END,
  AGENT_VERIFICATION_CONTEXT_START,
  AgentManager,
  formatPendingAgentVerificationContext,
  TaskStore
} from '@hajicli/core';
import { TaskFinishTool, UpdateTaskTool, VerifyAgentTool } from '@hajicli/plugins';
import { parseSubagentCommand } from '../dist/agent-commands.js';
import { buildAgentPanelRows, formatAgentElapsed } from '../dist/terminal-input.js';

function completed(agentId, summary = 'done') {
  return { agentId, status: 'completed', summary, filesChanged: [], verification: [], unresolved: [] };
}

test('manual subagent command supports background, role and Todo linkage', () => {
  assert.deepEqual(parseSubagentCommand('bg review --task inspect 检查当前 diff'), {
    background: true,
    role: 'review',
    taskId: 'inspect',
    description: '检查当前 diff'
  });
  assert.deepEqual(parseSubagentCommand('research 查找 Provider 重复代码'), {
    background: false,
    role: 'research',
    taskId: undefined,
    description: '查找 Provider 重复代码'
  });
});

test('AgentManager runs at most three read-only agents and pumps the queue', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-agent-pool-'));
  try {
    const controls = new Map();
    const manager = new AgentManager({ agentsDir: cwd, maxReadonlyConcurrency: 3 });
    manager.setScope('session-a');
    const launches = Array.from({ length: 4 }, (_, index) => manager.launch({
      role: 'research', description: `job-${index}`, background: true, access: 'readonly'
    }, ({ agentId }) => new Promise(resolve => controls.set(agentId, resolve))));

    assert.equal(manager.list().filter(agent => agent.status === 'running').length, 3);
    assert.equal(manager.list().filter(agent => agent.status === 'queued').length, 1);
    const first = launches[0].agent.id;
    controls.get(first)(completed(first));
    await launches[0].completion;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.list().filter(agent => agent.status === 'running').length, 3);
    assert.equal(manager.list().filter(agent => agent.status === 'queued').length, 0);

    for (const launch of launches.slice(1)) {
      const control = controls.get(launch.agent.id);
      control?.(completed(launch.agent.id));
    }
    await Promise.all(launches.slice(1).map(launch => launch.completion));
    assert.equal(manager.list().every(agent => agent.status === 'awaiting_verification'), true);
    assert.equal(manager.drainNotifications().filter(item => item.type === 'completed').length, 4);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('queued agents can be aborted and write agents never run in parallel', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-agent-abort-'));
  try {
    const controls = new Map();
    const manager = new AgentManager({ agentsDir: cwd, maxReadonlyConcurrency: 1 });
    manager.setScope('session-a');
    const first = manager.launch({ role: 'research', description: 'one', background: true, access: 'readonly' },
      ({ agentId }) => new Promise(resolve => controls.set(agentId, resolve)));
    const queued = manager.launch({ role: 'review', description: 'two', background: true, access: 'readonly' },
      ({ agentId }) => new Promise(resolve => controls.set(agentId, resolve)));
    assert.equal(manager.abort(queued.agent.id), true);
    assert.equal((await queued.completion).status, 'aborted');
    assert.throws(() => manager.launch({
      role: 'implement', description: 'writer', background: false, access: 'workspace-write'
    }, async ({ agentId }) => completed(agentId)), /不能与其他子代理并行/);
    controls.get(first.agent.id)(completed(first.agent.id));
    await first.completion;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('verification requires parent evidence collected after child completion', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-agent-verify-'));
  try {
    const manager = new AgentManager({ agentsDir: cwd });
    manager.setScope('session-a');
    const launch = manager.launch({ role: 'review', description: 'review', background: false, access: 'readonly' },
      async ({ agentId }) => completed(agentId, 'finding'));
    const finished = await launch.completion;
    assert.equal(finished.status, 'awaiting_verification');
    assert.throws(() => manager.verify(finished.id, 'verified', 'looks good', []), /evidenceToolCallId/);
    const secondLaunch = manager.launch({ role: 'research', description: 'research', background: false, access: 'readonly' },
      async ({ agentId }) => completed(agentId, 'second finding'));
    const secondFinished = await secondLaunch.completion;
    manager.recordParentEvidence(
      'read-parent-1',
      'read',
      Math.max(finished.finishedAt || 0, secondFinished.finishedAt || 0) + 1
    );
    const verified = manager.verify(finished.id, 'verified', '父 Agent 重新读取了目标文件', ['read-parent-1']);
    assert.equal(verified.status, 'verified');
    assert.deepEqual(verified.verification.evidenceToolCallIds, ['read-parent-1']);
    assert.throws(
      () => manager.verify(secondFinished.id, 'verified', '尝试复用证据', ['read-parent-1']),
      /已被 Agent .* 使用/
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('verification evidence and consumption survive scope reloads', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-agent-evidence-reload-'));
  try {
    const firstManager = new AgentManager({ agentsDir: cwd });
    firstManager.setScope('session-a');
    const firstLaunch = firstManager.launch({
      role: 'review', description: 'first review', background: false, access: 'readonly'
    }, async ({ agentId }) => completed(agentId, 'first finding'));
    const secondLaunch = firstManager.launch({
      role: 'research', description: 'second review', background: false, access: 'readonly'
    }, async ({ agentId }) => completed(agentId, 'second finding'));
    const [first, second] = await Promise.all([firstLaunch.completion, secondLaunch.completion]);
    firstManager.recordParentEvidence(
      'read-parent-persisted',
      'read',
      Math.max(first.finishedAt || 0, second.finishedAt || 0) + 1
    );

    const reloaded = new AgentManager({ agentsDir: cwd });
    reloaded.setScope('session-a');
    assert.equal(
      reloaded.verify(first.id, 'verified', '重新载入后使用持久化证据', ['read-parent-persisted']).status,
      'verified'
    );

    const reloadedAgain = new AgentManager({ agentsDir: cwd });
    reloadedAgain.setScope('session-a');
    assert.throws(
      () => reloadedAgain.verify(second.id, 'verified', '尝试复用已消费证据', ['read-parent-persisted']),
      /已被 Agent .* 使用/
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('corrupt Agent state is preserved and blocks destructive rewrites', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-agent-corrupt-'));
  const statePath = path.join(cwd, 'broken-scope.json');
  const corruptContent = '{"version":1,"records":[';
  fs.writeFileSync(statePath, corruptContent, 'utf8');
  const warnings = [];

  try {
    const manager = new AgentManager({ agentsDir: cwd, onWarning: warning => warnings.push(warning) });
    manager.setScope('broken-scope');
    manager.recordParentEvidence('read-after-corruption', 'read', Date.now());

    assert.equal(fs.readFileSync(statePath, 'utf8'), corruptContent);
    assert.equal(manager.list().length, 0);
    assert.match(warnings.join('\n'), /保留原文件.*暂停.*持久化/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('pending verification context is rebuilt from persisted Agent records', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-agent-context-'));
  try {
    const manager = new AgentManager({ agentsDir: cwd });
    manager.setScope('session-a');
    const launch = manager.launch({
      role: 'research', description: '检查压缩链路', background: true, access: 'readonly'
    }, async ({ agentId }) => completed(agentId, '发现待验证结论'));
    const finished = await launch.completion;

    const restored = new AgentManager({ agentsDir: cwd });
    restored.setScope('session-a');
    const context = formatPendingAgentVerificationContext(restored.list());
    assert.match(context, new RegExp(AGENT_VERIFICATION_CONTEXT_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(context, new RegExp(finished.id));
    assert.match(context, /发现待验证结论/);
    assert.match(context, /verification_evidence_id/);
    assert.match(context, new RegExp(AGENT_VERIFICATION_CONTEXT_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('verifyagent and taskfinish enforce the independent verification gate', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-agent-task-gate-'));
  try {
    const store = new TaskStore(cwd);
    store.setTaskScope('session-a');
    store.createTask({ title: '多代理调度', id: 'implement', content: '实现 AgentManager' });
    await new UpdateTaskTool(store).execute({ taskId: 'implement', status: 'in_progress' });
    store.setTaskAgent('implement', { id: 'sub-1', role: 'implement', status: 'awaiting_verification' });
    assert.match(await new TaskFinishTool(store).execute({ taskId: 'implement', verification: 'tests passed' }), /^错误: 关联子代理/);

    let input;
    const verify = new VerifyAgentTool(async value => { input = value; return 'verified'; });
    assert.match(await verify.execute({ agentId: 'sub-1', verdict: 'verified', evidence: 'parent test passed' }), /evidenceToolCallIds/);
    assert.equal(await verify.execute({
      agentId: 'sub-1',
      verdict: 'verified',
      evidence: 'parent test passed',
      evidenceToolCallIds: ['test-parent-1']
    }), 'verified');
    assert.equal(input.agentId, 'sub-1');
    assert.deepEqual(input.evidenceToolCallIds, ['test-parent-1']);
    store.setTaskAgent('implement', { id: 'sub-1', role: 'implement', status: 'verified' });
    assert.doesNotMatch(await new TaskFinishTool(store).execute({ taskId: 'implement', verification: 'parent tests passed' }), /^错误:/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('agent elapsed formatting is stable for seconds and minutes', () => {
  assert.equal(formatAgentElapsed(1000, 13_500), '12s');
  assert.equal(formatAgentElapsed(1000, 72_000), '1m11s');
});

test('agent panel shows concurrency, current tool, elapsed time and token usage', () => {
  const rows = buildAgentPanelRows([
    { id: 'sub-a1', role: 'research', status: 'running', startedAt: 1000, currentTool: 'grep', totalTokens: 1800 },
    { id: 'sub-b2', role: 'review', status: 'queued', totalTokens: 0 }
  ], 100, 4, 13_500).map(row => row.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
  assert.equal(rows[0], 'Agents 1 running · 1 queued');
  assert.match(rows[1], /sub-a1\s+research · grep · 12s · 1\.8k tok/);
  assert.match(rows[2], /sub-b2\s+review · queued/);
});

test('CLI registers deterministic subagent and agent management commands', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /command: '\/subagent'/);
  assert.match(source, /command: '\/agents'/);
  assert.match(source, /agentManager\.abortAll\(\)/);
  assert.match(source, /maxReadonlyConcurrency: 3/);
  assert.match(source, /refreshAgentVerificationContext\(messages\)/);
  assert.doesNotMatch(source, /deliveredAgentResults/);
});
