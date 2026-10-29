import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../../core/dist/index.js";
import { takeQueuedSteer } from "../dist/steering.js";
import { TerminalUI } from "../dist/terminal-input.js";
import { recoveryCalls, recoveryHarness } from "./helpers/recovery-harness.mjs";

function createUI() {
  const ui = new TerminalUI({
    header: "test",
    compactHeader: "test",
    inputPrompt: "> ",
    continuationPrompt: "  ",
    renderBorder: () => "",
  });
  ui.interactive = true;
  ui.started = false;
  return ui;
}

test("队列默认保留，逐条 steer 按钮点击正确消息且不重复发送", () => {
  const ui = createUI();
  const queue = ["先检查", "不要修改", "/compact"];
  const steers = [];
  ui.setQueue(queue);
  ui.setSteerEnabled(true);
  ui.onQueueSteer((index, text) => {
    const item = takeQueuedSteer(queue, index, text);
    if (item === undefined) return false;
    steers.push(item);
    return true;
  });
  const rows = ui.getQueueRows(50, 3);
  assert.match(rows[1], /\[steer\]/);
  assert.doesNotMatch(rows[3], /\[steer\]/);
  ui.updateQueueSteerHits(rows, 10);
  assert.equal(queue.length, 3);
  ui.handleLeftButtonDown({ column: 3, row: 12 });
  ui.handleLeftButtonUp({ column: 3, row: 12 });
  assert.deepEqual(steers, ["不要修改"]);
  assert.deepEqual(queue, ["先检查", "/compact"]);
  ui.handleLeftButtonUp({ column: 3, row: 12 });
  assert.equal(steers.length, 1);
});

test("拖出、队列移位、禁用及斜杠命令不误触；管理列表支持 steer", () => {
  const ui = createUI();
  const queue = ["甲", "乙"];
  ui.setQueue(queue);
  ui.setSteerEnabled(true);
  let calls = 0;
  ui.onQueueSteer((index, text) => {
    calls++;
    return takeQueuedSteer(queue, index, text) !== undefined;
  });
  ui.updateQueueSteerHits(ui.getQueueRows(30, 2), 1);
  ui.handleLeftButtonDown({ column: 3, row: 2 });
  ui.handleLeftButtonUp({ column: 20, row: 2 });
  assert.equal(calls, 0);
  ui.handleLeftButtonDown({ column: 3, row: 2 });
  queue.shift();
  ui.setQueue(queue);
  ui.handleLeftButtonUp({ column: 3, row: 2 });
  assert.equal(calls, 0);
  assert.equal(takeQueuedSteer(["/compact"], 0, "/compact"), undefined);
  ui.inputManager = { kind: "queue", selected: 0 };
  ui.handleInputManagerKey("s", {});
  assert.equal(calls, 1);
  assert.equal(queue.length, 0);
  ui.setSteerEnabled(false);
  assert.equal(ui.queueSteerHits.length, 0);
});

test("不同窗口尺寸的真实渲染按钮命中与屏幕坐标一致", () => {
  const stdout = process.stdout;
  const descriptors = Object.fromEntries(
    ["columns", "rows", "write"].map((key) => [key, Object.getOwnPropertyDescriptor(stdout, key)]),
  );
  try {
    Object.defineProperty(stdout, "write", { configurable: true, value: () => true });
    for (const [columns, height] of [
      [20, 8],
      [40, 12],
      [80, 24],
      [120, 40],
    ]) {
      Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
      Object.defineProperty(stdout, "rows", { configurable: true, value: height });
      const ui = createUI();
      const queue = ["中文消息", "second", "third", "fourth"];
      ui.setQueue(queue);
      ui.setSteerEnabled(true);
      ui.onQueueSteer((index, text) => takeQueuedSteer(queue, index, text) !== undefined);
      ui.started = true;
      ui.startupHeaderVisible = false;
      ui.chatContent = "正在工作";
      ui.renderFrame();
      assert.ok(ui.queueSteerHits.length > 0, `${columns}x${height}`);
      for (const hit of ui.queueSteerHits) {
        const row = ui.renderedScreenRows[hit.row - 1].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        assert.equal(row.slice(hit.left - 1, hit.right), "[steer]");
      }
      const hit = ui.queueSteerHits[0];
      ui.handleLeftButtonDown({ column: hit.left, row: hit.row });
      ui.handleLeftButtonUp({ column: hit.left, row: hit.row });
      assert.equal(queue.length, 3);
      ui.started = false;
      if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
      if (ui.transientHintTimer) clearTimeout(ui.transientHintTimer);
    }
  } finally {
    for (const key of ["columns", "rows", "write"]) {
      if (descriptors[key]) Object.defineProperty(stdout, key, descriptors[key]);
      else delete stdout[key];
    }
  }
});

for (const when of ["stream", "tool", "text", "failure", "abort"]) {
  test(`steer 在 ${when} 安全点处理并持久化，未开始的工具跳过且配对完整`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-steer-"));
    const manager = new SessionManager(dir);
    let harness;
    let requests = 0;
    let executions = 0;
    let abortTurn;
    const provider = {
      async *completeStream(messages, options) {
        options.onRequestStart?.();
        requests++;
        if (requests === 1) {
          if (when !== "tool") harness.deps.steeringInputs.push("先别修改，只检查");
          if (when === "failure") throw new Error("network failure");
          if (when === "abort") {
            abortTurn();
            throw new Error("aborted");
          }
          if (when !== "text") options.onToolCall?.(recoveryCalls);
          options.onFinish?.({ reason: when === "text" ? "stop" : "tool_calls" });
          yield when === "text" ? "旧回复" : "";
        } else {
          assert.equal(messages.at(-1).content, "先别修改，只检查");
          options.onFinish?.({ reason: "stop" });
          yield "已按补充指令处理";
        }
      },
    };
    harness = recoveryHarness(manager, provider, async () => {
      executions++;
      harness.deps.steeringInputs.push("先别修改，只检查");
      return { output: "done", duration: 1 };
    });
    harness.deps.steeringInputs = [];
    harness.deps.ui.onEsc = (callback) => {
      abortTurn = callback;
    };
    try {
      await harness.run();
      if (when === "failure" || when === "abort") {
        assert.deepEqual(harness.deps.pendingInputs, ["先别修改，只检查"]);
        assert.equal(requests, 1);
      } else {
        assert.equal(requests, 2);
        assert.equal(executions, when === "tool" ? 1 : 0);
        const messages = harness.messages();
        const results = messages.filter((message) => message.role === "tool");
        assert.equal(results.length, when === "text" ? 0 : 2);
        if (when !== "text") assert.match(results.at(-1).content, /steer/);
        const restored = new SessionManager(dir);
        assert.equal(
          restored.loadSession(manager.getCurrentSession().id)?.id,
          manager.getCurrentSession().id,
        );
        assert.ok(
          restored
            .getCurrentSession()
            .messages.some((m) => m.role === "user" && m.content === "先别修改，只检查"),
        );
      }
      assert.deepEqual(harness.deps.steeringInputs, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
