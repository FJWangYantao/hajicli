import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PermissionEngine } from '@hajicli/core';
import { ProjectInfoTool } from '../../plugins/dist/index.js';

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haji-project-info-'));
  const previousCwd = process.cwd();
  await fs.mkdir(path.join(workspace, 'packages', 'app', 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'fixture-root',
    private: true,
    workspaces: ['packages/*'],
    scripts: { build: 'tsc -b', test: 'node --test' }
  }, null, 2));
  await fs.writeFile(path.join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  await fs.writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fs.writeFile(path.join(workspace, 'tsconfig.json'), '{"compilerOptions":{}}\n');
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Rules\n');
  await fs.writeFile(path.join(workspace, 'packages', 'app', 'package.json'), JSON.stringify({
    name: '@fixture/app',
    scripts: { dev: 'vite' }
  }, null, 2));
  await fs.writeFile(path.join(workspace, 'packages', 'app', 'src', 'index.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(workspace, 'packages', 'app', 'src', 'helper.ts'), 'export const helper = 2;\n');
  await fs.writeFile(path.join(workspace, 'docs', 'readme.md'), '# Fixture\n');
  process.chdir(workspace);
  try {
    await run(workspace);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('projectinfo summarizes language, packages, scripts, configs and entrypoints', async () => {
  await withWorkspace(async () => {
    const result = await new ProjectInfoTool().execute({ includeGit: false, depth: 'detailed' });
    assert.match(result, /^\[项目结构摘要\]/);
    assert.match(result, /TypeScript:2/);
    assert.match(result, /包管理=pnpm/);
    assert.match(result, /包 \.: fixture-root；scripts=build, test；workspaces=packages\/\*/);
    assert.match(result, /包 packages\/app: @fixture\/app；scripts=dev/);
    assert.match(result, /入口候选=packages\/app\/src\/index\.ts/);
    assert.match(result, /AGENTS\.md/);
    assert.ok(result.length <= 8_000);
  });
});

test('projectinfo cache hits on unchanged manifests and invalidates after package changes', async () => {
  await withWorkspace(async workspace => {
    const tool = new ProjectInfoTool();
    const first = await tool.execute({ includeGit: false });
    assert.match(first, /缓存=miss/);
    const second = await tool.execute({ includeGit: false });
    assert.match(second, /缓存=hit/);

    const packagePath = path.join(workspace, 'package.json');
    const parsed = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    parsed.scripts.lint = 'eslint .';
    await fs.writeFile(packagePath, JSON.stringify(parsed, null, 2));
    const third = await tool.execute({ includeGit: false });
    assert.match(third, /缓存=miss/);
    assert.match(third, /scripts=build, lint, test/);

    const refreshed = await tool.execute({ includeGit: false, refresh: true });
    assert.match(refreshed, /缓存=miss/);
  });
});

test('projectinfo includes read-only Git branch and dirty status', async () => {
  await withWorkspace(async workspace => {
    const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
    git('init');
    git('config', 'user.name', 'Haji Test');
    git('config', 'user.email', 'haji@example.test');
    git('add', '.');
    git('commit', '-m', 'initial');
    await fs.writeFile(path.join(workspace, 'dirty.txt'), 'changed\n');

    const result = await new ProjectInfoTool().execute({ includeGit: true, depth: 'detailed' });
    assert.match(result, /Git分支=/);
    assert.match(result, /变更数=1/);
    assert.match(result, /Git变更样本=\?\? dirty\.txt/);
  });
});

test('projectinfo is read-only and available in Plan mode', async () => {
  const engine = new PermissionEngine();
  assert.equal(engine.isReadOnlyTool('projectinfo'), true);
  assert.deepEqual(await engine.evaluate({
    mode: 'plan',
    toolName: 'projectinfo',
    args: {},
    userIntent: '分析项目'
  }), { action: 'allow', riskLevel: 'safe' });
});

test('projectinfo validates arguments and honors pre-aborted contexts', async () => {
  const tool = new ProjectInfoTool();
  assert.match(await tool.execute({ depth: 'full' }), /^错误: depth/);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await tool.execute({}, { abortSignal: controller.signal }), '[项目摘要已中止]');
});

test('projectinfo cache is bounded and evicts the oldest project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haji-project-cache-'));
  const previousCwd = process.cwd();
  try {
    const dirs = [];
    for (let index = 0; index < 10; index += 1) {
      const dir = path.join(root, `p${index}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `p${index}` }));
      dirs.push(dir);
    }
    const tool = new ProjectInfoTool();
    for (const dir of dirs) {
      process.chdir(dir);
      await tool.execute({ includeGit: false });
    }
    // 超过 8 个项目的缓存上限，最早写入的 p0 应已被淘汰
    process.chdir(dirs[0]);
    assert.match(await tool.execute({ includeGit: false }), /缓存=miss/);
    // 最近写入的 p9 仍在缓存
    process.chdir(dirs[9]);
    assert.match(await tool.execute({ includeGit: false }), /缓存=hit/);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(root, { recursive: true, force: true });
  }
});
