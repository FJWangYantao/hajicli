import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ExperienceStore } from '@hajicli/core';
import { handleMemoryCommand, handleInstinctCommand } from '../dist/experience-commands.js';

function createStoreWithTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-cmd-'));
  const cwd = path.join(tmp, 'project');
  const userDir = path.join(tmp, 'user', '.haji');
  const projectDir = path.join(cwd, '.haji');
  fs.mkdirSync(cwd, { recursive: true });
  const store = new ExperienceStore({ cwd, userDir, projectDir });
  return { store, tmp };
}

const noColor = { purple: s => s, gray: s => s, green: s => s, red: s => s, yellow: s => s, bold: s => s };

function makeCtx(store, outputs) {
  return {
    store,
    provider: () => null,
    model: () => 'mock',
    pendingObservations: () => [],
    writeLine: line => outputs.push(line),
    writeChat: content => outputs.push(content)
  };
}

// ─── /memory ──────────────────────────────────────────────────────────────────

test('/memory shows empty hint when no memories', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand([], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('暂无记忆')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory add creates active memory then list shows it', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    const ctx = makeCtx(store, outputs);
    await handleMemoryCommand(['add', 'project', 'uses', 'pnpm', 'workspace'], ctx, noColor);
    assert.ok(outputs.some(l => l.includes('已添加')));
    outputs.length = 0;
    await handleMemoryCommand([], ctx, noColor);
    assert.ok(outputs.some(l => l.includes('active 1')));
    assert.ok(outputs.some(l => l.includes('pnpm')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory add rejects invalid type', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(['add', 'invalid-type', 'content'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('类型必须是')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory add requires content', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(['add', 'project'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('用法')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory confirm promotes staging to active', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 先放一条 staging
    await store.stageMemory({
      id: 'cand-1', name: 'test', type: 'feedback',
      content: 'wait for confirm', status: 'staging', confidence: 0.7,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      keywords: ['confirm']
    });
    const outputs = [];
    await handleMemoryCommand(['confirm', 'cand-1'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('已确认')));
    assert.equal(store.loadMemories('active').length, 1);
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory confirm reports unknown id', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(['confirm', 'nope'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('未找到')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory forget removes memory', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertMemory({
      id: 'm1', name: 'n', type: 'project', content: 'c', status: 'active',
      confidence: 0.8, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      keywords: ['c']
    });
    const outputs = [];
    await handleMemoryCommand(['forget', 'm1'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('已删除')));
    assert.equal(store.loadMemories('active').length, 0);
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

// ─── /instinct ────────────────────────────────────────────────────────────────

test('/instinct shows empty hint when no rules', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleInstinctCommand([], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('暂无规则')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/instinct lists rules sorted by confidence', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: 'high', trigger: 't', action: 'high action',
      confidence: 0.9, domain: 'workflow', source: 'statistical',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 5
    });
    await store.upsertInstinct({
      id: 'low', trigger: 't', action: 'low action',
      confidence: 0.6, domain: 'testing', source: 'llm',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 2
    });
    const outputs = [];
    await handleInstinctCommand([], makeCtx(store, outputs), noColor);
    const joined = outputs.join('\n');
    assert.ok(joined.includes('high'));
    assert.ok(joined.includes('low'));
    // high 应排在 low 前（按 confidence 降序）
    assert.ok(joined.indexOf('high') < joined.indexOf('low'));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/instinct stats shows domain breakdown', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: 'r1', trigger: 't', action: 'a',
      confidence: 0.8, domain: 'workflow', source: 'statistical',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 3
    });
    await store.upsertInstinct({
      id: 'r2', trigger: 't', action: 'a',
      confidence: 0.7, domain: 'workflow', source: 'llm',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 2
    });
    await store.upsertInstinct({
      id: 'r3', trigger: 't', action: 'a',
      confidence: 0.75, domain: 'testing', source: 'statistical',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 1
    });
    const outputs = [];
    await handleInstinctCommand(['stats'], makeCtx(store, outputs), noColor);
    const joined = outputs.join('\n');
    assert.ok(joined.includes('active ·'));
    assert.ok(joined.includes('workflow'));
    assert.ok(joined.includes('testing'));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/instinct forget removes rule', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: 'to-remove', trigger: 't', action: 'a',
      confidence: 0.8, domain: 'workflow', source: 'manual',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 1
    });
    const outputs = [];
    await handleInstinctCommand(['forget', 'to-remove'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('已删除')));
    assert.equal(store.loadInstincts(true).length, 0);
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/instinct distill reports when no observations', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleInstinctCommand(['distill'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('暂无待提炼')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

// ─── promote 子命令 ──────────────────────────────────────────────────────────

test('/memory promote moves memory to user level', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertMemory({
      id: 'm1', name: 'n', type: 'project', content: 'c', status: 'active',
      confidence: 0.8, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      keywords: ['c']
    });
    const outputs = [];
    await handleMemoryCommand(['promote', 'm1'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('已提升到用户级')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory promote reports already-user-level', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 先 promote 一次（项目级 -> 用户级）
    await store.upsertMemory({
      id: 'm2', name: 'n', type: 'project', content: 'c', status: 'active',
      confidence: 0.8, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      keywords: ['c']
    });
    await store.promoteMemory('m2');
    // 再 promote 应报告 already-user-level
    const outputs = [];
    await handleMemoryCommand(['promote', 'm2'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('已在用户级')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory promote requires id', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(['promote'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('用法')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/instinct promote moves rule to user level', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: 'to-promote', trigger: 't', action: 'a',
      confidence: 0.8, domain: 'workflow', source: 'statistical',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 3
    });
    const outputs = [];
    await handleInstinctCommand(['promote', 'to-promote'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('已提升到用户级')));
    // 确认 source 改为 manual
    const loaded = store.loadInstincts(true);
    const found = loaded.find(i => i.id === 'to-promote');
    assert.ok(found);
    assert.equal(found.source, 'manual');
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/instinct promote reports not-found', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleInstinctCommand(['promote', 'nope'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('未找到项目级')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

// ─── 作用域展示 ──────────────────────────────────────────────────────────────

test('/memory list shows scope tags for user and project entries', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const base = { name: 'n', content: 'content', status: 'active', confidence: 0.8, keywords: [] };
    const now = new Date().toISOString();
    await store.upsertMemory({ ...base, id: 'user-pref', type: 'user', createdAt: now, updatedAt: now });
    await store.upsertMemory({ ...base, id: 'proj-fact', type: 'project', createdAt: now, updatedAt: now });
    const outputs = [];
    await handleMemoryCommand([], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('[用户级]')));
    assert.ok(outputs.some(l => l.includes('[项目级]')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/memory add user reports user-level placement', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(['add', 'user', 'prefer kebab-case'], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('用户级')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});

test('/instinct list shows scope tags', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: 'user-rule', trigger: 't', action: 'a',
      confidence: 0.8, domain: 'workflow', source: 'manual',
      deprecated: false, observedAt: new Date().toISOString(), occurrenceCount: 1
    });
    const outputs = [];
    await handleInstinctCommand([], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some(l => l.includes('[用户级]')));
  } finally { fsp.rm(tmp, { recursive: true, force: true }); }
});
