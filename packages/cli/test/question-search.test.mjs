import assert from "node:assert/strict";
import test from "node:test";
import { AskQuestionTool } from "../../plugins/dist/index.js";
import { TerminalInputCancelledError, TerminalUI } from "../dist/terminal-input.js";
import { askUserQuestion } from "../dist/user-question.js";

function createUI() {
  const ui = new TerminalUI({
    header: "test",
    compactHeader: "test",
    inputPrompt: "> ",
    continuationPrompt: "  ",
    renderBorder: (width) => "-".repeat(width),
  });
  ui.interactive = true;
  ui.started = false;
  return ui;
}
test("终端提问支持选项、自填、文字输入、取消及恢复草稿", async () => {
  for (const mode of ["option", "custom", "text", "cancel", "abort"]) {
    const ui = createUI();
    let restored;
    ui.activeInput = { graphemes: [..."草稿"], reject() {} };
    const host = {
      ui,
      notify() {},
      blocked() {},
      resume(draft) {
        restored = draft;
      },
    };
    const controller = new AbortController();
    const result = askUserQuestion(
      host,
      { question: "你的选择？", ...(mode === "text" ? {} : { options: ["甲", "乙"] }) },
      { abortSignal: controller.signal },
    );
    if (mode === "abort") controller.abort();
    else if (mode === "cancel") ui.cancelSelection();
    else {
      if (mode !== "text") {
        ui.activeSelection.selectedIndex = mode === "custom" ? 2 : 1;
        ui.handleSelectionKeypress("\r", { name: "return" });
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (mode === "custom" || mode === "text") {
        ui.activeInput.graphemes = [..."我的回答"];
        ui.finishInput();
      }
    }
    assert.deepEqual(
      await result,
      mode === "cancel" || mode === "abort"
        ? { status: "cancelled" }
        : { status: "answered", answer: mode === "option" ? "乙" : "我的回答" },
    );
    assert.equal(restored, "草稿");
    assert.equal(ui.activeSelection, undefined);
    assert.equal(ui.activeInput, undefined);
  }
  const ui = createUI();
  ui.interactive = false;
  assert.deepEqual(await askUserQuestion({ ui }, { question: "x" }), { status: "unavailable" });
});

const items = [
  { value: "deepseek", label: "DeepSeek", description: "快速" },
  { value: "claude", label: "Claude", description: "Anthropic" },
  { value: "gpt", label: "GPT", description: "OpenAI" },
];

test("askquestion 校验输入并回传真实答案与取消状态", async () => {
  const calls = [];
  const tool = new AskQuestionTool(async (question) => {
    calls.push(question);
    return { status: "answered", answer: "自填答案" };
  });
  assert.deepEqual(
    JSON.parse(await tool.execute({ question: " 选哪个？ ", options: ["甲", "乙"] })),
    { status: "answered", answer: "自填答案" },
  );
  assert.deepEqual(calls[0], { question: "选哪个？", options: ["甲", "乙"] });
  for (const args of [
    { question: "" },
    { question: "x", options: ["a"] },
    { question: "x", options: ["a", " a "] },
  ]) {
    assert.match(await tool.execute(args), /^错误:/);
  }
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    JSON.parse(await tool.execute({ question: "x" }, { abortSignal: controller.signal })).status,
    "cancelled",
  );
  assert.equal(calls.length, 1);
  for (const status of ["cancelled", "unavailable"]) {
    const unavailable = new AskQuestionTool(async () => ({ status }));
    assert.deepEqual(JSON.parse(await unavailable.execute({ question: "x" })), { status });
  }
});

test("模型搜索大小写、描述匹配、筛选后确认并保留思考强度", async () => {
  const ui = createUI();
  const result = ui.readSelection({
    title: "模型",
    searchable: true,
    items,
    selectedValue: "gpt",
    secondary: {
      label: "思考",
      items: [
        { value: "low", label: "low" },
        { value: "high", label: "high" },
      ],
    },
  });
  ui.handleSelectionKeypress("ANTHROPIC", {});
  assert.equal(ui.activeSelection.selectedIndex, 0);
  assert.match(ui.getSelectionRows(100, 10).join("\n"), /Claude/);
  assert.doesNotMatch(ui.getSelectionRows(100, 10).join("\n"), /DeepSeek/);
  ui.handleSelectionKeypress("", { name: "right" });
  ui.handleSelectionKeypress("\r", { name: "return" });
  assert.deepEqual(await result, { value: "claude", secondaryValue: "high" });
});

test("无匹配禁止确认与导航；退格恢复；Esc 取消", async () => {
  const ui = createUI();
  const result = ui.readSelection({ title: "模型", searchable: true, items });
  ui.handleSelectionKeypress("Z", {});
  ui.handleSelectionKeypress("", { name: "down" });
  ui.handleSelectionKeypress("\r", { name: "return" });
  assert.ok(ui.activeSelection);
  assert.equal(ui.activeSelection.selectedIndex, 0);
  assert.match(ui.getSelectionRows(100, 10).join("\n"), /没有匹配/);
  ui.handleSelectionKeypress("", { name: "backspace" });
  ui.handleSelectionKeypress("DEEP", {});
  ui.handleSelectionKeypress("\r", { name: "return" });
  assert.equal((await result).value, "deepseek");
  const cancelled = ui.readSelection({ title: "模型", searchable: true, items });
  ui.handleSelectionKeypress("", { name: "escape" });
  await assert.rejects(cancelled, TerminalInputCancelledError);
});

test("未开启搜索的卡片保持热键；取消选择器释放输入行", async () => {
  const ui = createUI();
  const result = ui.readSelection({
    title: "授权",
    items: [{ value: "yes", label: "允许", hotkey: "y" }],
  });
  ui.handleSelectionKeypress("y", {});
  assert.equal((await result).value, "yes");
  const cancelled = ui.readSelection({ title: "问题", items });
  ui.cancelSelection();
  await assert.rejects(cancelled, TerminalInputCancelledError);
  await ui.waitForInputIdle();
});
