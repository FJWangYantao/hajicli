import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFoldHeader,
  categorizeFoldTool,
  FoldStatsCollector,
  renderSegmentText,
  splitBlankEdges,
} from "../dist/process-fold.js";
import { terminalWidth } from "../dist/terminal-text.js";
import { resetActiveColorLevel, setActiveColorLevel } from "../dist/theme.js";

const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

setActiveColorLevel("mono");

function stats(overrides = {}) {
  return { counts: {}, calls: 0, failed: 0, rejected: 0, thinking: 0, ...overrides };
}

test("categorizeFoldTool maps every documented tool name", () => {
  const table = {
    read: "read",
    grep: "search",
    global: "search",
    edit: "edit",
    write: "edit",
    bash: "command",
    webfetch: "web",
    websearch: "web",
    subagent: "agent",
    verifyagent: "agent",
    taskcreate: "task",
    tasklist: "task",
    updatetask: "task",
    taskfinish: "task",
    loadskill: "skill",
    listskillresources: "skill",
    readskillresource: "skill",
  };
  for (const [toolName, category] of Object.entries(table)) {
    assert.equal(categorizeFoldTool(toolName), category, toolName);
  }
  assert.equal(categorizeFoldTool("mcp_github_create_issue"), "mcp");
  assert.equal(categorizeFoldTool("projectinfo"), "other");
  assert.equal(categorizeFoldTool("READ"), "read", "tool names are case-insensitive");
});

test("FoldStatsCollector dedupes read/edit paths but counts other tools per call", () => {
  const collector = new FoldStatsCollector();
  collector.addTool("read", { path: "a.ts" }, "success");
  collector.addTool("read", { path: "a.ts" }, "success");
  collector.addTool("read", { path: "b.ts" }, "success");
  collector.addTool("edit", { path: "a.ts" }, "success");
  collector.addTool("write", { path: "a.ts" }, "success");
  collector.addTool("read", {}, "success");
  collector.addTool("bash", { command: "pnpm test" }, "failed");
  collector.addTool("bash", { command: "pnpm test" }, "rejected");
  collector.addThinking();
  const snapshot = collector.snapshot();

  assert.equal(snapshot.counts.read, 3, "two unique paths + one pathless call");
  assert.equal(snapshot.counts.edit, 1, "edit + write on the same path count once");
  assert.equal(snapshot.counts.command, 2);
  assert.equal(snapshot.calls, 8, "call count ignores dedupe");
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.rejected, 1);
  assert.equal(snapshot.thinking, 1);
  assert.equal(collector.isEmpty(), false);

  // snapshot 是拷贝：调用方拿到后继续收集不会污染已发出的快照。
  collector.addTool("bash", {}, "success");
  assert.equal(snapshot.counts.command, 2);
});

test("buildFoldHeader renders the full summary line", () => {
  const header = buildFoldHeader(
    stats({
      counts: { read: 4, search: 2, edit: 2, command: 1 },
      calls: 9,
      thinking: 3,
      failed: 1,
      rejected: 2,
    }),
    120,
  );
  assert.equal(
    stripAnsi(header),
    "  ● 读取 4 个文件，搜索 2 次，编辑 2 个文件，运行 1 条命令 · 思考 3 次 · 1 次失败 · 2 次被拒",
  );
});

test("buildFoldHeader omits the thinking field for non-reasoning models", () => {
  const header = stripAnsi(buildFoldHeader(stats({ counts: { read: 1 }, calls: 1 }), 120));
  assert.equal(header, "  ● 读取 1 个文件");
  assert.doesNotMatch(header, /思考/);
});

test("buildFoldHeader degrades step by step and always stays on one line", () => {
  const full = stats({
    counts: { read: 12, search: 7, edit: 5, command: 4, web: 2, agent: 1, task: 3, skill: 2 },
    calls: 36,
    thinking: 6,
    failed: 2,
  });

  // 1 → 2：先合并成“等 N 类”。
  const merged = stripAnsi(buildFoldHeader(full, 56));
  assert.match(merged, /等 \d+ 类/);
  assert.ok(terminalWidth(merged) <= 56);

  // 3：工具部分退化成次数。
  const counted = stripAnsi(buildFoldHeader(full, 40));
  assert.match(counted, /36 次工具调用/);

  // 4：丢掉思考。
  const noThinking = stripAnsi(buildFoldHeader(full, 30));
  assert.match(noThinking, /36 次工具调用/);
  assert.doesNotMatch(noThinking, /思考/);

  // 5：最后手段是截断。
  const truncated = stripAnsi(buildFoldHeader(full, 12));
  assert.ok(terminalWidth(truncated) <= 12, `width ${terminalWidth(truncated)} <= 12`);

  // 每一档都必须放得下。
  for (const width of [120, 80, 60, 56, 46, 40, 32, 24, 22, 16, 12, 8, 4]) {
    const rendered = buildFoldHeader(full, width);
    assert.ok(
      terminalWidth(rendered) <= width,
      `width ${width}: ${JSON.stringify(stripAnsi(rendered))}`,
    );
    assert.ok(!stripAnsi(rendered).includes("\n"), "summary stays a single line");
  }
});

test("buildFoldHeader paints the bullet red when a tool failed", () => {
  setActiveColorLevel("truecolor");
  try {
    const header = buildFoldHeader(stats({ counts: { bash: 1 }, calls: 1, failed: 1 }), 80);
    assert.match(header, /\x1b\[1m/, "failed summary uses a bold bullet");
    assert.match(header, /\x1b\[38;2;/, "and a real color sequence");
    const clean = buildFoldHeader(stats({ counts: { bash: 1 }, calls: 1 }), 80);
    assert.doesNotMatch(clean, /\x1b\[1m/, "clean summary keeps the muted bullet");
  } finally {
    resetActiveColorLevel();
    setActiveColorLevel("mono");
  }
});

test("splitBlankEdges keeps leading and trailing blank lines out of the body", () => {
  const edges = splitBlankEdges("\n  \x1b[31m\n工具块\n正文\n\n");
  assert.equal(edges.leading, "\n  \x1b[31m\n");
  assert.equal(edges.body, "工具块\n正文\n");
  assert.equal(edges.trailing, "\n");
});

test("renderSegmentText folds, expands and passes through by flag", () => {
  const raw = "\n  ✓ read a.ts  12ms\n\n";
  const segment = {
    kind: "fold",
    raw,
    stats: stats({ counts: { read: 1 }, calls: 1, thinking: 1 }),
    expanded: false,
  };

  const folded = renderSegmentText(segment, 60, true);
  assert.equal(folded.headerRow, 1, "header sits after the leading blank line");
  assert.equal(
    folded.text,
    "\n  ● 读取 1 个文件 · 思考 1 次\n\n",
    "collapsed: leading blanks + header + trailing blanks",
  );

  const expanded = renderSegmentText({ ...segment, expanded: true }, 60, true);
  assert.equal(expanded.text, `\n  ● 读取 1 个文件 · 思考 1 次\n${raw.slice(1)}`);

  const disabled = renderSegmentText(segment, 60, false);
  assert.equal(disabled.text, raw, "/fold off keeps the original text");

  const plain = renderSegmentText({ kind: "plain", raw }, 60, true);
  assert.equal(plain.text, raw);
  assert.equal(plain.headerRow, undefined);
});
