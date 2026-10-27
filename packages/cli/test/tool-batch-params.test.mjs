import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GlobalFindFilesTool, GrepSearchTool } from "@hajicli/plugins";

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-batch-params-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("grep queries 一次调用搜索多个关键词并分节返回", async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "alpha.ts"), "const needleOne = 1;\n");
    fs.writeFileSync(path.join(dir, "beta.ts"), "const needleTwo = 2;\n");
    const output = await new GrepSearchTool().execute({
      path: dir,
      queries: ["needleOne", "needleTwo"],
    });
    assert.match(output, /批量 Grep 搜索结果 - 共 2 个查询/);
    assert.match(output, /## query: needleOne/);
    assert.match(output, /## query: needleTwo/);
    assert.match(output, /alpha\.ts/);
    assert.match(output, /beta\.ts/);
  });
});

test("grep queries 与 query 互斥、数量超限时报错", async () => {
  const tool = new GrepSearchTool();
  assert.match(await tool.execute({ query: "a", queries: ["b"] }), /不能同时使用/);
  assert.match(
    await tool.execute({ queries: ["a", "b", "c", "d", "e", "f"] }),
    /queries 必须包含 1-5 个/,
  );
  assert.match(await tool.execute({ queries: [""] }), /必须是非空字符串/);
});

test("grep 单查询路径保持原有输出", async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "one.ts"), "const target = 1;\n");
    const output = await new GrepSearchTool().execute({ path: dir, query: "target" });
    assert.match(output, /^\[Grep 搜索结果/);
    assert.doesNotMatch(output, /批量 Grep/);
  });
});

test("global patterns 一次调用按多个名称模式查找并分节返回", async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "alpha.ts"), "export {};\n");
    fs.writeFileSync(path.join(dir, "beta.md"), "# beta\n");
    const output = await new GlobalFindFilesTool().execute({
      path: dir,
      patterns: ["alpha", "beta"],
    });
    assert.match(output, /批量文件查找结果 - 共 2 个模式/);
    assert.match(output, /## pattern: alpha/);
    assert.match(output, /## pattern: beta/);
    assert.match(output, /alpha\.ts/);
    assert.match(output, /beta\.md/);
  });
});

test("global patterns 与 pattern 互斥、数量超限时报错", async () => {
  const tool = new GlobalFindFilesTool();
  assert.match(await tool.execute({ pattern: "a", patterns: ["b"] }), /不能同时使用/);
  assert.match(
    await tool.execute({ patterns: ["a", "b", "c", "d", "e", "f"] }),
    /patterns 必须包含 1-5 个/,
  );
});

test("batchParams=false 时不暴露也不接受 queries / patterns", async () => {
  const grep = new GrepSearchTool({ batchParams: false });
  const global = new GlobalFindFilesTool({ batchParams: false });
  assert.equal(grep.definition.function.parameters.properties.queries, undefined);
  assert.equal(global.definition.function.parameters.properties.patterns, undefined);
  assert.doesNotMatch(grep.definition.function.description, /queries/);
  assert.doesNotMatch(global.definition.function.description, /patterns/);
  assert.match(await grep.execute({ queries: ["a", "b"] }), /未启用 queries/);
  assert.match(await global.execute({ patterns: ["a", "b"] }), /未启用 patterns/);
  assert.ok(grep.definition.function.parameters.properties.query);
  assert.ok(global.definition.function.parameters.properties.pattern);
});
