import assert from "node:assert/strict";
import test from "node:test";

import { TerminalUI } from "../dist/terminal-input.js";

function createTerminalUI() {
  const ui = new TerminalUI({
    header: "",
    compactHeader: "",
    inputPrompt: "> ",
    renderBorder: (width) => "-".repeat(width),
  });
  // TypeScript private 字段在运行时仍是普通属性：用它们绕过真实终端。
  ui.interactive = true;
  return ui;
}

function stopScheduledRender(ui) {
  if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
  ui.streamRenderTimer = null;
  ui.renderScheduled = false;
}

const SAMPLE_IMAGE = {
  path: ".haji/attachments/paste-20260101-120000-000.png",
  displayName: "paste-20260101-120000-000.png",
  bytes: 1_024,
};

test("Ctrl+V 触发剪贴板取图并暂存为本轮图片", async () => {
  const ui = createTerminalUI();
  const pending = ui.readInput({});
  let captures = 0;
  ui.captureClipboardAttachment = async () => {
    captures += 1;
    ui.pendingImages = [SAMPLE_IMAGE];
  };

  ui.dispatchKeypress("v", { name: "v", ctrl: true });

  assert.equal(captures, 1);
  assert.equal(ui.activeInput.graphemes.join(""), "", "粘贴图片不应把 v 插入输入框");
  assert.deepEqual(ui.takePendingImages(), [SAMPLE_IMAGE]);

  ui.finishInput();
  assert.equal(await pending, "");
  stopScheduledRender(ui);
});

test("Alt+V 仍然可用，普通 v 只当作字符输入", async () => {
  const ui = createTerminalUI();
  const pending = ui.readInput({});
  let captures = 0;
  ui.captureClipboardAttachment = async () => {
    captures += 1;
  };

  ui.dispatchKeypress("v", { name: "v" });
  assert.equal(captures, 0, "普通 v 不应取图");
  assert.equal(ui.activeInput.graphemes.join(""), "v");

  ui.dispatchKeypress("v", { name: "v", meta: true });
  assert.equal(captures, 1);

  ui.finishInput();
  await pending;
  stopScheduledRender(ui);
});

test("输入框上方的 chip 行显示图片文件名，且排在文字输入行之前", async () => {
  const ui = createTerminalUI();
  const pending = ui.readInput({});
  ui.pendingImages = [SAMPLE_IMAGE];

  const rows = ui.buildPastedImageRows(80);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /paste-20260101-120000-000\.png/);

  ui.finishInput();
  await pending;
  stopScheduledRender(ui);
});

test("输入为空时 Backspace 摘掉最后一张图片", async () => {
  const ui = createTerminalUI();
  const second = {
    ...SAMPLE_IMAGE,
    path: ".haji/attachments/paste-2.png",
    displayName: "paste-2.png",
  };
  const pending = ui.readInput({});
  ui.pendingImages = [SAMPLE_IMAGE, second];

  ui.dispatchKeypress("", { name: "backspace" });
  assert.deepEqual(
    ui.pendingImages.map((image) => image.displayName),
    [SAMPLE_IMAGE.displayName],
  );

  ui.dispatchKeypress("", { name: "backspace" });
  assert.deepEqual(ui.pendingImages, []);

  ui.dispatchKeypress("", { name: "backspace" });
  assert.deepEqual(ui.pendingImages, [], "没有图片时 Backspace 不应报错");

  ui.finishInput();
  await pending;
  stopScheduledRender(ui);
});

test("takePendingImages 取走后缓冲清空，不会重复发送同一张图", async () => {
  const ui = createTerminalUI();
  ui.pendingImages = [SAMPLE_IMAGE];

  assert.deepEqual(ui.takePendingImages(), [SAMPLE_IMAGE]);
  assert.deepEqual(ui.takePendingImages(), []);
  stopScheduledRender(ui);
});

test("新一轮输入开始时清空上一轮残留的图片", async () => {
  const ui = createTerminalUI();
  ui.pendingImages = [SAMPLE_IMAGE];

  const pending = ui.readInput({});
  assert.deepEqual(ui.takePendingImages(), []);

  ui.finishInput();
  await pending;
  stopScheduledRender(ui);
});

test("取消输入会丢弃已暂存的粘贴图片", async () => {
  const ui = createTerminalUI();
  const pending = ui.readInput({});
  pending.catch(() => {});
  ui.pendingImages = [SAMPLE_IMAGE];

  assert.equal(ui.cancelInput(), "");
  assert.deepEqual(ui.takePendingImages(), []);
  stopScheduledRender(ui);
});

test("没有活动输入时 Ctrl+V 不会触发取图", () => {
  const ui = createTerminalUI();
  let captures = 0;
  ui.captureClipboardAttachment = async () => {
    captures += 1;
  };

  ui.dispatchKeypress("v", { name: "v", ctrl: true });

  assert.equal(captures, 0);
  assert.deepEqual(ui.pendingImages, []);
  stopScheduledRender(ui);
});
