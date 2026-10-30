import assert from "node:assert/strict";
import test from "node:test";

import {
  costLogKeyCommand,
  costLogLayer,
  enterTurnDetail,
  inspectorKeyCommand,
  moveCostLogSelection,
  moveInspectorCategory,
  moveInspectorItem,
  movePatrolSelection,
  overlayClickTarget,
  patrolKeyCommand,
  scrollInspector,
  selectCostLogItem,
  selectPatrolItem,
} from "../dist/overlay-navigation.js";

/** 覆盖页导航的纯状态转移（TerminalUI 只负责持有状态与重绘）。 */
const detail = (seq, turn) => ({
  seq,
  turn,
  at: seq,
  model: "m",
  purpose: "主线回合",
  promptTokens: 100 * seq,
  cachedPromptTokens: 0,
  completionTokens: 10,
  costCny: seq,
  offPeak: false,
});

test("点击换算：返回按钮、两行一项的列表、越界", () => {
  const hit = {
    listTop: 5,
    listHeight: 6,
    listLeft: 3,
    listWidth: 40,
    listOffset: 10,
    itemHeight: 2,
    backRow: 2,
    backLeft: 3,
    backWidth: 8,
  };
  assert.equal(overlayClickTarget(hit, 4, 2), "back");
  assert.equal(overlayClickTarget(hit, 4, 5), 10);
  assert.equal(overlayClickTarget(hit, 4, 6), 10);
  assert.equal(overlayClickTarget(hit, 4, 7), 11);
  assert.equal(overlayClickTarget(hit, 4, 11), undefined);
  assert.equal(overlayClickTarget(hit, 50, 5), undefined);
});

test("上下文详情页：条目/分类/滚动在边界停住，换分类归零", () => {
  const state = {
    groups: [
      { label: "a", tokens: 1, items: [{}, {}] },
      { label: "b", tokens: 2, items: [{}] },
    ],
    categoryIndex: 0,
    selectedIndex: 0,
    scroll: 3,
  };
  assert.equal(moveInspectorItem(state, 1), true);
  assert.equal(state.scroll, 0);
  assert.equal(moveInspectorItem(state, 1), false);
  assert.equal(scrollInspector(state, 8, 5), true);
  assert.equal(state.scroll, 5);
  assert.equal(moveInspectorCategory(state, 1), true);
  assert.deepEqual([state.categoryIndex, state.selectedIndex, state.scroll], [1, 0, 0]);
  assert.equal(moveInspectorCategory(state, 1), false);
  assert.deepEqual(inspectorKeyCommand({ name: "end", ctrl: true }, 7), {
    type: "scroll",
    delta: 7,
  });
  assert.equal(inspectorKeyCommand({ name: "end" }, 7), undefined);
  assert.equal(inspectorKeyCommand({ name: "a" }, 7), undefined);
});

test("费用日志：列表 → 回合详情逐层进退，Enter 有输入时交还输入框", () => {
  const state = {
    details: [detail(1, 1), detail(2, 1), detail(3, 0)],
    sort: "cost",
    selectedIndex: 0,
  };
  assert.equal(costLogLayer(state), "list");
  assert.equal(costLogKeyCommand(state, { name: "return" }, true), undefined);
  assert.deepEqual(costLogKeyCommand(state, { name: "return" }, false), { type: "enter" });
  assert.equal(costLogKeyCommand(state, { name: "left" }, false), undefined);

  // 按花费排序第一条是 seq 3（没有轮次）：打不开并给提示。
  assert.deepEqual(enterTurnDetail(state), {
    ok: false,
    hint: "这条记录没有轮次信息（老会话未分轮）",
  });
  assert.equal(moveCostLogSelection(state, 1), true);
  assert.deepEqual(enterTurnDetail(state), { ok: true });
  assert.equal(costLogLayer(state), "turn");
  // 回合 1 按序是 seq 1、2；列表选中的是 seq 2。
  assert.equal(state.turnDetail.selectedIndex, 1);
  assert.deepEqual(costLogKeyCommand(state, { name: "left" }, false), { type: "move", delta: -1 });
  assert.equal(moveCostLogSelection(state, -1), true);
  assert.equal(state.turnDetail.selectedIndex, 0);
  assert.equal(selectCostLogItem(state, 5), false);
  state.turnDetail.openDetail = true;
  assert.equal(costLogLayer(state), "request");
  assert.deepEqual(costLogKeyCommand(state, { name: "enter" }, false), { type: "consume" });
});

test("巡检页：键命令只接管导航键，Esc 走返回", () => {
  assert.deepEqual(patrolKeyCommand({ name: "escape" }), { type: "back" });
  assert.deepEqual(patrolKeyCommand({ name: "up" }), { type: "move", delta: -1 });
  assert.deepEqual(patrolKeyCommand({ name: "down" }), { type: "move", delta: 1 });
  assert.equal(patrolKeyCommand({ name: "home" }), undefined, "非 Ctrl+Home 不接管");
  assert.equal(patrolKeyCommand({ name: "x" }), undefined);
  assert.equal(patrolKeyCommand({ name: "return" }), undefined, "巡检页没有下一层");
});

test("巡检页：选中项移动与点击都夹紧在有效范围", () => {
  const state = { jobs: [{ prNumber: 6 }, { prNumber: 7 }, { prNumber: 8 }], selectedIndex: 0 };
  assert.equal(movePatrolSelection(state, 1), true);
  assert.equal(state.selectedIndex, 1);
  assert.equal(movePatrolSelection(state, 99), true);
  assert.equal(state.selectedIndex, 2, "越过末尾夹到最后一个");
  assert.equal(movePatrolSelection(state, 1), false, "已在末尾不再变化");
  assert.equal(movePatrolSelection(state, -99), true);
  assert.equal(state.selectedIndex, 0);
  assert.equal(movePatrolSelection(state, 0), false);

  assert.equal(selectPatrolItem(state, 2), true);
  assert.equal(state.selectedIndex, 2);
  assert.equal(selectPatrolItem(state, 2), false, "点同一条不算变化");
  assert.equal(selectPatrolItem(state, 9), false, "越界点击忽略");

  const empty = { jobs: [], selectedIndex: 0 };
  assert.equal(movePatrolSelection(empty, 1), false);
  assert.equal(empty.selectedIndex, 0);
});
