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
    assert.match(staleEdit, /并发写入/);
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

    const editedHash = edited.match(/newHash=([a-f0-9]{16})/)?.[1];
    await fs.writeFile(target, "edited externally\n");
    const staleWrite = await writer.execute({
      path: "target.txt",
      content: "wrong\n",
      expectedHash: editedHash,
    });
    assert.match(staleWrite, /文件已变化/);
    assert.equal(await fs.readFile(target, "utf8"), "edited externally\n");

    await fs.writeFile(target, "edited\n");
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

function hashOf(output, key = "hash") {
  const hash = output.match(new RegExp(`${key}=([a-f0-9]{16})`))?.[1];
  assert.ok(hash, output);
  return hash;
}

test("write accepts a stale hash when only its own edits happened in between", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "chain.txt");
    await fs.writeFile(target, "one\ntwo\n");
    const reader = new ReadFileTool();
    const editor = new EditFileTool();
    const writer = new WriteFileTool();
    const readHash = hashOf(await reader.execute({ path: "chain.txt" }));

    const edited = await editor.execute({
      path: "chain.txt",
      oldText: "one",
      newText: "uno",
      expectedHash: readHash,
    });
    assert.match(edited, /文件精准编辑成功/);

    // 模型沿用最初 read 的 hash 整体覆写：期间只有自己的 edit，不应冲突。
    const written = await writer.execute({
      path: "chain.txt",
      content: "rewritten\n",
      expectedHash: readHash,
    });
    assert.match(written, /文件写入成功/);
    assert.match(written, /expectedHash 已过期，但期间只有你本轮自己的 edit\/write/);
    assert.equal(await fs.readFile(target, "utf8"), "rewritten\n");

    // 连续的 write 同样在链上：再用最初的 hash 覆写仍可放行。
    const again = await writer.execute({
      path: "chain.txt",
      content: "final\n",
      expectedHash: readHash,
    });
    assert.match(again, /文件写入成功/);
    assert.equal(await fs.readFile(target, "utf8"), "final\n");
  });
});

test("write still rejects a stale hash after an external change and explains next steps", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "external.txt");
    await fs.writeFile(target, "one\n");
    const reader = new ReadFileTool();
    const editor = new EditFileTool();
    const writer = new WriteFileTool();
    const readHash = hashOf(await reader.execute({ path: "external.txt" }));
    await editor.execute({ path: "external.txt", oldText: "one", newText: "uno" });

    // 模拟 bash 里跑了格式化：不在版本链上。
    await fs.writeFile(target, "uno // formatted\n");
    const rejected = await writer.execute({
      path: "external.txt",
      content: "wrong\n",
      expectedHash: readHash,
    });
    assert.match(
      rejected.split("\n")[0],
      /^写入失败: 文件已变化：期望 hash=[a-f0-9]{16}，当前 hash=[a-f0-9]{16}。$/,
    );
    assert.match(rejected, /外部修改/);
    assert.match(rejected, /先 read 获取当前内容与 hash/);
    assert.equal(await fs.readFile(target, "utf8"), "uno // formatted\n");

    // 重新 read 后版本链从当前版本重新开始，更早的 hash 依旧不能放行，新 hash 可以。
    const currentHash = hashOf(await reader.execute({ path: "external.txt" }));
    const stillRejected = await writer.execute({
      path: "external.txt",
      content: "wrong\n",
      expectedHash: readHash,
    });
    assert.match(stillRejected, /文件已变化/);
    const written = await writer.execute({
      path: "external.txt",
      content: "final\n",
      expectedHash: currentHash,
    });
    assert.match(written, /文件写入成功/);
    assert.doesNotMatch(written, /expectedHash 已过期/);
  });
});

test("write treats an edit that merged external changes as breaking the chain", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "merged.txt");
    await fs.writeFile(target, "keep\nchange\n");
    const reader = new ReadFileTool();
    const editor = new EditFileTool();
    const writer = new WriteFileTool();
    const readHash = hashOf(await reader.execute({ path: "merged.txt" }));

    await fs.writeFile(target, "keep externally\nchange\n");
    const edited = await editor.execute({
      path: "merged.txt",
      oldText: "change",
      newText: "changed",
      expectedHash: readHash,
    });
    assert.match(edited, /expectedHash 已过期/);

    // edit 自动合入了模型没看过的外部修改，基于旧 hash 的整体覆写会把它冲掉。
    const rejected = await writer.execute({
      path: "merged.txt",
      content: "wrong\n",
      expectedHash: readHash,
    });
    assert.match(rejected, /文件已变化/);
    assert.equal(await fs.readFile(target, "utf8"), "keep externally\nchanged\n");
  });
});

test("write does not accept another agent's edits as part of its own chain", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "shared.txt");
    await fs.writeFile(target, "one\n");
    const reader = new ReadFileTool();
    const editor = new EditFileTool();
    const writer = new WriteFileTool();
    const readHash = hashOf(await reader.execute({ path: "shared.txt" }));
    const subEdit = await editor.execute(
      { path: "shared.txt", oldText: "one", newText: "sub" },
      { agentId: "sub-1" },
    );
    assert.match(subEdit, /文件精准编辑成功/);

    const rejected = await writer.execute({
      path: "shared.txt",
      content: "main\n",
      expectedHash: readHash,
    });
    assert.match(rejected, /文件已变化/);
    assert.equal(await fs.readFile(target, "utf8"), "sub\n");
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

test("write treats an already-applied duplicate content as success instead of another conflict", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "dup.txt");
    await fs.writeFile(target, "before\n");
    const reader = new ReadFileTool();
    const writer = new WriteFileTool();
    const initialRead = await reader.execute({ path: "dup.txt" });
    const staleHash = initialRead.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(staleHash);

    // 第一条 write 已落盘；模型在同一条消息里把同样的内容再写一次，带的还是读到的旧 hash。
    const first = await writer.execute({
      path: "dup.txt",
      content: "after\n",
      expectedHash: staleHash,
    });
    assert.match(first, /文件写入成功/);
    const duplicate = await writer.execute({
      path: "dup.txt",
      content: "after\n",
      expectedHash: staleHash,
    });
    assert.match(duplicate, /文件写入成功/);
    assert.match(duplicate, /未重复写入/);
    assert.doesNotMatch(duplicate, /写入失败/);
    assert.equal(await fs.readFile(target, "utf8"), "after\n");

    // 行尾差异不算内容变化，同样按已写入处理。
    await fs.writeFile(target, "after\r\n");
    const crlf = await writer.execute({
      path: "dup.txt",
      content: "after\n",
      expectedHash: staleHash,
    });
    assert.match(crlf, /未重复写入/);
  });
});

test("write conflict keeps telling the model the current hash when the content differs", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "conflict.txt");
    await fs.writeFile(target, "before\n");
    const reader = new ReadFileTool();
    const writer = new WriteFileTool();
    const initialRead = await reader.execute({ path: "conflict.txt" });
    const staleHash = initialRead.match(/hash=([a-f0-9]{16})/)?.[1];
    assert.ok(staleHash);

    await fs.writeFile(target, "external\n");
    const result = await writer.execute({
      path: "conflict.txt",
      content: "mine\n",
      expectedHash: staleHash,
    });
    assert.match(result, /写入失败/);
    assert.match(result, /当前 hash=[a-f0-9]{16}/);
    assert.match(result, /当前 hash/);
    assert.equal(await fs.readFile(target, "utf8"), "external\n");
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

test("edit success echoes the edited region so the next edit can quote it", async () => {
  await withWorkspace(async () => {
    await fs.writeFile("edit-region.txt", "alpha\nbeta\n");
    const result = await new EditFileTool().execute({
      path: "edit-region.txt",
      oldText: "beta",
      newText: "beta\nchanged",
    });
    assert.match(result, /文件精准编辑成功/);
    assert.match(result, /改后片段（第 2 行起）/);
    assert.match(result, /2 \| beta/);
    assert.match(result, /3 \| changed/);
  });
});

test("edit miss names the agent's own previous edit instead of blaming an external change", async () => {
  await withWorkspace(async () => {
    await fs.writeFile("own-edit.txt", "value\n");
    const editor = new EditFileTool();
    const first = await editor.execute({
      path: "own-edit.txt",
      oldText: "value",
      newText: "updated",
    });
    assert.match(first, /文件精准编辑成功/);

    // 拿「改动前」的文本再改一次：应指出这是自己上一步改的，而不是谎报外部修改。
    const second = await editor.execute({
      path: "own-edit.txt",
      oldText: "value",
      newText: "again",
    });
    assert.match(second, /找不到指定的 oldText 原文/);
    assert.match(second, /最近一次改动是你自己/);
    assert.doesNotMatch(second, /hash冲突/);
    assert.equal(await fs.readFile("own-edit.txt", "utf8"), "updated\n");
  });
});

test("repeated identical edit misses require a read before they can keep retrying", async () => {
  await withWorkspace(async () => {
    await fs.writeFile("mistake.txt", "alpha\n  beta\n");
    const editor = new EditFileTool();
    const reader = new ReadFileTool();
    const wrong = { path: "mistake.txt", oldText: "alpha\n   beta", newText: "x" };

    const first = await editor.execute(wrong);
    assert.match(first.split("\n")[0], /找不到指定的 oldText 原文（缩进或空白不一致）/);
    assert.doesNotMatch(first, /已连续/);

    const second = await editor.execute(wrong);
    assert.match(second, /已连续 2 次同类未命中/);
    assert.match(second, /先 read/);

    // read 之后重新计数：同一条错误 oldText 又能得到正常的分类提示。
    await reader.execute({ path: "mistake.txt" });
    const third = await editor.execute(wrong);
    assert.match(third.split("\n")[0], /找不到指定的 oldText 原文（缩进或空白不一致）/);
    assert.doesNotMatch(third, /已连续/);
    assert.equal(await fs.readFile("mistake.txt", "utf8"), "alpha\n  beta\n");
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
