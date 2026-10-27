import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findSimilarSymbols,
  findSymbolDefinition,
  ReadFileTool,
} from "../../plugins/dist/index.js";

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "haji-symbol-"));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  try {
    await run(workspace);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

const TS_SOURCE = [
  "import { helper } from './helper.js';",
  "",
  "const before = helper(1);",
  "",
  "export function pick(value: string) {",
  "  const map = { a: '}', b: '{' };",
  "  // 注释里的括号不参与配平：{",
  "  return map[value] ?? '}';",
  "}",
  "",
  "export class Store {",
  "  public async load(id: string) {",
  "    if (!id) {",
  "      return undefined;",
  "    }",
  "    return id;",
  "  }",
  "}",
  "",
  "export type Options = {",
  "  a: number;",
  "};",
  "",
];

const PY_SOURCE = [
  "class Store:",
  "    def load(self):",
  "        return 1",
  "",
  "    def save(self):",
  "        return 2",
  "",
  "def other():",
  "    pass",
  "",
];

test("findSymbolDefinition 按花括号配平，忽略字符串与注释里的括号", () => {
  const lines = TS_SOURCE.join("\n").split("\n");
  const fn = findSymbolDefinition(lines, "pick", "a.ts");
  assert.deepEqual(fn, { startLine: 5, endLine: 9, label: "pick" });
  const method = findSymbolDefinition(lines, "load", "a.ts");
  assert.deepEqual(method, { startLine: 12, endLine: 17, label: "load" });
  const type = findSymbolDefinition(lines, "Options", "a.ts");
  assert.deepEqual(type, { startLine: 20, endLine: 22, label: "Options" });
});

test("调用点不会被误认成定义", () => {
  const lines = TS_SOURCE.join("\n").split("\n");
  assert.equal(findSymbolDefinition(lines, "helper", "a.ts"), undefined);
  assert.deepEqual(findSimilarSymbols(lines, "pick", "a.ts"), [{ line: 5, label: "fn pick" }]);
});

test("Python 按缩进判断块尾，Go 按花括号", () => {
  const py = PY_SOURCE.join("\n").split("\n");
  assert.deepEqual(findSymbolDefinition(py, "load", "a.py"), {
    startLine: 2,
    endLine: 3,
    label: "load",
  });
  assert.deepEqual(findSymbolDefinition(py, "other", "a.py"), {
    startLine: 8,
    endLine: 9,
    label: "other",
  });
  const go = [
    "package main",
    "",
    "func (s *Store) Load() error {",
    "\tif s == nil {",
    "\t\treturn nil",
    "\t}",
    "\treturn nil",
    "}",
  ];
  assert.deepEqual(findSymbolDefinition(go, "Load", "a.go"), {
    startLine: 3,
    endLine: 8,
    label: "Load",
  });
});

test("Markdown 按标题层级取整节", () => {
  const lines = ["# 标题", "", "## 第一节", "内容", "", "### 细节", "x", "", "## 第二节", "y"];
  assert.deepEqual(findSymbolDefinition(lines, "第一节", "doc.md"), {
    startLine: 3,
    endLine: 7,
    label: "第一节",
  });
});

test("read({ symbol }) 返回完整定义块，不带剩余符号提纲", async () => {
  await withWorkspace(async () => {
    await fs.writeFile(path.join(process.cwd(), "a.ts"), TS_SOURCE.join("\n"));
    const tool = new ReadFileTool({ outline: true, symbol: true });
    const result = await tool.execute({ path: "a.ts", symbol: "pick" });
    const text = typeof result === "string" ? result : result.output;
    assert.match(text, /符号=pick；定义=5-9/);
    assert.match(text, /5 \| export function pick/);
    assert.match(text, /9 \| \}/);
    assert.doesNotMatch(text, /10 \|/);
    assert.doesNotMatch(text, /\[剩余符号\]/);
    assert.doesNotMatch(text, /nextStartLine=/);
  });
});

test("定义块超过 limit 时按行截断并给 nextStartLine", async () => {
  await withWorkspace(async () => {
    await fs.writeFile(path.join(process.cwd(), "a.ts"), TS_SOURCE.join("\n"));
    const tool = new ReadFileTool({ symbol: true });
    const result = await tool.execute({ path: "a.ts", symbol: "pick", limit: 2 });
    const text = typeof result === "string" ? result : result.output;
    assert.match(text, /符号=pick；定义=5-9/);
    assert.match(text, /返回=5-6/);
    assert.match(text, /nextStartLine=7/);
  });
});

test("找不到符号时列出相近符号", async () => {
  await withWorkspace(async () => {
    await fs.writeFile(path.join(process.cwd(), "a.ts"), TS_SOURCE.join("\n"));
    const tool = new ReadFileTool({ symbol: true });
    const result = await tool.execute({ path: "a.ts", symbol: "pik" });
    const text = typeof result === "string" ? result : result.output;
    assert.match(text, /未找到符号 pik/);
    assert.match(text, /相近符号：5 fn pick/);
  });
});

test("symbol 与行范围参数互斥，也不能配 paths", async () => {
  await withWorkspace(async () => {
    await fs.writeFile(path.join(process.cwd(), "a.ts"), TS_SOURCE.join("\n"));
    const tool = new ReadFileTool({ symbol: true });
    const conflict = await tool.execute({ path: "a.ts", symbol: "pick", startLine: 1 });
    assert.match(String(conflict), /symbol 不能与 startLine/);
    const batch = await tool.execute({ paths: [{ path: "a.ts" }], symbol: "pick" });
    assert.match(String(batch), /symbol 只能用于单文件读取/);
  });
});

test("baseline 组不暴露 symbol 参数，也不接受它", async () => {
  await withWorkspace(async () => {
    await fs.writeFile(path.join(process.cwd(), "a.ts"), TS_SOURCE.join("\n"));
    const tool = new ReadFileTool({ symbol: false });
    const properties = tool.definition.function.parameters.properties;
    assert.equal(properties.symbol, undefined);
    const result = await tool.execute({ path: "a.ts", symbol: "pick" });
    assert.match(String(result), /未启用 symbol 参数/);
    // 其它能力不受影响
    const plain = await tool.execute({ path: "a.ts", startLine: 5, limit: 1 });
    const text = typeof plain === "string" ? plain : plain.output;
    assert.match(text, /5 \| export function pick/);
  });
});
