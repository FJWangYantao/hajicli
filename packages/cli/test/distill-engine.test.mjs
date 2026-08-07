import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DistillEngine, ExperienceStore } from '@hajicli/core';

function createStoreWithTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-dist-'));
  const cwd = path.join(tmp, 'project');
  const userDir = path.join(tmp, 'user', '.haji');
  const projectDir = path.join(cwd, '.haji');
  fs.mkdirSync(cwd, { recursive: true });
  const store = new ExperienceStore({ cwd, userDir, projectDir });
  return { store, tmp };
}

function obs(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    sessionId: 's1',
    toolName: 'Bash',
    args: {},
    output: 'ok',
    failed: false,
    ...overrides
  };
}

// ─── 路径 A：统计模式检测 ─────────────────────────────────────────────────────

test('runDistill detects edit-before-read pattern when Read is missing', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const engine = new DistillEngine({
      store,
      provider: () => null,
      model: () => 'test'
    });
    const observations = [
      obs({ toolName: 'Edit', args: { file_path: '/a.ts' }, ts: minutesAgo(10) }),
      obs({ toolName: 'Edit', args: { file_path: '/b.ts' }, ts: minutesAgo(8) }),
      obs({ toolName: 'Edit', args: { file_path: '/c.ts' }, ts: minutesAgo(5) })
    ];
    const summary = await engine.runDistill(observations, {
      messages: [], cwd: '/proj', sessionId: 's1'
    });
    assert.ok(summary.statisticalInstincts >= 1);
    const instincts = store.loadInstincts(true);
    assert.ok(instincts.some(i => i.id === 'edit-before-read'), '应检测到 edit-before-read');
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill does not flag edit-before-read when Read precedes Edit', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const engine = new DistillEngine({ store, provider: () => null, model: () => 'm' });
    const observations = [
      obs({ toolName: 'ReadFile', args: { file_path: '/a.ts' }, ts: minutesAgo(10) }),
      obs({ toolName: 'Edit', args: { file_path: '/a.ts' }, ts: minutesAgo(9) }),
      obs({ toolName: 'ReadFile', args: { file_path: '/b.ts' }, ts: minutesAgo(8) }),
      obs({ toolName: 'Edit', args: { file_path: '/b.ts' }, ts: minutesAgo(7) })
    ];
    const summary = await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    assert.equal(summary.statisticalInstincts, 0);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill detects failed-pattern cluster (>=3 same errors)', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const engine = new DistillEngine({ store, provider: () => null, model: () => 'm' });
    const observations = [
      obs({ toolName: 'Bash', args: { command: 'pnpm test' }, output: '执行出错: ENOENT module not found', failed: true }),
      obs({ toolName: 'Bash', args: { command: 'pnpm test' }, output: '执行出错: ENOENT another', failed: true }),
      obs({ toolName: 'Bash', args: { command: 'pnpm test' }, output: '执行出错: ENOENT third', failed: true })
    ];
    const summary = await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    assert.ok(summary.statisticalInstincts >= 1);
    const instincts = store.loadInstincts(true);
    assert.ok(instincts.some(i => i.domain === 'error-prevention'), '应检测到 error-prevention 规则');
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill detects repeated WriteFile on same file', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const engine = new DistillEngine({ store, provider: () => null, model: () => 'm' });
    const observations = [
      obs({ toolName: 'WriteFile', args: { file_path: '/x.ts' }, output: 'written' }),
      obs({ toolName: 'WriteFile', args: { file_path: '/x.ts' }, output: 'written' })
    ];
    const summary = await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    assert.ok(summary.statisticalInstincts >= 1);
    const instincts = store.loadInstincts(true);
    assert.ok(instincts.some(i => i.id === 'use-edit-not-repeated-write'));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill reinforces existing instinct on repeat detection', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 预置一条规则
    await store.upsertInstinct({
      id: 'edit-before-read', trigger: 't', action: 'a',
      confidence: 0.6, domain: 'workflow', source: 'statistical',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 2
    });
    const engine = new DistillEngine({ store, provider: () => null, model: () => 'm' });
    const observations = [
      obs({ toolName: 'Edit', args: { file_path: '/a.ts' } }),
      obs({ toolName: 'Edit', args: { file_path: '/b.ts' } })
    ];
    const summary = await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    assert.ok(summary.reinforced >= 1, '应强化既有规则');
    const updated = store.loadInstincts(true).find(i => i.id === 'edit-before-read');
    assert.ok(updated);
    assert.equal(updated.confidence, 0.65); // 0.6 + 0.05
    assert.equal(updated.occurrenceCount, 3);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── 路径 B：LLM 语义分析（用 mock provider） ────────────────────────────────

/** Mock provider：返回预设的 JSON。 */
function mockProvider(response) {
  return {
    complete: async () => response,
    completeStream: async function* () { yield response; }
  };
}

test('runDistill triggers LLM path when failures exist', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const llmResponse = JSON.stringify({
      instincts: [{
        id: 'check-imports-first',
        trigger: 'when adding a new dependency',
        action: 'Run pnpm install before importing',
        domain: 'error-prevention'
      }],
      memories: [{
        id: 'pnpm-workspace',
        name: 'workspace setup',
        type: 'project',
        content: 'This is a pnpm workspace monorepo'
      }]
    });
    const engine = new DistillEngine({
      store,
      provider: () => mockProvider(llmResponse),
      model: () => 'mock'
    });
    const observations = [
      obs({ toolName: 'Bash', args: { command: 'node x.js' }, output: '执行出错: not found', failed: true })
    ];
    const summary = await engine.runDistill(observations, {
      messages: [{ role: 'user', content: 'test' }], cwd: '/p', sessionId: 's'
    });
    assert.equal(summary.llmTriggered, true);
    assert.equal(summary.llmInstincts, 1);
    assert.equal(summary.memoryCandidates, 1);
    // memory 候选应进入 staging
    const staging = store.loadMemories('all').filter(m => m.status === 'staging');
    assert.equal(staging.length, 1);
    assert.equal(staging[0].id, 'pnpm-workspace');
    // LLM 产出的 instinct 应已入库
    const instincts = store.loadInstincts(true);
    assert.ok(instincts.some(i => i.id === 'check-imports-first' && i.source === 'llm'));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill does not trigger LLM when few observations and no failures', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    let providerCalled = false;
    const engine = new DistillEngine({
      store,
      provider: () => { providerCalled = true; return mockProvider('{}'); },
      model: () => 'mock'
    });
    const observations = [
      obs({ toolName: 'ReadFile', args: { path: '/a' } }),
      obs({ toolName: 'ReadFile', args: { path: '/b' } })
    ];
    const summary = await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    assert.equal(summary.llmTriggered, false);
    assert.equal(providerCalled, false); // provider 工厂不应被调用
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill triggers LLM when observations reach threshold (20)', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const engine = new DistillEngine({
      store,
      provider: () => mockProvider('{"instincts":[],"memories":[]}'),
      model: () => 'mock'
    });
    const observations = Array.from({ length: 20 }, (_, i) =>
      obs({ toolName: 'ReadFile', args: { path: `/f${i}` } })
    );
    const summary = await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    assert.equal(summary.llmTriggered, true);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill tolerates malformed LLM response', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const engine = new DistillEngine({
      store,
      provider: () => mockProvider('抱歉，这不是 JSON'),
      model: () => 'mock'
    });
    const observations = [
      obs({ toolName: 'Bash', output: '执行出错: x', failed: true })
    ];
    const summary = await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    assert.equal(summary.llmInstincts, 0);
    assert.equal(summary.memoryCandidates, 0);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill handles provider null gracefully', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const engine = new DistillEngine({
      store,
      provider: () => null,
      model: () => 'mock'
    });
    const observations = [
      obs({ toolName: 'Bash', output: '执行出错: x', failed: true })
    ];
    const summary = await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    // LLM 路径被触发但 provider 为 null，应安全跳过
    assert.equal(summary.llmTriggered, true);
    assert.equal(summary.llmInstincts, 0);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('runDistill returns empty summary for no observations', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const engine = new DistillEngine({ store, provider: () => null, model: () => 'm' });
    const summary = await engine.runDistill([], { messages: [], cwd: '/p', sessionId: 's' });
    assert.equal(summary.statisticalInstincts, 0);
    assert.equal(summary.llmTriggered, false);
    assert.ok(summary.notes.length > 0);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('deduplicateInstincts merges similar LLM outputs', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 两条 trigger/action token 高度重叠的规则（共享 read/edit/file/before/workflow 等）
    const llmResponse = JSON.stringify({
      instincts: [
        { id: 'read-before-edit', trigger: 'when edit file', action: 'read file before edit workflow', domain: 'workflow' },
        { id: 'read-file-before-edit', trigger: 'before edit file', action: 'read file first edit workflow', domain: 'workflow' }
      ],
      memories: []
    });
    const engine = new DistillEngine({
      store,
      provider: () => mockProvider(llmResponse),
      model: () => 'mock'
    });
    const observations = [
      obs({ toolName: 'Bash', output: '执行出错', failed: true })
    ];
    await engine.runDistill(observations, { messages: [], cwd: '/p', sessionId: 's' });
    // 两条高度相似的 instinct 应去重为一条
    const instincts = store.loadInstincts(true).filter(i => i.source === 'llm');
    assert.equal(instincts.length, 1, `应去重为 1 条，实际 ${instincts.length}`);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

function minutesAgo(min) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}
