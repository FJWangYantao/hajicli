import assert from "node:assert/strict";
import test from "node:test";

import {
  buildToolDisplay,
  formatGenericToolArgs,
  formatToolCallDraft,
  formatToolCallDraftCell,
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

test("draft cell streams the instruction body instead of waiting for full args", () => {
  // 头部只报进度，指令原文在块体里，随分片增长——这是「流式给出指令」的可见点。
  const partial = formatToolCallDraftCell(
    { name: "bash", argumentsText: '{"command": "git sta' },
    60,
  );
  assert.equal(partial[0].includes("bash"), true);
  assert.equal(partial[0].includes("20 字"), true);
  assert.equal(partial[1].includes("git sta"), true);

  const longer = formatToolCallDraftCell(
    { name: "bash", argumentsText: '{"command": "git status -sb"}' },
    60,
  );
  // 分片变长后块体同步变长，且不再露出 JSON 外壳。
  assert.equal(longer[1].includes("git status -sb"), true);
  assert.equal(
    longer.some((line) => line.includes("{")),
    false,
  );
});

test("draft cell strips the JSON envelope and falls back to the raw slice", () => {
  // 认得出结构：只留值（`{"path": "...}}"` → 路径本身）。
  const read = formatToolCallDraftCell({ name: "read", argumentsText: '{"path": "src/a"}' }, 60);
  assert.equal(read[1].includes("src/a"), true);
  // 认不出结构：宁可露出原始分片，也不显示空块。
  const raw = formatToolCallDraftCell({ argumentsText: '{"pa' }, 60);
  assert.equal(raw[1].includes('{"pa'), true);
});

test("draft cell caps long instructions and marks the truncation", () => {
  const command = `echo ${"x".repeat(240)}`;
  const args = JSON.stringify({ command });
  const rows = formatToolCallDraftCell({ name: "bash", argumentsText: args }, 40, 3);
  // 头部 1 行 + 正文最多 3 行 + 收口提示 1 行。
  assert.equal(rows.length, 5);
  assert.match(rows.at(-1), /另有 \d+ 字符未显示/);
});

test("draft cell keeps multi-line commands on their own lines, uncut", () => {
  const command = ["cat <<EOF > out.txt", "line1", "line2", "line3", "EOF"].join("\n");
  const rows = formatToolCallDraftCell(
    { name: "bash", argumentsText: JSON.stringify({ command }) },
    72,
  );
  // 默认预算内整条展开：5 行正文各自成行，没有折成一坨、也没有省略号。
  assert.deepEqual(
    rows.slice(1).map((row) => row.trim().replace(/^│ /, "")),
    ["cat <<EOF > out.txt", "line1", "line2", "line3", "EOF"],
  );
  assert.equal(
    rows.some((row) => row.includes("…")),
    false,
  );
});

test("draft cell keeps script indentation", () => {
  const command = ["for f in *.ts; do", '  if [ -f "$f" ]; then', '    echo "$f";', "  fi", "done"];
  const rows = formatToolCallDraftCell(
    { name: "bash", argumentsText: JSON.stringify({ command: command.join("\n") }) },
    72,
  );
  assert.deepEqual(
    rows.slice(1).map((row) => row.replace(/^\s*│\s?/, "")),
    command,
  );
});

test("draft cell keeps newlines from a half-streamed JSON slice", () => {
  // 参数还在下发：`\n` 是 JSON 转义，也要还原成换行，否则多行脚本看起来像一行。
  const partial = '{"command": "for f in a b c; do\\n  echo $f;\\ndone';
  const rows = formatToolCallDraftCell({ name: "bash", argumentsText: partial }, 72);
  assert.deepEqual(
    // 行首缩进按原样保留，这里只比对各行的文字内容。
    rows.slice(1).map((row) => row.replace(/^\s*│\s*/, "").trim()),
    ["for f in a b c; do", "echo $f;", "done"],
  );
});

test("draft cell shows a dozen-line command in full by default", () => {
  const command = Array.from({ length: 12 }, (_, index) => `echo line${index}`).join("\n");
  const rows = formatToolCallDraftCell(
    { name: "bash", argumentsText: JSON.stringify({ command }) },
    72,
  );
  // 默认 20 行预算：12 行命令完整可见，不出现收口提示。
  assert.equal(rows.length, 13);
  assert.equal(
    rows.some((row) => row.includes("未显示")),
    false,
  );
});
