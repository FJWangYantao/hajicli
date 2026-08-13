import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BashTool,
  EditFileTool,
  GlobalFindFilesTool,
  ReadFileTool,
  WriteFileTool
} from '../../plugins/dist/index.js';

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haji-tools-'));
  const previousCwd = process.cwd();
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'a.ts'), 'alpha\nneedle\nomega\n');
  await fs.writeFile(path.join(workspace, 'src', 'b.ts'), 'beta\nneedle\n');
  await fs.writeFile(path.join(workspace, 'src', 'a.test.ts'), 'test needle\n');
  await fs.writeFile(path.join(workspace, 'docs', 'note.md'), 'docs needle\n');
  process.chdir(workspace);
  try {
    await run(workspace);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('global supports filters and deterministic pagination', async () => {
  await withWorkspace(async () => {
    const tool = new GlobalFindFilesTool();
    const base = {
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      fileTypes: ['typescript'],
      limit: 1
    };
    const first = await tool.execute(base);
    assert.match(first, /src\/a\.ts/);
    assert.match(first, /nextOffset=1/);
    assert.doesNotMatch(first, /a\.test\.ts/);

    const second = await tool.execute({ ...base, offset: 1 });
    assert.match(second, /src\/b\.ts/);
    assert.match(second, /hasMore=false/);

    const regex = await tool.execute({ pattern: '^docs/.+\\.md$', mode: 'regex' });
    assert.match(regex, /docs\/note\.md/);
    assert.doesNotMatch(regex, /src\/a\.ts/);
  });
});

test('global Node fallback preserves filters and pagination', async () => {
  await withWorkspace(async workspace => {
    const previousPath = process.env.PATH;
    process.env.PATH = workspace;
    try {
      const result = await new GlobalFindFilesTool().execute({
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts'],
        fileTypes: ['typescript'],
        offset: 1,
        limit: 1
      });
      assert.match(result, /引擎=node/);
      assert.match(result, /src\/b\.ts/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test('read returns complete numbered lines with continuation metadata', async () => {
  await withWorkspace(async workspace => {
    const lines = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`);
    await fs.writeFile(path.join(workspace, 'large.txt'), lines.join('\n'));
    const tool = new ReadFileTool();
    const first = await tool.execute({ path: 'large.txt' });
    assert.match(first, /总行数=250；返回=1-200/);
    assert.match(first, /nextStartLine=201/);
    assert.match(first, /1 \| line-1/);
    assert.doesNotMatch(first, /201 \| line-201/);

    const second = await tool.execute({ path: 'large.txt', startLine: 201, limit: 50 });
    assert.match(second, /返回=201-250/);
    assert.match(second, /hasMore=false/);

    const around = await tool.execute({ path: 'large.txt', aroundLine: 120, contextLines: 2 });
    assert.match(around, /返回=118-122/);
    assert.match(around, /120 \| line-120/);
  });
});

test('read supports bounded batch requests and binary detection', async () => {
  await withWorkspace(async workspace => {
    await fs.writeFile(path.join(workspace, 'binary.bin'), Buffer.from([1, 0, 2, 3]));
    const tool = new ReadFileTool();
    const batch = await tool.execute({
      paths: [
        { path: 'src/a.ts', startLine: 2, limit: 1 },
        { path: 'docs/note.md', lineNumbers: false }
      ]
    });
    assert.match(batch, /批量文件读取结果 - 共 2 个请求/);
    assert.match(batch, /2 \| needle/);
    assert.match(batch, /docs needle/);
    assert.ok(batch.length <= 8_000);

    const binary = await tool.execute({ path: 'binary.bin' });
    assert.match(binary, /类型=二进制/);
    assert.doesNotMatch(binary, /\u0000/);
  });
});

test('edit and write reject stale hashes and replace files atomically', async () => {
  await withWorkspace(async workspace => {
    const target = path.join(workspace, 'target.txt');
    await fs.writeFile(target, 'before\n');
    const reader = new ReadFileTool();
    const editor = new EditFileTool();
    const writer = new WriteFileTool();
    const initialRead = await reader.execute({ path: 'target.txt' });
    const initialHash = initialRead.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(initialHash);

    await fs.writeFile(target, 'external\n');
    const staleEdit = await editor.execute({
      path: 'target.txt',
      oldText: 'external',
      newText: 'edited',
      expectedHash: initialHash
    });
    assert.match(staleEdit, /文件已被修改/);
    assert.equal(await fs.readFile(target, 'utf8'), 'external\n');

    const currentRead = await reader.execute({ path: 'target.txt' });
    const currentHash = currentRead.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(currentHash);
    const edited = await editor.execute({
      path: 'target.txt',
      oldText: 'external',
      newText: 'edited',
      expectedHash: currentHash
    });
    assert.match(edited, /文件精准编辑成功/);
    assert.equal(await fs.readFile(target, 'utf8'), 'edited\n');

    const staleWrite = await writer.execute({ path: 'target.txt', content: 'wrong\n', expectedHash: currentHash });
    assert.match(staleWrite, /文件已变化/);
    assert.equal(await fs.readFile(target, 'utf8'), 'edited\n');

    const editedHash = edited.match(/newHash=([a-f0-9]{16})/)?.[1];
    const written = await writer.execute({ path: 'target.txt', content: 'final\n', expectedHash: editedHash });
    assert.match(written, /文件写入成功/);
    assert.equal(await fs.readFile(target, 'utf8'), 'final\n');
    const tempFiles = (await fs.readdir(workspace)).filter(name => name.includes('.haji-') && name.endsWith('.tmp'));
    assert.deepEqual(tempFiles, []);
  });
});

test('bash keeps both output head and tail with duration metadata', async () => {
  await withWorkspace(async workspace => {
    const script = path.join(workspace, 'long-output.cjs');
    await fs.writeFile(script, "process.stdout.write('HEAD-' + 'x'.repeat(9000) + '-TAIL')\n");
    const result = await new BashTool().execute({ command: `"${process.execPath}" "${script}"` });
    assert.match(result, /HEAD-/);
    assert.match(result, /-TAIL/);
    assert.match(result, /中间省略/);
    assert.match(result, /耗时 \d+ms/);
    assert.ok(result.length <= 8_000);
  });
});

test('bash timeout terminates the command through the existing abort path', { timeout: 8_000 }, async () => {
  await withWorkspace(async workspace => {
    const script = path.join(workspace, 'wait.cjs');
    await fs.writeFile(script, 'setTimeout(() => {}, 10000)\n');
    const startedAt = Date.now();
    const result = await new BashTool().execute({
      command: `"${process.execPath}" "${script}"`,
      timeoutMs: 1_000
    });
    assert.match(result, /^\[命令执行超时 - 1000ms\]/);
    assert.ok(Date.now() - startedAt < 5_000);
  });
});
