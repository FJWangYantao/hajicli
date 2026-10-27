import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRemainingOutline,
  detectOutlineLanguage,
  extractOutline,
  formatOutline,
  MAX_OUTLINE_CHARS,
  ReadFileTool,
  sampleOutlineEntries,
} from "../../plugins/dist/index.js";

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "haji-outline-"));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  try {
    await run(workspace);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

function numberedSource(count) {
  const lines = [];
  for (let index = 1; index <= count; index += 1) {
    lines.push(index % 10 === 0 ? `export function fn${index}() {` : `  // line ${index}`);
    if (index % 10 === 0) lines.push("  return 1;", "}");
  }
  return lines.join("\n");
}

test("detectOutlineLanguage 按扩展名判定，未知扩展名不猜", () => {
  assert.equal(detectOutlineLanguage("a.ts"), "ts");
  assert.equal(detectOutlineLanguage("a.MJS"), "ts");
  assert.equal(detectOutlineLanguage("a.py"), "python");
  assert.equal(detectOutlineLanguage("a.go"), "go");
  assert.equal(detectOutlineLanguage("a.rs"), "rust");
  assert.equal(detectOutlineLanguage("a.kt"), "jvm");
  assert.equal(detectOutlineLanguage("README.md"), "markdown");
  assert.equal(detectOutlineLanguage("run.sh"), "shell");
  assert.equal(detectOutlineLanguage("a.txt"), "unknown");
  assert.equal(detectOutlineLanguage("Makefile"), "unknown");
});

test("extractOutline 识别顶层与嵌套函数，并忽略 import 里的 type 行", () => {
  const lines = [
    "import {",
    "  type AgentRecord,",
    "  type ChatMessage,",
    "} from './types.js';",
    "export interface TurnDeps {",
    "  x: number;",
    "}",
    "export async function runAgentTurn(deps) {",
    "  const setMessages = (next) => {",
    "    return next;",
    "  };",
    "  function innerHelper() {",
    "    return 1;",
    "  }",
    "  return 1;",
    "}",
    "export class SessionManager {",
    "}",
  ];
  const entries = extractOutline(lines, 1, "ts");
  assert.deepEqual(
    entries.map((entry) => [entry.line, entry.label]),
    [
      [5, "interface TurnDeps"],
      [8, "fn runAgentTurn"],
      [9, "fn setMessages"],
      [12, "fn innerHelper"],
      [17, "class SessionManager"],
    ],
  );
});

test("extractOutline 支持 Python / Go / Markdown", () => {
  const python = extractOutline(
    ["class Store:", "    def load(self):", "        pass", "async def fetch():", "    pass"],
    1,
    "python",
  );
  assert.deepEqual(
    python.map((entry) => entry.label),
    ["class Store", "def load", "def fetch"],
  );
  const go = extractOutline(
    ["func (s *Store) Load() {}", "func main() {}", "type Item struct {}"],
    1,
    "go",
  );
  assert.deepEqual(
    go.map((entry) => entry.label),
    ["func Load", "func main", "type Item"],
  );
  const markdown = extractOutline(["# 标题", "正文", "## 第二节", "### 细节"], 1, "markdown");
  assert.deepEqual(
    markdown.map((entry) => entry.label),
    ["§ 标题", "§ 第二节", "§ 细节"],
  );
});

test("buildRemainingOutline 只从剩余区间开始，并带行号", () => {
  const lines = numberedSource(100).split("\n");
  const outline = buildRemainingOutline(lines, 51, "a.ts");
  assert.ok(outline);
  assert.match(outline, /^\[剩余符号\] /);
  assert.match(outline, /\bfn fn50\b/);
  assert.doesNotMatch(outline, /\bfn fn40\b/);
});

test("条目过多时均匀抽样，保留首尾且不超字符上限", () => {
  const entries = Array.from({ length: 200 }, (_, index) => ({
    line: (index + 1) * 10,
    label: `fn fn${index + 1}`,
  }));
  const sampled = sampleOutlineEntries(entries, 24);
  assert.equal(sampled.length, 24);
  assert.equal(sampled[0].line, 10);
  assert.equal(sampled[sampled.length - 1].line, 2000);

  const outline = formatOutline(sampled, MAX_OUTLINE_CHARS);
  assert.ok(outline);
  assert.ok(outline.length <= MAX_OUTLINE_CHARS);
  assert.match(outline, /\bfn fn1\b/);
  assert.match(outline, /\bfn fn200\b/);
});

test("read 截断时按开关附提纲，且不影响 nextStartLine", async () => {
  await withWorkspace(async () => {
    await fs.writeFile(path.join(process.cwd(), "big.ts"), numberedSource(300));
    const withOutline = new ReadFileTool({ outline: true });
    const result = await withOutline.execute({ path: "big.ts", limit: 20 });
    const text = typeof result === "string" ? result : result.output;
    assert.match(text, /hasMore=true/);
    assert.match(text, /nextStartLine=21/);
    assert.match(text, /\[剩余符号\]/);
    assert.match(text, /\bfn fn30\b/);

    const without = new ReadFileTool({ outline: false });
    const plain = await without.execute({ path: "big.ts", limit: 20 });
    const plainText = typeof plain === "string" ? plain : plain.output;
    assert.doesNotMatch(plainText, /\[剩余符号\]/);
    assert.match(plainText, /nextStartLine=21/);
  });
});

test("aroundLine 是明确窗口，不附整段剩余提纲", async () => {
  await withWorkspace(async () => {
    await fs.writeFile(path.join(process.cwd(), "big.ts"), numberedSource(300));
    const tool = new ReadFileTool({ outline: true });
    const result = await tool.execute({ path: "big.ts", aroundLine: 100, contextLines: 5 });
    const text = typeof result === "string" ? result : result.output;
    assert.match(text, /hasMore=true/);
    assert.doesNotMatch(text, /\[剩余符号\]/);
  });
});

test("未知扩展名不输出提纲", async () => {
  await withWorkspace(async () => {
    await fs.writeFile(path.join(process.cwd(), "notes.txt"), numberedSource(300));
    const tool = new ReadFileTool({ outline: true });
    const result = await tool.execute({ path: "notes.txt", limit: 20 });
    const text = typeof result === "string" ? result : result.output;
    assert.match(text, /hasMore=true/);
    assert.doesNotMatch(text, /\[剩余符号\]/);
  });
});

test("批量读不走提纲：仍不整块丢弃文件，且总量不超限", async () => {
  await withWorkspace(async () => {
    const body = numberedSource(500);
    for (let index = 0; index < 4; index += 1) {
      await fs.writeFile(path.join(process.cwd(), `file-${index}.ts`), body);
    }
    const tool = new ReadFileTool({ outline: true, readBudget: "batch_only" });
    const result = await tool.execute({
      paths: Array.from({ length: 4 }, (_, index) => ({ path: `file-${index}.ts` })),
    });
    const text = typeof result === "string" ? result : result.output;
    assert.ok(text.length <= 32_000, `输出超限 ${text.length}`);
    assert.equal((text.match(/\[文件读取结果 - /g) ?? []).length, 4);
    assert.doesNotMatch(text, /本次返回/);
    assert.doesNotMatch(text, /\[剩余符号\]/);
  });
});
