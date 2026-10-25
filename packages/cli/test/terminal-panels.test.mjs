import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActivityRow,
  buildDecodedText,
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

test("status bar row fits the requested width and no longer shows context usage", () => {
  for (const width of [60, 80, 120]) {
    const row = buildStatusBarRow(baseStatusState(), width);
    assert.equal(terminalWidth(row), width, `width ${width} 的状态栏应恰好占满一行（不足补空格）`);
  }
  const row = buildStatusBarRow(baseStatusState(), 120);
  assert.match(row, /\[默认\]/);
  assert.doesNotMatch(row, /ctx/);
});

test("status bar degrades gracefully on narrow widths", () => {
  // 窄宽度下也不允许溢出：截断后仍等于请求宽度
  const narrow = buildStatusBarRow(baseStatusState(), 30);
  assert.equal(terminalWidth(narrow), 30);
  // minimal 档位只保留模式徽标，不再显示上下文用量（原先右侧只有它）
  const minimal = buildStatusBarRow(baseStatusState(), 40, "minimal");
  assert.equal(terminalWidth(minimal), 40);
  assert.match(minimal, /\[默认\]/);
  assert.ok(!minimal.includes("ctx"));
  assert.ok(!minimal.includes("D:\\work"));
});

test("status bar prefers full model triple then degrades to model+effort", () => {
  const wide = buildStatusBarRow(baseStatusState(), 140, "full");
  assert.match(wide, /DeepSeek · deepseek-v4-flash · medium/);
  // 空间不足以放下 provider 时退化为 模型 · 强度
  const mid = buildStatusBarRow(baseStatusState(), 40, "full");
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

const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("decoded text resolves left to right and keeps its column width", () => {
  const target = "grep 读取结果 src/a.ts";
  assert.equal(stripAnsi(buildDecodedText(target, "")), target, "无耗时即静止，直接给完整文字");
  for (const elapsed of [0, 300, 900, 1500, 1800, 2400, 5300]) {
    const plain = stripAnsi(buildDecodedText(target, "", elapsed));
    assert.equal(terminalWidth(plain), terminalWidth(target), `${elapsed}ms 时整行宽度不变`);
  }
  // 一轮 2600ms：前 70% 逐字还原，中段只有前缀是原文、尾部是乱码。
  const mid = stripAnsi(buildDecodedText(target, "", 900));
  assert.notEqual(mid, target);
  assert.ok(target.startsWith(mid.slice(0, 4)), "已还原部分与原文一致");
  assert.equal(stripAnsi(buildDecodedText(target, "", 2400)), target, "还原完毕后停留完整文字");
  assert.notEqual(stripAnsi(buildDecodedText(target, "", 2700)), target, "下一轮重新打乱");
});

test("activity detail decodes while active and freezes when stalled", () => {
  const now = 10_000;
  const frame = {
    phase: "tool",
    tone: "active",
    icon: "⠹",
    label: "运行 bash",
    elapsed: "1s",
    detail: "pnpm test --filter provider",
    startedAt: now - 900,
  };
  assert.doesNotMatch(stripAnsi(buildActivityRow(frame, 80, undefined, now)), /--filter provider/);
  const stalled = { ...frame, tone: "stalled", idleText: "34s 无新进展" };
  assert.match(
    stripAnsi(buildActivityRow(stalled, 100, undefined, now)),
    /等待较久 · 34s 无新进展 · pnpm test --filter provider/,
  );
  const permission = { ...frame, phase: "permission", tone: "waiting" };
  assert.match(stripAnsi(buildActivityRow(permission, 80, undefined, now)), /pnpm test --filter/);
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
  assert.match(wide, /5 次工具调用/);

  // 窄屏按「工具次数 → 费用 → 类型检查」依次舍弃，始终保持单行。
  const medium = buildTurnSummary(full, 64);
  assert.doesNotMatch(medium, /次工具调用/);
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
