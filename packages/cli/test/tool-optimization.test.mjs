import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BashTool,
  EditFileTool,
  GlobalFindFilesTool,
  ReadFileTool,
  WriteFileTool,
} from "../../plugins/dist/index.js";

// bash 中止后杀进程在后台进行，被终止的子进程可能短暂占用工作区目录。
async function removeWorkspaceWithRetry(workspace) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await fs.rm(workspace, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error.code !== "EBUSY" && error.code !== "ENOTEMPTY") || Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "haji-tools-"));
  const previousCwd = process.cwd();
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "a.ts"), "alpha\nneedle\nomega\n");
  await fs.writeFile(path.join(workspace, "src", "b.ts"), "beta\nneedle\n");
  await fs.writeFile(path.join(workspace, "src", "a.test.ts"), "test needle\n");
  await fs.writeFile(path.join(workspace, "docs", "note.md"), "docs needle\n");
  process.chdir(workspace);
  try {
    await run(workspace);
  } finally {
    process.chdir(previousCwd);
    await removeWorkspaceWithRetry(workspace);
  }
}

test("global supports filters and deterministic pagination", async () => {
  await withWorkspace(async () => {
    const tool = new GlobalFindFilesTool();
    const base = {
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      fileTypes: ["typescript"],
      limit: 1,
    };
    const first = await tool.execute(base);
    assert.match(first, /src\/a\.ts/);
    assert.match(first, /nextOffset=1/);
    assert.doesNotMatch(first, /a\.test\.ts/);

    const second = await tool.execute({ ...base, offset: 1 });
    assert.match(second, /src\/b\.ts/);
    assert.match(second, /hasMore=false/);

    const regex = await tool.execute({ pattern: "^docs/.+\\.md$", mode: "regex" });
    assert.match(regex, /docs\/note\.md/);
    assert.doesNotMatch(regex, /src\/a\.ts/);
  });
});

test("global Node fallback preserves filters and pagination", async () => {
  await withWorkspace(async (workspace) => {
    const previousPath = process.env.PATH;
    process.env.PATH = workspace;
    try {
      const result = await new GlobalFindFilesTool().execute({
        include: ["src/**/*.ts"],
        exclude: ["**/*.test.ts"],
        fileTypes: ["typescript"],
        offset: 1,
        limit: 1,
      });
      assert.match(result, /引擎=node/);
      assert.match(result, /src\/b\.ts/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("read returns complete numbered lines with continuation metadata", async () => {
  await withWorkspace(async (workspace) => {
    const lines = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`);
    await fs.writeFile(path.join(workspace, "large.txt"), lines.join("\n"));
    const tool = new ReadFileTool();
    const first = await tool.execute({ path: "large.txt" });
    assert.match(first, /总行数=250；返回=1-200/);
    assert.match(first, /nextStartLine=201/);
    assert.match(first, /1 \| line-1/);
    assert.doesNotMatch(first, /201 \| line-201/);

    const second = await tool.execute({ path: "large.txt", startLine: 201, limit: 50 });
    assert.match(second, /返回=201-250/);
    assert.match(second, /hasMore=false/);

    const around = await tool.execute({ path: "large.txt", aroundLine: 120, contextLines: 2 });
    assert.match(around, /返回=118-122/);
    assert.match(around, /120 \| line-120/);
  });
});

test("read supports bounded batch requests and binary detection", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "binary.bin"), Buffer.from([1, 0, 2, 3]));
    const tool = new ReadFileTool();
    const batch = await tool.execute({
      paths: [
        { path: "src/a.ts", startLine: 2, limit: 1 },
        { path: "docs/note.md", lineNumbers: false },
      ],
    });
    assert.match(batch, /批量文件读取结果 - 共 2 个请求/);
    assert.match(batch, /2 \| needle/);
    assert.match(batch, /docs needle/);
    assert.ok(batch.length <= 8_000);

    const binary = await tool.execute({ path: "binary.bin" });
    assert.match(binary, /类型=二进制/);
    assert.doesNotMatch(binary, /\u0000/);
  });
});

test("edit and write reject stale hashes and replace files atomically", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "target.txt");
    await fs.writeFile(target, "before\n");
    const reader = new ReadFileTool();
    const editor = new EditFileTool();
    const writer = new WriteFileTool();
    const initialRead = await reader.execute({ path: "target.txt" });
    const initialHash = initialRead.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(initialHash);

    await fs.writeFile(target, "external\n");
    const staleEdit = await editor.execute({
      path: "target.txt",
      oldText: "before",
      newText: "edited",
      expectedHash: initialHash,
    });
    assert.match(staleEdit, /hash冲突/);
    assert.match(staleEdit, /文件已被外部修改/);
    assert.equal(await fs.readFile(target, "utf8"), "external\n");

    const currentRead = await reader.execute({ path: "target.txt" });
    const currentHash = currentRead.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(currentHash);
    const edited = await editor.execute({
      path: "target.txt",
      oldText: "external",
      newText: "edited",
      expectedHash: currentHash,
    });
    assert.match(edited, /文件精准编辑成功/);
    assert.equal(await fs.readFile(target, "utf8"), "edited\n");

    const staleWrite = await writer.execute({
      path: "target.txt",
      content: "wrong\n",
      expectedHash: currentHash,
    });
    assert.match(staleWrite, /文件已变化/);
    assert.equal(await fs.readFile(target, "utf8"), "edited\n");

    const editedHash = edited.match(/newHash=([a-f0-9]{16})/)?.[1];
    const written = await writer.execute({
      path: "target.txt",
      content: "final\n",
      expectedHash: editedHash,
    });
    assert.match(written, /文件写入成功/);
    assert.equal(await fs.readFile(target, "utf8"), "final\n");
    const tempFiles = (await fs.readdir(workspace)).filter(
      (name) => name.includes(".haji-") && name.endsWith(".tmp"),
    );
    assert.deepEqual(tempFiles, []);
  });
});

test("edit re-reads once and applies when oldText still uniquely matches a stale hash", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "retry.txt");
    await fs.writeFile(target, "keep me\nchange me\n");
    const reader = new ReadFileTool();
    const editor = new EditFileTool();
    const initialRead = await reader.execute({ path: "retry.txt" });
    const staleHash = initialRead.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(staleHash);

    // 外部写入改了别处（模拟 biome --write），oldText 所在区域仍然唯一可定位。
    await fs.writeFile(target, "keep me edited externally\nchange me\n");
    const result = await editor.execute({
      path: "retry.txt",
      oldText: "change me",
      newText: "changed",
      expectedHash: staleHash,
    });
    assert.match(result, /文件精准编辑成功/);
    assert.match(result, /expectedHash 已过期/);
    assert.equal(await fs.readFile(target, "utf8"), "keep me edited externally\nchanged\n");
  });
});

test("edit still refuses a stale hash when oldText becomes ambiguous", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "ambiguous.txt");
    await fs.writeFile(target, "value\n");
    const reader = new ReadFileTool();
    const editor = new EditFileTool();
    const initialRead = await reader.execute({ path: "ambiguous.txt" });
    const staleHash = initialRead.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(staleHash);

    await fs.writeFile(target, "value\nvalue\n");
    const result = await editor.execute({
      path: "ambiguous.txt",
      oldText: "value",
      newText: "changed",
      expectedHash: staleHash,
    });
    assert.match(result, /hash冲突/);
    assert.match(result, /匹配到多处/);
    assert.equal(await fs.readFile(target, "utf8"), "value\nvalue\n");
  });
});

test("edit miss messages start with a stable error category", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "miss.txt");
    await fs.writeFile(target, "alpha\n  beta\n");
    const editor = new EditFileTool();

    const lineNumbers = await editor.execute({
      path: "miss.txt",
      oldText: "1 | alpha\n2 | beta",
      newText: "x",
    });
    assert.match(lineNumbers.split("\n")[0], /找不到指定的 oldText 原文（行号前缀）/);

    const truncated = await editor.execute({
      path: "miss.txt",
      oldText: "alpha…\nbeta",
      newText: "x",
    });
    assert.match(truncated.split("\n")[0], /找不到指定的 oldText 原文（截断省略）/);

    const anchorMissing = await editor.execute({
      path: "miss.txt",
      oldText: "gamma",
      newText: "x",
    });
    assert.match(anchorMissing.split("\n")[0], /找不到指定的 oldText 原文（锚点行不存在）/);

    const whitespace = await editor.execute({
      path: "miss.txt",
      oldText: "alpha\n   beta",
      newText: "x",
    });
    assert.match(whitespace.split("\n")[0], /找不到指定的 oldText 原文（缩进或空白不一致）/);
    assert.equal(await fs.readFile(target, "utf8"), "alpha\n  beta\n");
  });
});

test("edit miss separates a partial line, extra prefixes and inner whitespace", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "partial.ts");
    await fs.writeFile(
      target,
      "function run() {\n  const value = computeDebugValue();\n  return value;\n}\n",
    );
    const editor = new EditFileTool();

    // 最长的一行只写了半行：整行比对落空，但文件里确实有这一行
    const fragment = await editor.execute({
      path: "partial.ts",
      oldText: "  const value = computeDebugValue()\n  return value;",
      newText: "x",
    });
    assert.match(fragment.split("\n")[0], /找不到指定的 oldText 原文（片段不是整行）/);
    assert.match(fragment, /2 \| +const value = computeDebugValue\(\);/);

    // grep / diff 风格的前缀
    const prefixed = await editor.execute({
      path: "partial.ts",
      oldText: "partial.ts:2:   const value = computeDebugValue();",
      newText: "x",
    });
    assert.match(prefixed.split("\n")[0], /找不到指定的 oldText 原文（多出前缀或多余字符）/);

    // 只差行内空白
    const spacing = await editor.execute({
      path: "partial.ts",
      oldText: "  const  value = computeDebugValue();",
      newText: "x",
    });
    assert.match(spacing.split("\n")[0], /找不到指定的 oldText 原文（行内空白不一致）/);

    // 文件里真的没有这一行，仍报锚点行不存在
    const missing = await editor.execute({
      path: "partial.ts",
      oldText: "const gone = 1;",
      newText: "x",
    });
    assert.match(missing.split("\n")[0], /找不到指定的 oldText 原文（锚点行不存在）/);

    assert.equal(
      await fs.readFile(target, "utf8"),
      "function run() {\n  const value = computeDebugValue();\n  return value;\n}\n",
    );
  });
});

test("edit hash stays consistent for non-UTF-8 files read as raw bytes", async () => {
  await withWorkspace(async (workspace) => {
    // 0xE9 后跟换行是非法的 UTF-8 序列，字符串往返会变成 U+FFFD，只有按原始字节 hash 才能与 read 一致
    const target = path.join(workspace, "latin.txt");
    await fs.writeFile(target, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const reader = new ReadFileTool();
    const editor = new EditFileTool();

    const readResult = await reader.execute({ path: "latin.txt" });
    const hash = readResult.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(hash, "read must return a hash for the raw bytes");

    const edited = await editor.execute({
      path: "latin.txt",
      oldText: "caf\uFFFD",
      newText: "cafe",
      expectedHash: hash,
    });
    assert.match(edited, /文件精准编辑成功/);
    assert.equal(await fs.readFile(target, "utf8"), "cafe\n");
  });
});

test("bash keeps both output head and tail with duration metadata", async () => {
  await withWorkspace(async (workspace) => {
    const script = path.join(workspace, "long-output.cjs");
    await fs.writeFile(script, "process.stdout.write('HEAD-' + 'x'.repeat(9000) + '-TAIL')\n");
    const result = await new BashTool().execute({ command: `"${process.execPath}" "${script}"` });
    assert.match(result, /HEAD-/);
    assert.match(result, /-TAIL/);
    assert.match(result, /中间省略/);
    assert.match(result, /耗时 \d+ms/);
    assert.ok(result.length <= 8_000);
  });
});

test("bash timeout terminates the command through the existing abort path", {
  timeout: 8_000,
}, async () => {
  await withWorkspace(async (workspace) => {
    const script = path.join(workspace, "wait.cjs");
    await fs.writeFile(script, "setTimeout(() => {}, 10000)\n");
    const startedAt = Date.now();
    const result = await new BashTool().execute({
      command: `"${process.execPath}" "${script}"`,
      timeoutMs: 1_000,
    });
    assert.match(result, /^\[命令执行超时 - 1000ms\]/);
    assert.ok(Date.now() - startedAt < 5_000);
  });
});

test("edit matches LF oldText against CRLF files and keeps CRLF endings", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "crlf.ts");
    await fs.writeFile(target, "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n");
    const result = await new EditFileTool().execute({
      path: "crlf.ts",
      oldText: "const a = 1;\nconst b = 2;",
      newText: "const a = 1;\nconst b = 20;",
    });
    assert.match(result, /文件精准编辑成功/);
    assert.equal(
      await fs.readFile(target, "utf8"),
      "const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n",
    );
  });
});

test("edit miss shows the closest actual lines so the model can correct oldText", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "near.ts");
    const original = "function run() {\n\tconst value = compute();\n\treturn value;\n}\n";
    await fs.writeFile(target, original);
    const editor = new EditFileTool();

    // 缩进写错（空格 vs Tab）
    const indent = await editor.execute({
      path: "near.ts",
      oldText: "  const value = compute();\n  return value;",
      newText: "x",
    });
    assert.match(indent, /^编辑失败: 在文件中找不到指定的 oldText 原文（缩进或空白不一致）。\n/);
    assert.match(indent, /最接近的位置/);
    assert.match(indent, /2 \| \tconst value = compute\(\);/);

    // 带了 read 的行号前缀
    const prefixed = await editor.execute({
      path: "near.ts",
      oldText: "2 | \tconst value = compute();",
      newText: "x",
    });
    assert.match(prefixed, /行号 \| 」前缀/);

    // 锚点行已不存在：提示先 read，而不是凭记忆重试
    const stale = await editor.execute({
      path: "near.ts",
      oldText: "const removed = old();",
      newText: "x",
    });
    assert.match(stale, /请先用 read 重新读取/);
    assert.equal(await fs.readFile(target, "utf8"), original);
  });
});
