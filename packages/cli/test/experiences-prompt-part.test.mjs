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
