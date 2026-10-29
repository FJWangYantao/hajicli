import assert from "node:assert/strict";
import test from "node:test";

import {
  applySelectionKey,
  buildSelectionRows,
  filterSelectionItems,
} from "../dist/selection-picker.js";

// 去掉 ANSI 颜色再断言。
const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));

const card = (overrides = {}) => ({
  options: {
    title: "需要授权",
    items: [
      { value: "once", label: "仅本次允许", hotkey: "y" },
      { value: "always", label: "永久允许", hotkey: "a" },
      { value: "deny", label: "拒绝", hotkey: "n" },
    ],
    secondary: {
      label: "作用域",
      items: [
        { value: "project", label: "本项目" },
        { value: "user", label: "全局" },
      ],
    },
    ...overrides.options,
  },
  selectedIndex: 0,
  secondaryIndex: 0,
  ...overrides.state,
});

test("方向键循环选中项与次级轴，Tab / Shift+Tab 只动次级轴", () => {
  const state = card();
  assert.equal(applySelectionKey(state, "", { name: "up" }), "changed");
  assert.equal(state.selectedIndex, 2, "从第一项往上回绕到最后一项");
  assert.equal(applySelectionKey(state, "", { name: "right" }), "changed");
  assert.equal(state.secondaryIndex, 1);
  applySelectionKey(state, "\t", { name: "tab" });
  assert.equal(state.secondaryIndex, 0);
  applySelectionKey(state, "\x1b[Z", { name: "tab", shift: true });
  assert.equal(state.secondaryIndex, 1);
  assert.equal(state.selectedIndex, 2);
});

test("热键直接确认；确认冷却期内回车与热键都被忽略", () => {
  const state = card();
  assert.equal(applySelectionKey(state, "n", { name: "n" }), "confirm");
  assert.equal(state.selectedIndex, 2);

  const locked = card({ options: { confirmDelayMs: 500 }, state: { openedAt: 1000 } });
  assert.equal(applySelectionKey(locked, "\r", { name: "return" }, 1200), "none");
  assert.equal(applySelectionKey(locked, "y", { name: "y" }, 1200), "none");
  assert.equal(locked.selectedIndex, 0);
  assert.equal(applySelectionKey(locked, "\r", { name: "return" }, 1600), "confirm");
});

test("Ctrl+C / Esc / 翻页交给调用方落地", () => {
  const state = card();
  assert.equal(applySelectionKey(state, "\x03", { name: "c", ctrl: true }), "ctrl-c");
  assert.equal(applySelectionKey(state, "", { name: "escape" }), "escape");
  assert.equal(applySelectionKey(state, "", { name: "pageup" }), "page-up");
  assert.equal(applySelectionKey(state, "", { name: "pagedown" }), "page-down");
  assert.equal(applySelectionKey(state, "", { name: "end", ctrl: true }), "jump-end");
});

test("可搜索列表：输入过滤并重置选中，退格按字形删除，无匹配时方向键不动", () => {
  const state = {
    options: {
      title: "选择模型",
      searchable: true,
      items: [
        { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
        { value: "glm-5.2", label: "GLM 5.2", description: "火山方舟" },
      ],
    },
    selectedIndex: 1,
    secondaryIndex: 0,
  };
  applySelectionKey(state, "火", {});
  applySelectionKey(state, "山", {});
  assert.equal(state.query, "火山");
  assert.equal(state.selectedIndex, 0);
  assert.deepEqual(
    filterSelectionItems(state).map((item) => item.value),
    ["glm-5.2"],
  );
  applySelectionKey(state, "", { name: "backspace" });
  assert.equal(state.query, "火");
  state.query = "不存在";
  assert.equal(applySelectionKey(state, "", { name: "down" }), "none");
  assert.match(plain(buildSelectionRows(state, 60, 10)).join("\n"), /没有匹配的选项/);
});

test("buildSelectionRows：次级轴放不下时只显示当前值，预览超高时注明剩余行数", () => {
  const narrow = plain(buildSelectionRows(card(), 20, 10));
  assert.ok(
    narrow.some((row) => row.includes("‹ 本项目 ›")),
    "窄宽度退化成单值",
  );

  const withPreview = card({
    options: { preview: Array.from({ length: 10 }, (_, i) => `预览 ${i}`) },
  });
  const rows = plain(buildSelectionRows(withPreview, 60, 8));
  assert.equal(rows.length, 8);
  assert.ok(
    rows.some((row) => row.includes("另有")),
    "预览被截断时提示剩余行数",
  );
  assert.ok(rows.at(-1).includes("拒绝") || rows.some((row) => row.includes("仅本次允许")));
  assert.deepEqual(buildSelectionRows(card(), 60, 0), []);
});
