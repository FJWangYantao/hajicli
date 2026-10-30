import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPatrolFrame,
  PATROL_PAGE_MIN_COLUMNS,
  PATROL_PAGE_MIN_ROWS,
} from "../dist/patrol-page.js";
import { terminalWidth } from "../dist/terminal-text.js";

function job(overrides = {}) {
  return {
    prNumber: 6,
    branch: "haji/20261030-181119-cb5f",
    targetBranch: "master",
    statusLabel: "审查中",
    terminal: false,
    headSha: "398d09dabc",
    fixRounds: 1,
    adjudicationRounds: 0,
    costCny: 0.42,
    taskBrief: "侧栏巡检入口点进去能看",
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    jobs: [job(), job({ prNumber: 7, statusLabel: "已合并", terminal: true })],
    selectedIndex: 0,
    running: true,
    paused: false,
    repo: "FJWangYantao/hajicli",
    ...overrides,
  };
}

function stripAnsi(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 测试需要剥掉 SGR 序列再断言文案。
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("帧占满给定高度，每行宽度严格等于给定宽度", () => {
  const frame = buildPatrolFrame(state(), 120, 40);
  assert.equal(frame.rows.length, 40);
  for (const row of frame.rows) assert.equal(terminalWidth(row), 120);
  assert.equal(frame.itemHeight, 1);
  assert.equal(frame.listTop, 2);
  assert.equal(frame.listHeight, 35, "高度减掉顶框/列名/分隔/详情/底框");
});

test("顶栏写清巡检状态、任务数与仓库", () => {
  const running = stripAnsi(buildPatrolFrame(state(), 120, 40).rows[0]);
  assert.match(running, /PR 巡检/);
  assert.match(running, /运行中/);
  assert.match(running, /共 2 个任务/);
  assert.match(running, /FJWangYantao\/hajicli/);

  const idle = stripAnsi(buildPatrolFrame(state({ running: false }), 120, 40).rows[0]);
  assert.match(idle, /未运行/);

  const paused = stripAnsi(
    buildPatrolFrame(state({ running: true, paused: true }), 120, 40).rows[0],
  );
  assert.match(paused, /已暂停/);
});

test("选中行带 ▸，其余行不带；选中项的行内能看到 PR 号与费用", () => {
  const frame = buildPatrolFrame(state({ selectedIndex: 1 }), 120, 40);
  const first = stripAnsi(frame.rows[2]);
  const second = stripAnsi(frame.rows[3]);
  assert.doesNotMatch(first, /▸/);
  assert.match(second, /▸/);
  assert.match(second, /#7/);
  assert.match(second, /已合并/);
  assert.match(second, /¥0\.42/);
});

test("详情行给出选中任务的轮次、费用与任务简述", () => {
  const frame = buildPatrolFrame(state(), 120, 40);
  const detail = stripAnsi(frame.rows[frame.rows.length - 2]);
  assert.match(detail, /#6/);
  assert.match(detail, /修改 1 \/ 裁决 0/);
  assert.match(detail, /侧栏巡检入口点进去能看/);
});

test("终止原因与最近一次运行摘要出现在详情行", () => {
  const frame = buildPatrolFrame(
    state({
      jobs: [
        job({
          statusLabel: "已终止",
          terminal: true,
          terminatedReason: "超出费用上限",
          lastRun: "最近：审查完成",
        }),
      ],
    }),
    120,
    40,
  );
  const detail = stripAnsi(frame.rows[frame.rows.length - 2]);
  assert.match(detail, /终止原因：超出费用上限/);
  assert.match(detail, /最近：审查完成/);
});

test("空列表给出占位说明，不抛错", () => {
  const frame = buildPatrolFrame(state({ jobs: [] }), 120, 40);
  assert.equal(frame.rows.length, 40);
  const text = frame.rows.map(stripAnsi).join("\n");
  assert.match(text, /共 0 个任务/);
  assert.match(text, /暂无巡检任务/);
});

test("窄屏降级为 PR / 状态 / 费用三列", () => {
  const wide = stripAnsi(buildPatrolFrame(state(), 120, 40).rows[1]);
  assert.match(wide, /分支 → 目标/);
  const narrow = buildPatrolFrame(state(), 60, 24);
  const narrowHeader = stripAnsi(narrow.rows[1]);
  assert.doesNotMatch(narrowHeader, /分支 → 目标/);
  for (const row of narrow.rows) assert.equal(terminalWidth(row), 60);
  assert.match(stripAnsi(narrow.rows[2]), /#6/);
});

test("小于最小尺寸时按最小尺寸排版，不产生错行", () => {
  const frame = buildPatrolFrame(state(), 20, 4);
  assert.equal(terminalWidth(frame.rows[0]), PATROL_PAGE_MIN_COLUMNS);
  assert.equal(frame.rows.length, PATROL_PAGE_MIN_ROWS);
});

test("选中项滚出视野时列表跟着滚动，且回写夹紧后的下标", () => {
  const jobs = [0, 1, 2, 3, 4].map((index) => job({ prNumber: 10 + index }));
  const frame = buildPatrolFrame({ jobs, selectedIndex: 4, running: true, paused: false }, 120, 8);
  assert.equal(frame.listHeight, 3);
  assert.equal(frame.listOffset, 2);
  assert.equal(frame.selectedIndex, 4);
  const visible = frame.rows.slice(frame.listTop, frame.listTop + frame.listHeight).map(stripAnsi);
  assert.match(visible[visible.length - 1], /#14/);

  const clamped = buildPatrolFrame(
    { jobs, selectedIndex: 99, running: false, paused: false },
    120,
    8,
  );
  assert.equal(clamped.selectedIndex, 4);
});

test("顶栏「Esc 返回」的命中矩形落在按钮上", () => {
  const frame = buildPatrolFrame(state(), 120, 40);
  const title = stripAnsi(frame.rows[0]);
  assert.match(title, /\[Esc 返回\]/);
  assert.equal(frame.back.row, 0);
  const start = title.indexOf("[Esc 返回]");
  // 顶栏含中文（双宽字符），字符下标不等于屏幕列，换算成显示列再比。
  const startColumn = terminalWidth(title.slice(0, start));
  const endColumn = terminalWidth(title.slice(0, start + "[Esc 返回]".length));
  assert.ok(frame.back.left <= startColumn, "命中区左边界不晚于按钮起点");
  assert.ok(frame.back.left + frame.back.width >= endColumn, "命中区覆盖按钮");
});

test("窄屏顶栏换成短按钮文案，命中矩形同步收窄", () => {
  const frame = buildPatrolFrame(state(), 60, 24);
  const title = stripAnsi(frame.rows[0]);
  assert.match(title, /\[返回\]/);
  assert.doesNotMatch(title, /\[Esc 返回\]/);
  const start = title.indexOf("[返回]");
  const startColumn = terminalWidth(title.slice(0, start));
  const endColumn = terminalWidth(title.slice(0, start + "[返回]".length));
  assert.ok(frame.back.left <= startColumn);
  assert.ok(frame.back.left + frame.back.width >= endColumn);
});
