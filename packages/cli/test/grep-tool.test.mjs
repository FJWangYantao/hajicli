import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GrepSearchTool } from '../../plugins/dist/index.js';
import { runRipgrepLines } from '../../plugins/dist/ripgrep.js';

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haji-grep-'));
  const previousCwd = process.cwd();
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'a.ts'), [
    'alpha',
    'class FooTool {}',
    'needle first',
    'omega',
    'needle second',
    '--flag-value'
  ].join('\n'));
  await fs.writeFile(path.join(workspace, 'src', 'b.ts'), 'needle third\nclass BarTool {}\n');
  await fs.writeFile(path.join(workspace, 'src', 'a.test.ts'), 'needle test\nclass TestTool {}\n');
  await fs.writeFile(path.join(workspace, 'docs', 'note.md'), 'needle docs\nclass DocsTool {}\n');
  await fs.writeFile(path.join(workspace, '.hidden.ts'), 'hidden-needle\n');
  process.chdir(workspace);
  try {
    await run(workspace);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('grep keeps literal mode compatible and supports regex mode', async () => {
  await withWorkspace(async () => {
    const tool = new GrepSearchTool();
    const literal = await tool.execute({ query: 'class .*Tool', path: 'src' });
    assert.match(literal, /未找到匹配结果/);

    const regex = await tool.execute({
      query: 'class\\s+\\w+Tool',
      path: 'src',
      mode: 'regex',
      exclude: ['**/*.test.ts']
    });
    assert.match(regex, /src\/a\.ts:2:/);
    assert.match(regex, /src\/b\.ts:2:/);
    assert.doesNotMatch(regex, /a\.test\.ts/);

    const invalid = await tool.execute({ query: '[', mode: 'regex' });
    assert.match(invalid, /^错误: 正则表达式无效/);

    const leadingDash = await tool.execute({ query: '--flag-value', path: 'src' });
    assert.match(leadingDash, /src\/a\.ts:6:/);

    const hidden = await tool.execute({ query: 'hidden-needle', fileTypes: ['typescript'] });
    assert.match(hidden, /\.hidden\.ts:1:/);
  });
});

test('grep combines include, exclude and file type filters with context lines', async () => {
  await withWorkspace(async () => {
    const result = await new GrepSearchTool().execute({
      query: 'needle',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      fileTypes: ['typescript'],
      beforeContext: 1,
      afterContext: 1,
      limit: 10
    });

    assert.match(result, /src\/a\.ts:3:/);
    assert.match(result, /> 3 \| needle first/);
    assert.match(result, /  2 \| class FooTool \{\}/);
    assert.match(result, /src\/b\.ts:1:/);
    assert.doesNotMatch(result, /a\.test\.ts/);
    assert.doesNotMatch(result, /note\.md/);
  });
});

test('grep pagination is deterministic and returns nextOffset without duplicates', async () => {
  await withWorkspace(async () => {
    const tool = new GrepSearchTool();
    const base = {
      query: 'needle',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      limit: 1
    };
    const first = await tool.execute(base);
    assert.match(first, /src\/a\.ts:3:/);
    assert.match(first, /nextOffset=1/);

    const second = await tool.execute({ ...base, offset: 1 });
    assert.match(second, /src\/a\.ts:5:/);
    assert.doesNotMatch(second, /src\/a\.ts:3:/);
    assert.match(second, /nextOffset=2/);

    const third = await tool.execute({ ...base, offset: 2 });
    assert.match(third, /src\/b\.ts:1:/);
    assert.match(third, /hasMore=false/);
  });
});

test('grep Node fallback preserves regex, glob and paging behavior', async () => {
  await withWorkspace(async workspace => {
    const previousPath = process.env.PATH;
    process.env.PATH = workspace;
    try {
      const result = await new GrepSearchTool().execute({
        query: 'NEEDLE\\s+\\w+',
        mode: 'regex',
        caseSensitive: false,
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts'],
        fileTypes: ['typescript'],
        offset: 1,
        limit: 1
      });
      assert.match(result, /引擎=node/);
      assert.match(result, /src\/a\.ts:5:/);
      assert.match(result, /nextOffset=2/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test('grep respects the output budget and continues from the actual returned offset', async () => {
  await withWorkspace(async workspace => {
    const lines = Array.from({ length: 60 }, (_, index) => `budget-hit-${index}-${'x'.repeat(500)}`);
    await fs.writeFile(path.join(workspace, 'src', 'large.ts'), lines.join('\n'));
    const result = await new GrepSearchTool().execute({
      query: 'budget-hit-',
      path: 'src',
      limit: 50
    });
    assert.ok(result.length <= 8_000, `输出长度不应超过限制，实际为 ${result.length}`);
    assert.match(result, /hasMore=true/);
    assert.match(result, /nextOffset=\d+/);
  });
});

test('streaming ripgrep helper stops at the requested line limit', async () => {
  const result = await runRipgrepLines(
    ['-e', "for (let index = 0; index < 100; index += 1) console.log('line-' + index)"],
    process.cwd(),
    3,
    undefined,
    process.execPath
  );
  assert.ok(result);
  assert.equal(result.lines.length, 3);
  assert.equal(result.truncated, true);
});

test('streaming ripgrep helper terminates when aborted', async () => {
  const controller = new AbortController();
  const pending = runRipgrepLines(
    ['-e', 'setTimeout(() => {}, 10000)'],
    process.cwd(),
    3,
    controller.signal,
    process.execPath
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
});
