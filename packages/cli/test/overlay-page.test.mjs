import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_INSPECTOR_MIN_COLUMNS,
  CONTEXT_INSPECTOR_MIN_ROWS,
} from "../dist/context-inspector.js";
import { COST_LOG_MIN_COLUMNS, COST_LOG_MIN_ROWS } from "../dist/cost-log-page.js";
import {
  costLogHit,
  inspectorHit,
  patrolHit,
  requestDetailHit,
  resolveOverlayPage,
} from "../dist/overlay-page.js";
import { PATROL_PAGE_MIN_COLUMNS, PATROL_PAGE_MIN_ROWS } from "../dist/patrol-page.js";

/** 整页视图的纯渲染决策：选层、最小尺寸判定、帧几何 → 屏幕命中区域。 */
const AT = Date.parse("2024-01-02T03:04:05Z");

function detail(overrides = {}) {
  return {
    seq: 1,
    turn: 1,
    at: AT,
    model: "deepseek-chat",
    purpose: "主线回合",
    promptTokens: 1200,
    cachedPromptTokens: 0,
    completionTokens: 300,
    costCny: 0.001,
    offPeak: false,
    cacheReported: true,
    pricing: { inputPerMTokens: 2, outputPerMTokens: 8 },
    ...overrides,
  };
}

function inspectorState(overrides = {}) {
  return {
    groups: [
      {
        category: "system",
        label: "系统",
        tokens: 18000,
        items: [{ label: "系统提示词", tokens: 18000, detail: "你是 haji。" }],
      },
    ],
    categoryIndex: 0,
    selectedIndex: 0,
    scroll: 0,
    ...overrides,
  };
}

function costLogState(overrides = {}) {
  return {
    details: [detail({ seq: 1, turn: 1 }), detail({ seq: 2, turn: 1, costCny: 0.002 })],
    sort: "cost",
    selectedIndex: 0,
    ...overrides,
  };
}

test("没有打开的页面：不排帧、不算太小", () => {
  const page = resolveOverlayPage(undefined, undefined, 120, 40);
  assert.equal(page.rows, undefined);
  assert.equal(page.tooSmall, false);
  assert.equal(page.inspector, undefined);
  assert.equal(page.costLog, undefined);
});

test("上下文详情页：排出内容行并给出页面名", () => {
  const page = resolveOverlayPage(inspectorState(), undefined, 120, 40);
  assert.equal(page.pageName, "上下文详情页");
  assert.equal(page.tooSmall, false);
  assert.ok(Array.isArray(page.rows) && page.rows.length > 0);
  assert.equal(page.rows, page.inspector?.rows);
});

test("终端小于最小尺寸时只给一行说明所需的页面名", () => {
  const narrow = resolveOverlayPage(
    inspectorState(),
    undefined,
    CONTEXT_INSPECTOR_MIN_COLUMNS - 1,
    40,
  );
  assert.equal(narrow.tooSmall, true);
  assert.equal(narrow.pageName, "上下文详情页");

  const short = resolveOverlayPage(
    inspectorState(),
    undefined,
    120,
    CONTEXT_INSPECTOR_MIN_ROWS - 1,
  );
  assert.equal(short.tooSmall, true);
});

test("费用日志：列表 → 回合详情 → 请求详情逐层盖在上面", () => {
  const list = resolveOverlayPage(undefined, costLogState(), 120, 40);
  assert.equal(list.pageName, "费用日志页");
  assert.ok(list.costLog);
  assert.equal(list.turn, undefined);
  assert.equal(list.request, undefined);
  assert.equal(list.rows, list.costLog?.rows);

  const turn = resolveOverlayPage(
    undefined,
    costLogState({ turnDetail: { turn: 1, selectedIndex: 0 } }),
    120,
    40,
  );
  assert.equal(turn.pageName, "回合详情页");
  assert.ok(turn.turn);
  assert.equal(turn.request, undefined);
  assert.equal(turn.rows, turn.turn?.rows);

  const request = resolveOverlayPage(
    undefined,
    costLogState({ turnDetail: { turn: 1, selectedIndex: 0, openDetail: true } }),
    120,
    40,
  );
  assert.equal(request.pageName, "请求详情页");
  assert.ok(request.request);
  assert.equal(request.turn, undefined);
  // 列表帧仍会排出（原始实现同样如此），但详情页盖在上面，不参与命中表。
  assert.equal(request.rows, request.request?.rows);
});

test("费用页的最小尺寸按当前这一层判定", () => {
  const tooNarrowForList = resolveOverlayPage(
    undefined,
    costLogState(),
    COST_LOG_MIN_COLUMNS - 1,
    COST_LOG_MIN_ROWS,
  );
  assert.equal(tooNarrowForList.tooSmall, true);
  assert.equal(tooNarrowForList.pageName, "费用日志页");
});

test("上下文详情页命中区域：行号加对话区首行，列号转 1 基", () => {
  const page = resolveOverlayPage(inspectorState(), undefined, 120, 40);
  const frame = page.inspector;
  assert.ok(frame);
  const hit = inspectorHit(frame, 7);
  assert.equal(hit.listTop, 7 + frame.listTop);
  assert.equal(hit.listLeft, frame.listLeft + 1);
  assert.equal(hit.listOffset, frame.listOffset);
  assert.equal(hit.backRow, 7 + frame.back.row);
  assert.equal(hit.backLeft, frame.back.left + 1);
  // 上下文详情页每项占一行，命中表不带 itemHeight（导航侧按缺省 1 处理）。
  assert.equal(hit.itemHeight, undefined);
});

test("费用日志命中区域带上每项行数；请求详情页没有列表", () => {
  const listPage = resolveOverlayPage(undefined, costLogState(), 120, 40);
  assert.ok(listPage.costLog);
  const listHit = costLogHit(listPage.costLog, 3);
  assert.equal(listHit.itemHeight, listPage.costLog.itemHeight);
  assert.equal(listHit.listTop, 3 + listPage.costLog.listTop);

  const requestPage = resolveOverlayPage(
    undefined,
    costLogState({ turnDetail: { turn: 1, selectedIndex: 0, openDetail: true } }),
    120,
    40,
  );
  assert.ok(requestPage.request);
  const requestHit = requestDetailHit(requestPage.request, 3);
  assert.equal(requestHit.listHeight, 0);
  assert.equal(requestHit.listWidth, 0);
  assert.equal(requestHit.itemHeight, 1);
  assert.equal(requestHit.backRow, 3 + requestPage.request.back.row);
});

function patrolState(overrides = {}) {
  return {
    jobs: [
      {
        prNumber: 6,
        branch: "haji/x",
        targetBranch: "master",
        statusLabel: "审查中",
        terminal: false,
        headSha: "398d09d",
        fixRounds: 0,
        adjudicationRounds: 0,
        costCny: 0.01,
        taskBrief: "任务",
      },
    ],
    selectedIndex: 0,
    running: true,
    paused: false,
    repo: "owner/repo",
    ...overrides,
  };
}

test("巡检页：排出整屏内容并给出页面名，不干扰其它层", () => {
  const page = resolveOverlayPage(undefined, undefined, 120, 40, patrolState());
  assert.equal(page.pageName, "PR 巡检页");
  assert.equal(page.tooSmall, false);
  assert.ok(page.patrol);
  assert.equal(page.rows, page.patrol?.rows);
  assert.equal(page.inspector, undefined);
  assert.equal(page.costLog, undefined);
});

test("巡检页：终端小于最小尺寸时判太小，页面名仍是巡检页", () => {
  const narrow = resolveOverlayPage(
    undefined,
    undefined,
    PATROL_PAGE_MIN_COLUMNS - 1,
    40,
    patrolState(),
  );
  assert.equal(narrow.tooSmall, true);
  assert.equal(narrow.pageName, "PR 巡检页");

  const short = resolveOverlayPage(
    undefined,
    undefined,
    120,
    PATROL_PAGE_MIN_ROWS - 1,
    patrolState(),
  );
  assert.equal(short.tooSmall, true);
});

test("巡检页命中区域与费用列表页同构（行号加对话区首行、列号转 1 基）", () => {
  const page = resolveOverlayPage(undefined, undefined, 120, 40, patrolState());
  assert.ok(page.patrol);
  const hit = patrolHit(page.patrol, 7);
  assert.equal(hit.listTop, 7 + page.patrol.listTop);
  assert.equal(hit.listLeft, page.patrol.listLeft + 1);
  assert.equal(hit.listOffset, page.patrol.listOffset);
  assert.equal(hit.itemHeight, page.patrol.itemHeight);
  assert.equal(hit.backRow, 7 + page.patrol.back.row);
  assert.equal(hit.backLeft, page.patrol.back.left + 1);
});
