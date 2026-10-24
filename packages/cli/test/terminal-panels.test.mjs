import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActivityRow,
  buildStatusBarRow,
  buildTaskPanelRows,
  buildTurnSummary,
} from "../dist/terminal-panels.js";
import { terminalWidth } from "../dist/terminal-text.js";

function baseStatusState(overrides = {}) {
  return {
    permissionMode: "default",
    usedTokens: 4000,
    maxTokens: 128000,
    modelName: "deepseek-v4-flash",
    providerName: "DeepSeek",
    reasoningEffort: "medium",
    currentPath: "D:\\work\\hajicli (master)",
    ...overrides,
  };
}

test("status bar row fits the requested width and shows context usage", () => {
  for (const width of [60, 80, 120]) {
    const row = buildStatusBarRow(baseStatusState(), width);
    assert.equal(terminalWidth(row), width, `width ${width} 的状态栏应恰好占满一行（不足补空格）`);
  }
  const row = buildStatusBarRow(baseStatusState(), 120);
  assert.match(row, /\[默认\]/);
  assert.match(row, /ctx/);
});

test("status bar degrades gracefully on narrow widths", () => {
  // 窄宽度下也不允许溢出：截断后仍等于请求宽度
  const narrow = buildStatusBarRow(baseStatusState(), 30);
  assert.equal(terminalWidth(narrow), 30);
  // minimal 档位显示百分比而不是绝对数值
  const minimal = buildStatusBarRow(baseStatusState(), 40, "minimal");
  assert.match(minimal, /3%/);
  assert.ok(!minimal.includes("4K/128K"));
});

test("status bar prefers full model triple then degrades to model+effort", () => {
  const wide = buildStatusBarRow(baseStatusState(), 140, "full");
  assert.match(wide, /DeepSeek · deepseek-v4-flash · medium/);
  // 空间不足以放下 provider 时退化为 模型 · 强度
  const mid = buildStatusBarRow(baseStatusState(), 52, "full");
  assert.match(mid, /deepseek-v4-flash · medium/);
  assert.ok(!mid.includes("DeepSeek ·"));
});

test("activity row returns empty without a frame and truncates on narrow widths", () => {
  assert.equal(buildActivityRow(undefined, 80), "");
  const frame = {
    icon: "⏳",
    label: "思考中",
    detail: "模型尚未响应",
    elapsed: "3s",
    phase: "thinking",
    tone: "normal",
    idleText: "",
  };
  const row = buildActivityRow(frame, 80);
  assert.match(row, /思考中/);
  assert.ok(terminalWidth(row) <= 80, "活动行不允许超出给定宽度");
  const tiny = buildActivityRow(frame, 20);
  assert.ok(terminalWidth(tiny) <= 20, "窄宽度下活动行必须截断");
  assert.match(tiny, /思考中|⏳/, "截断后至少保留阶段标识");
});

test("task panel rows render status glyphs, agent sub-rows and collapse footer", () => {
  const state = {
    title: "重构回合循环",
    expanded: false,
    items: [
      { id: "t1", content: "拆出 turn-runner", status: "in_progress" },
      {
        id: "t2",
        content: "验证测试",
        status: "pending",
        agent: { id: "agent_1", role: "research", status: "running" },
      },
      { id: "t3", content: "已完成的任务名", status: "completed" },
    ],
  };
  const rows = buildTaskPanelRows(state, 80);
  const text = rows.join("\n");
  assert.match(text, /任务 · 重构回合循环/);
  assert.match(text, /●/); // in_progress
  assert.match(text, /○/); // pending
  assert.match(text, /✓/); // completed
  assert.match(text, /↳ research · 运行中/);

  // 未展开且条目超过 5 条时出现折叠脚注与统计
  const many = {
    title: "大量任务",
    expanded: false,
    items: Array.from({ length: 9 }, (_, i) => ({
      id: `t${i}`,
      content: `任务 ${i}`,
      status: i < 3 ? "completed" : i === 3 ? "in_progress" : "pending",
    })),
  };
  const manyRows = buildTaskPanelRows(many, 80).join("\n");
  assert.match(manyRows, /… 另有 \d+ 项/);
  assert.match(manyRows, /Ctrl\+T 展开/);
  // 展开后脚注切换为收起提示
  const expandedRows = buildTaskPanelRows({ ...many, expanded: true }, 80).join("\n");
  assert.match(expandedRows, /Ctrl\+T 收起/);
});

test("task panel shows overall progress, elapsed time and agent tokens", () => {
  const now = Date.now();
  const rows = buildTaskPanelRows(
    {
      title: "重构 provider 层",
      expanded: false,
      items: [
        { id: "1", content: "调研现状", status: "completed" },
        {
          id: "2",
          content: "抽取配置模块",
          status: "in_progress",
          startedAt: now - 74_000,
          agent: { id: "a1", role: "explorer", status: "running", tokens: 12_400 },
        },
      ],
    },
    80,
    8,
    now,
  ).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(rows[0], /任务 · 重构 provider 层 {2}1\/2/);
  assert.match(rows[2], /● 抽取配置模块 {2}1m14s/);
  assert.match(rows[3], /↳ explorer · 运行中 · 12k/);
});

test("buildTurnSummary assembles one line and drops segments by width", () => {
  const full = {
    durationMs: 12_300,
    outputTokens: 1_234,
    toolCalls: 5,
    changedFiles: { files: 3, added: 42, removed: 7 },
    typeCheck: { ok: true },
    costDeltaCny: 0.012,
  };
  const wide = buildTurnSummary(full, 120);
  assert.match(wide, /^完成 · 12\.3s/);
  assert.match(wide, /改动 3 个文件 \+42 −7/);
  assert.match(wide, /类型检查 ✓/);
  assert.match(wide, /¥0\.012/);
  assert.match(wide, /输出 1\.2k tokens/);
  assert.match(wide, /5 次工具调用（Ctrl\+O）/);

  // 窄屏按「工具次数 → 费用 → 类型检查」依次舍弃，始终保持单行。
  const medium = buildTurnSummary(full, 64);
  assert.doesNotMatch(medium, /Ctrl\+O/);
  assert.match(medium, /完成 · 12\.3s/);
  const narrow = buildTurnSummary(full, 40);
  assert.match(narrow, /^完成 · 12\.3s/);
  assert.ok(!narrow.includes("\n"));
});

test("buildTurnSummary omits absent stats", () => {
  const minimal = buildTurnSummary({ durationMs: 800, toolCalls: 0 }, 80);
  assert.equal(minimal, "完成 · 800ms");
  const noCost = buildTurnSummary(
    { durationMs: 1000, toolCalls: 1, outputTokens: 10, costDeltaCny: 0 },
    80,
  );
  assert.doesNotMatch(noCost, /¥/);
  const failedCheck = buildTurnSummary(
    { durationMs: 1000, toolCalls: 0, typeCheck: { ok: false } },
    80,
  );
  assert.match(failedCheck, /类型检查 ✕/);
});
