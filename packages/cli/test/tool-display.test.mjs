import assert from "node:assert/strict";
import test from "node:test";

import {
  buildToolDisplay,
  formatGenericToolArgs,
  formatToolCallDraft,
  toolCellStatus,
  toolDisplayStatus,
} from "../dist/tool-display.js";

test("known tools keep their dedicated one-line title", () => {
  assert.equal(
    buildToolDisplay({ toolName: "bash", args: { command: "npm test" } }).title,
    "npm test",
  );
  assert.equal(
    buildToolDisplay({ toolName: "read", args: { path: "src/a.ts", startLine: 10 } }).title,
    "src/a.ts:10",
  );
  assert.equal(
    buildToolDisplay({ toolName: "grep", args: { query: "TODO", path: "packages" } }).title,
    '"TODO" · packages',
  );
});

test("unknown tools fall back to `name [k=v]` with scalars only", () => {
  const display = buildToolDisplay({
    toolName: "my_mcp_tool",
    args: { path: "src/a.ts", depth: 2, strict: true, nested: { a: 1 }, list: [1, 2] },
  });
  assert.equal(display.title, "my_mcp_tool [path=src/a.ts, depth=2, strict=true]");
  // 没有标量参数时只留工具名，不出现空方括号。
  assert.equal(buildToolDisplay({ toolName: "my_mcp_tool", args: {} }).title, "my_mcp_tool");
  assert.equal(buildToolDisplay({ toolName: "my_mcp_tool" }).title, "my_mcp_tool");
});

test("generic args collapse whitespace and cap the length", () => {
  assert.equal(formatGenericToolArgs({ text: "a\n  b" }), "text=a b");
  const long = formatGenericToolArgs({ text: "x".repeat(200) }, 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith("…"));
});

test("display status maps results and defaults to running", () => {
  assert.equal(toolDisplayStatus(undefined), "running");
  assert.equal(toolDisplayStatus({ status: "success" }), "ok");
  assert.equal(toolDisplayStatus({ status: "failed" }), "error");
  assert.equal(toolDisplayStatus({ status: "rejected" }), "denied");
});

test("display carries the result detail, kind and expandability", () => {
  const bash = buildToolDisplay({
    toolName: "bash",
    args: { command: "npm test" },
    result: { status: "success", text: "94 行输出", preview: ["# pass 91"] },
  });
  assert.equal(bash.kind, "block");
  assert.equal(bash.detail, "94 行输出");
  assert.equal(bash.status, "ok");
  assert.equal(bash.expandable, true);

  const read = buildToolDisplay({ toolName: "read", args: { path: "a.ts" } });
  assert.equal(read.kind, "inline");
  assert.equal(read.status, "running");
  assert.equal(read.expandable, false);
  // 只给了完整输出、没有预览时，也算“可展开”。
  assert.equal(
    buildToolDisplay({ toolName: "read", args: { path: "a.ts" }, output: "x" }).expandable,
    true,
  );
});

test("cell status round-trips through the tool block symbols", () => {
  assert.equal(toolCellStatus({ status: "ok" }), "success");
  assert.equal(toolCellStatus({ status: "error" }), "failed");
  assert.equal(toolCellStatus({ status: "denied" }), "rejected");
  assert.equal(toolCellStatus({ status: "running" }), "running");
});

test("tool call draft shows the growing argument prefix while arguments stream", () => {
  // 半截 JSON 也要能读出「在做什么」，并随分片变长而变长。
  const partial = '{"path": "packages/cli/src/ind';
  const first = formatToolCallDraft({ name: "read", argumentsText: partial });
  assert.equal(first, `packages/cli/src/ind · ${partial.length} 字`);
  const longer = `${partial}ex.ts"}`;
  const second = formatToolCallDraft({ name: "read", argumentsText: longer });
  assert.equal(second, `packages/cli/src/index.ts · ${longer.length} 字`);
  // 参数还没开始时只报工具名。
  assert.equal(formatToolCallDraft({ name: "read", argumentsText: "" }), "read");
  // 名字也没到时给兜底主语，不能是空行。
  assert.equal(formatToolCallDraft({ argumentsText: '{"comm' }), "工具调用 · 6 字");
  // 完整 JSON 直接复用标准摘要，与执行阶段的标题一致。
  assert.equal(
    formatToolCallDraft({ name: "bash", argumentsText: '{"command":"npm test"}' }),
    "npm test · 22 字",
  );
});
