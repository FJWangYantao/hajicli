import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ExperienceStore,
  isFailedToolOutput,
  jaccardSimilarity,
  tokenize
} from '@hajicli/core';

/**
 * 创建一个使用临时目录的 ExperienceStore，返回 store 与根目录。
 * 测试结束后由调用方清理 tmp。
 */
function createStoreWithTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-exp-'));
  const cwd = path.join(tmp, 'project');
  const userDir = path.join(tmp, 'user', '.haji');
  const projectDir = path.join(cwd, '.haji');
  fs.mkdirSync(cwd, { recursive: true });
  const store = new ExperienceStore({ cwd, userDir, projectDir });
  return { store, tmp, cwd, userDir, projectDir };
}

function makeInstinct(overrides = {}) {
  return {
    id: 'read-before-edit',
    trigger: 'when about to edit a file',
    action: 'Read the file first',
    confidence: 0.5,
    domain: 'workflow',
    source: 'statistical',
    deprecated: false,
    observedAt: new Date().toISOString(),
    occurrenceCount: 1,
    ...overrides
  };
}

function makeMemory(overrides = {}) {
  return {
    id: 'no-auto-commit',
    name: 'feedback-commit-timing',
    type: 'feedback',
    content: 'Do not auto commit. Wait for user confirm.',
    status: 'active',
    confidence: 0.8,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    keywords: ['commit', 'feedback'],
    ...overrides
  };
}

// ─── isFailedToolOutput ─────────────────────────────────────────────────────

test('isFailedToolOutput covers all failure prefixes', () => {
  assert.equal(isFailedToolOutput('错误: 工具 "X" 未注册。'), true);
  assert.equal(isFailedToolOutput('执行出错: ECONNREFUSED'), true);
  assert.equal(isFailedToolOutput('[工具执行已中止]'), true);
  assert.equal(isFailedToolOutput('[安全引擎拒绝拦截]'), true);
  assert.equal(isFailedToolOutput('[SUBAGENT_RESULT ...]{"status":"failed"}'), true);
  assert.equal(isFailedToolOutput('[SUBAGENT_RESULT ...]{"status":"completed"}'), false);
  assert.equal(isFailedToolOutput('文件已写入'), false);
  assert.equal(isFailedToolOutput(''), false);
});

test('isFailedToolOutput rejects partial matches', () => {
  assert.equal(isFailedToolOutput('安全: 某事'), false);   // 缺 [安全引擎拒绝拦截] 前缀
  assert.equal(isFailedToolOutput('已中止'), false);        // 缺方括号包裹
  assert.equal(isFailedToolOutput('[SUBAGENT...]{"status":"running"}'), false);
});

// ─── tokenize / jaccardSimilarity ───────────────────────────────────────────

test('tokenize extracts english tokens and CJK single chars', () => {
  const tokens = tokenize('Edit 文件 first edit File');
  assert.ok(tokens.has('edit'));
  assert.ok(tokens.has('file'));
  assert.ok(tokens.has('first'));
  assert.ok(tokens.has('文'));
  assert.ok(tokens.has('件'));
  // 长度 >=2 的英文才入
  assert.ok(!tokens.has('a'));
});

test('jaccardSimilarity handles identical, disjoint, and empty sets', () => {
  const a = tokenize('read edit write');
  const b = tokenize('read edit');
  assert.ok(jaccardSimilarity(a, b) > 0.5);
  assert.equal(jaccardSimilarity(new Set(), b), 0);
  assert.equal(jaccardSimilarity(a, new Set()), 0);
  const disjoint = tokenize('zzz qqq');
  assert.equal(jaccardSimilarity(a, disjoint), 0);
});

// ─── ExperienceStore 两级存储覆盖 ───────────────────────────────────────────

test('project-level instinct overrides user-level by id', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 用户级先写
    await store.upsertInstinct(makeInstinct({
      id: 'shared-rule',
      source: 'manual',      // manual 才会写用户级
      action: 'user version'
    }));
    // 项目级同 id 覆盖
    await store.upsertInstinct(makeInstinct({
      id: 'shared-rule',
      source: 'statistical',
      action: 'project version'
    }));
    const loaded = store.loadInstincts(true);
    const found = loaded.find(i => i.id === 'shared-rule');
    assert.ok(found, 'rule should exist');
    assert.equal(found.action, 'project version');
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('upsertInstinct then loadInstincts round-trips all fields', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const original = makeInstinct({
      id: 'grep-then-read',
      trigger: 'after Grep finds matches',
      action: 'Read the matched files to confirm',
      confidence: 0.78,
      domain: 'workflow',
      source: 'statistical',
      occurrenceCount: 5
    });
    await store.upsertInstinct(original);
    const loaded = store.loadInstincts(true);
    const found = loaded.find(i => i.id === 'grep-then-read');
    assert.ok(found);
    assert.equal(found.trigger, original.trigger);
    assert.equal(found.action, original.action);
    assert.equal(found.confidence, original.confidence);
    assert.equal(found.domain, 'workflow');
    assert.equal(found.source, 'statistical');
    assert.equal(found.occurrenceCount, 5);
    assert.equal(found.deprecated, false);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('loadInstincts filters deprecated by default', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct(makeInstinct({
      id: 'active-rule',
      deprecated: false
    }));
    await store.upsertInstinct(makeInstinct({
      id: 'dead-rule',
      deprecated: true
    }));
    const defaults = store.loadInstincts();
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, 'active-rule');
    const all = store.loadInstincts(true);
    assert.equal(all.length, 2);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── 置信度演化 ─────────────────────────────────────────────────────────────

test('evolveInstincts reinforces existing rules and caps at 0.9', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 既有规则，confidence 0.8
    await store.upsertInstinct(makeInstinct({
      id: 'existing',
      confidence: 0.8,
      occurrenceCount: 3
    }));
    // 检测到同 id（应强化）
    const detected = [makeInstinct({ id: 'existing', confidence: 0.5 })];
    const { updated, reinforced } = await store.evolveInstincts(detected);
    assert.ok(reinforced.has('existing'));
    const found = updated.find(i => i.id === 'existing');
    assert.ok(found);
    assert.equal(found.confidence, 0.85); // 0.8 + 0.05
    assert.equal(found.occurrenceCount, 4); // 3 + 1
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('evolveInstincts reinforces up to confidence ceiling 0.9', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct(makeInstinct({
      id: 'near-max',
      confidence: 0.88,
      occurrenceCount: 10
    }));
    await store.evolveInstincts([makeInstinct({ id: 'near-max' })]);
    const loaded = store.loadInstincts(true).find(i => i.id === 'near-max');
    assert.ok(loaded);
    assert.equal(loaded.confidence, 0.9); // capped
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('evolveInstincts creates new instinct with initial confidence 0.5', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const detected = [makeInstinct({
      id: 'brand-new',
      confidence: 0.99  // 应被忽略，新规则用初始值
    })];
    const { updated } = await store.evolveInstincts(detected);
    const found = updated.find(i => i.id === 'brand-new');
    assert.ok(found, 'new instinct should be created');
    assert.equal(found.confidence, 0.5);
    assert.equal(found.occurrenceCount, 1);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('evolveInstincts decays stale rules over 90 days', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    await store.upsertInstinct(makeInstinct({
      id: 'stale',
      confidence: 0.7,
      observedAt: staleDate,
      occurrenceCount: 4
    }));
    // 不触发该规则，检测一个无关的新规则
    await store.evolveInstincts([makeInstinct({ id: 'other-rule' })]);
    const stale = store.loadInstincts(true).find(i => i.id === 'stale');
    assert.ok(stale);
    assert.equal(stale.confidence, 0.65); // 0.7 - 0.05
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── Memory lifecycle ───────────────────────────────────────────────────────

test('stageMemory then confirmMemory promotes staging to active', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const candidate = makeMemory({
      id: 'cand-1',
      status: 'staging',
      type: 'feedback',
      content: 'Run tests before commit'
    });
    await store.stageMemory(candidate);
    // staging 区可见（loadMemories('all')）
    const allAfterStage = store.loadMemories('all');
    assert.equal(allAfterStage.length, 1);
    assert.equal(allAfterStage[0].status, 'staging');

    const ok = await store.confirmMemory('cand-1');
    assert.equal(ok, true);
    const active = store.loadMemories('active');
    assert.equal(active.length, 1);
    assert.equal(active[0].status, 'active');
    assert.equal(active[0].content, 'Run tests before commit');
    // staging 区应清空
    const allAfterConfirm = store.loadMemories('all');
    assert.equal(allAfterConfirm.length, 1);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('confirmMemory returns false for unknown id', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const ok = await store.confirmMemory('does-not-exist');
    assert.equal(ok, false);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('forgetMemory removes from both levels', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertMemory(makeMemory({ id: 'm1' }));
    assert.equal(store.loadMemories('active').length, 1);
    const ok = await store.forgetMemory('m1');
    assert.equal(ok, true);
    assert.equal(store.loadMemories('active').length, 0);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── 召回 ───────────────────────────────────────────────────────────────────

test('recallInstincts returns ranked by relevance then confidence', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct(makeInstinct({
      id: 'read-before-edit',
      trigger: 'edit file',
      action: 'read first',
      confidence: 0.9,
      domain: 'workflow'
    }));
    await store.upsertInstinct(makeInstinct({
      id: 'grep-first',
      trigger: 'grep search',
      action: 'use grep',
      confidence: 0.75,
      domain: 'workflow'
    }));
    const hits = store.recallInstincts('edit file read', 5, 0.7);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'read-before-edit'); // 更高相似度+置信度
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('recallInstincts respects minConfidence filter', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct(makeInstinct({
      id: 'low-conf',
      trigger: 'edit file',
      confidence: 0.6
    }));
    const hits = store.recallInstincts('edit file', 5, 0.7);
    assert.equal(hits.length, 0);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('recallMemories matches by keywords and content', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertMemory(makeMemory({
      id: 'test-framework',
      name: 'uses vitest',
      content: 'project uses vitest for unit tests',
      keywords: ['vitest', 'test', 'unit']
    }));
    const hits = store.recallMemories('how to run unit test', 5);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'test-framework');
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── 观测流 ──────────────────────────────────────────────────────────────────

test('appendObservation then flushObservations writes JSONL', async () => {
  const { store, tmp, projectDir } = createStoreWithTmp();
  try {
    store.appendObservation({
      ts: new Date().toISOString(),
      sessionId: 's1',
      toolName: 'Edit',
      args: { file_path: '/a.ts' },
      output: '已更新',
      failed: false
    });
    store.appendObservation({
      ts: new Date().toISOString(),
      sessionId: 's1',
      toolName: 'Bash',
      args: { command: 'pnpm test' },
      output: '执行出错: ENOENT',
      failed: true
    });
    await store.flushObservations();
    const obsFile = path.join(projectDir, 'observations.jsonl');
    const content = await fsp.readFile(obsFile, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    const second = JSON.parse(lines[1]);
    assert.equal(second.toolName, 'Bash');
    assert.equal(second.failed, true);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('loadRecentObservations reads back flushed samples', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const ts = new Date().toISOString();
    store.appendObservation({
      ts, sessionId: 's1', toolName: 'Read',
      args: { path: '/x' }, output: 'content', failed: false
    });
    await store.flushObservations();
    const loaded = await store.loadRecentObservations(7);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].toolName, 'Read');
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('observation args are truncated when exceeding limit', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const huge = 'x'.repeat(5000);
    store.appendObservation({
      ts: new Date().toISOString(),
      sessionId: 's1',
      toolName: 'Bash',
      args: { command: huge },
      output: 'ok',
      failed: false
    });
    await store.flushObservations();
    const loaded = await store.loadRecentObservations(7);
    assert.equal(loaded.length, 1);
    // 截断后 args 应为 { _truncated: true, preview: ... }
    assert.equal(loaded[0].args._truncated, true);
    assert.ok(typeof loaded[0].args.preview === 'string');
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});
