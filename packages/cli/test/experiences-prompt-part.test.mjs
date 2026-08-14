import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ExperienceStore, ExperiencesPromptPart } from '@hajicli/core';

function createStoreWithTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-part-'));
  const cwd = path.join(tmp, 'project');
  const userDir = path.join(tmp, 'user', '.haji');
  const projectDir = path.join(cwd, '.haji');
  fs.mkdirSync(cwd, { recursive: true });
  const store = new ExperienceStore({ cwd, userDir, projectDir });
  return { store, tmp, cwd };
}

test('ExperiencesPromptPart returns empty string when store is empty', () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const part = new ExperiencesPromptPart(store);
    const content = part.getContent({ cwd: '/proj', os: 'linux' });
    assert.equal(content, '');
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('ExperiencesPromptPart injects instincts above confidence threshold', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: 'read-before-edit',
      trigger: 'edit file',
      action: 'Read file content before editing',
      confidence: 0.85,
      domain: 'workflow',
      source: 'statistical',
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 3
    });
    const part = new ExperiencesPromptPart(store);
    const content = part.getContent({ cwd: '/myproj', os: 'linux' });
    assert.ok(content.includes('经验记忆'));
    assert.ok(content.includes('read-before-edit') || content.includes('Read file content'));
    assert.ok(content.includes('workflow'));
    assert.ok(content.includes('0.85'));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('ExperiencesPromptPart injects memories from active store', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertMemory({
      id: 'use-vitest',
      name: 'test framework',
      type: 'project',
      content: 'Project uses vitest for testing',
      status: 'active',
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ['vitest', 'test', 'testing']
    });
    const part = new ExperiencesPromptPart(store);
    const content = part.getContent({ cwd: '/myproj', os: 'linux' });
    assert.ok(content.includes('vitest') || content.includes('testing'));
    assert.ok(content.includes('project'));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('ExperiencesPromptPart does not inject staging memories', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.stageMemory({
      id: 'candidate',
      name: 'unconfirmed',
      type: 'feedback',
      content: 'Should not appear in prompt',
      status: 'staging',
      confidence: 0.9,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ['should', 'not', 'appear']
    });
    const part = new ExperiencesPromptPart(store);
    const content = part.getContent({ cwd: '/proj', os: 'linux' });
    assert.equal(content, ''); // staging 不进 active 召回
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('ExperiencesPromptPart respects maxChars budget', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 注入多条规则，但设置极小的 maxChars
    for (let i = 0; i < 10; i++) {
      await store.upsertInstinct({
        id: `rule-${i}`,
        trigger: 'edit file',
        action: `Rule number ${i} with a fairly long description to fill budget`,
        confidence: 0.9,
        domain: 'workflow',
        source: 'statistical',
        deprecated: false,
        observedAt: new Date().toISOString(),
        occurrenceCount: 5
      });
    }
    const part = new ExperiencesPromptPart(store, { maxChars: 300 });
    const content = part.getContent({ cwd: '/proj', os: 'linux' });
    assert.ok(content.length <= 310); // 允许省略号余量
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('ExperiencesPromptPart has correct id and priority', () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const part = new ExperiencesPromptPart(store);
    assert.equal(part.id, 'experiences');
    assert.equal(part.priority, 46); // 介于 skills-catalog(45) 与 plan-mode(50)
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('ExperiencesPromptPart marks user-level entries as global', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: 'global-pref',
      trigger: 'edit file',
      action: 'Always read before editing',
      confidence: 0.85,
      domain: 'workflow',
      source: 'manual',
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 3
    });
    await store.upsertMemory({
      id: 'global-mem',
      name: 'global preference',
      type: 'user',
      content: 'Prefer kebab-case file names',
      status: 'active',
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // keywords 需与召回 query（项目名 + workflow/edit/read/...）有交集，否则 memory 不进 prompt
      keywords: ['workflow', 'kebab', 'case']
    });
    const part = new ExperiencesPromptPart(store);
    const content = part.getContent({ cwd: '/proj', os: 'linux' });
    // 分别验证 instinct 与 memory 两个 formatter 的全局标注
    assert.ok(content.includes('[workflow 0.85 · 全局]'));
    assert.ok(content.includes('[user · 全局]'));
    assert.ok(content.includes('Prefer kebab-case file names'));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('ExperiencesPromptPart does not mark project-level entries as global', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: 'proj-pref',
      trigger: 'edit file',
      action: 'Read before editing',
      confidence: 0.85,
      domain: 'workflow',
      source: 'llm',
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 3
    });
    await store.upsertMemory({
      id: 'proj-mem',
      name: 'project preference',
      type: 'project',
      content: 'Prefer kebab-case file names',
      status: 'active',
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ['workflow', 'kebab', 'case']
    });
    const part = new ExperiencesPromptPart(store);
    const content = part.getContent({ cwd: '/proj', os: 'linux' });
    // 两条都应被召回（与 query 有交集），但都不带全局标注
    assert.ok(content.includes('Read before editing'));
    assert.ok(content.includes('Prefer kebab-case file names'));
    assert.ok(!content.includes('全局'));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('ExperiencesPromptPart recalls by recent user message, not fixed vocabulary', async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 条目关键词与固定词表（workflow/edit/read/test/git/error/prevention）无交集
    await store.upsertInstinct({
      id: 'login-retry-rule',
      trigger: 'login retry',
      action: 'Prompt the user to retry login',
      confidence: 0.85,
      domain: 'other',
      source: 'llm',
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 3
    });
    await store.upsertMemory({
      id: 'auth-mem',
      name: 'auth session policy',
      type: 'project',
      content: 'Auth session expires after login retry',
      status: 'active',
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ['login', 'auth', 'retry']
    });
    const part = new ExperiencesPromptPart(store);

    // 固定词表召回不到：无当前消息时这些条目进不了 prompt（旧策略的盲区）
    const withoutMessage = part.getContent({ cwd: '/proj', os: 'linux' });
    assert.ok(!withoutMessage.includes('login'));

    // 传当前任务消息后按任务语义召回
    const withMessage = part.getContent({ cwd: '/proj', os: 'linux', recentUserMessage: 'fix the login retry bug' });
    assert.ok(withMessage.includes('Prompt the user to retry login'));
    assert.ok(withMessage.includes('Auth session expires'));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});
