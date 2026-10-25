import assert from "node:assert/strict";
import test from "node:test";
import { TerminalInputBusyError, TerminalUI } from "../dist/terminal-input.js";

/**
 * 回归用例：回合刚结束时后台流程（如未定价模型提示）会打开选择器，而主循环紧接着
 * 就要 readInput。两者互斥时必须是可识别的 TerminalInputBusyError + waitForInputIdle，
 * 而不是让「已有输入请求正在等待处理」一路抛出把整场会话崩掉。
 */
function createUI() {
  const ui = new TerminalUI({
    header: "HAJI TERMINAL",
    compactHeader: "HAJI",
    inputPrompt: "> ",
    continuationPrompt: "  ",
    renderBorder: (width) => "-".repeat(width),
  });
  // 不进备屏、不起渲染定时器：只验证输入行占用状态机。
  ui.interactive = true;
  ui.started = false;
  return ui;
}

function fakeInput(overrides = {}) {
  return {
    prompt: "> ",
    continuationPrompt: "  ",
    graphemes: [..."draft"],
    cursorIndex: 5,
    sensitive: false,
    slashCommands: [],
    selectedCommandIndex: 0,
    historyNavigationActive: false,
    resolve() {},
    reject() {},
    ...overrides,
  };
}

function fakeSelection(overrides = {}) {
  return {
    options: { title: "t", items: [{ value: "a", label: "a" }] },
    openedAt: 0,
    selectedIndex: 0,
    secondaryIndex: 0,
    resolve() {},
    reject() {},
    ...overrides,
  };
}

test("占用中的输入行拒绝第二次读取，且错误类型可识别", async () => {
  const ui = createUI();
  ui.activeSelection = fakeSelection();
  await assert.rejects(
    () => ui.readInput({}),
    (error) => error instanceof TerminalInputBusyError,
  );
  // 选择器占着时，readSelection 也一样要拒绝，避免两个选择器叠在一起。
  await assert.rejects(
    () => ui.readSelection({ title: "t", items: [{ value: "a", label: "a" }] }),
    (error) => error instanceof TerminalInputBusyError,
  );
});

test("waitForInputIdle 在选择器收尾后才放行", async () => {
  const ui = createUI();
  let resolvedValue;
  ui.activeSelection = fakeSelection({
    resolve(value) {
      resolvedValue = value;
    },
  });

  let idle = false;
  const waiting = ui.waitForInputIdle().then(() => {
    idle = true;
  });
  await Promise.resolve();
  assert.equal(idle, false, "选择器还在等用户选，不能提前放行");

  ui.finishSelection();
  await waiting;
  assert.equal(idle, true);
  assert.deepEqual(resolvedValue, { value: "a", secondaryValue: undefined });
  assert.equal(ui.activeSelection, undefined);
});

test("waitForInputIdle 在输入请求收尾后才放行", async () => {
  const ui = createUI();
  let resolvedValue;
  ui.activeInput = fakeInput({
    resolve(value) {
      resolvedValue = value;
    },
  });

  let idle = false;
  const waiting = ui.waitForInputIdle().then(() => {
    idle = true;
  });
  await Promise.resolve();
  assert.equal(idle, false);

  ui.finishInput();
  await waiting;
  assert.equal(idle, true);
  assert.equal(resolvedValue, "draft");
});

test("已经空闲时 waitForInputIdle 立刻放行", async () => {
  const ui = createUI();
  let idle = false;
  await ui.waitForInputIdle().then(() => {
    idle = true;
  });
  assert.equal(idle, true);
});

test("输入行空闲后读取恢复正常", async () => {
  const ui = createUI();
  ui.activeSelection = fakeSelection();
  await assert.rejects(() => ui.readInput({}), TerminalInputBusyError);
  ui.finishSelection();
  const pending = ui.readInput({});
  assert.ok(ui.isInputActive(), "没有占用后应立刻拿到输入行");
  ui.finishInput();
  assert.equal(await pending, "");
});
