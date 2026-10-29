import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TerminalUI } from "../dist/terminal-input.js";
import { cellAtColumn, wrapAnsi } from "../dist/terminal-text.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value) => value.replace(ANSI_RE, "");

/** 造一个头部合法的 PNG：内联链路只读签名与尺寸，不校验像素。 */
function fakePng(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function createTerminalUI() {
  const ui = new TerminalUI({
    header: "",
    compactHeader: "",
    inputPrompt: "> ",
    renderBorder: (width) => "-".repeat(width),
  });
  ui.interactive = true;
  return ui;
}

/** 收尾帧定时器随同步层搬到了 inline-image-sync.ts，测试直接改它的内部状态。 */
function stopScheduledRender(ui) {
  if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
  if (ui.inlineImages.settleTimer) clearTimeout(ui.inlineImages.settleTimer);
  ui.streamRenderTimer = null;
  ui.inlineImages.settleTimer = null;
  ui.renderScheduled = false;
}

/** 滚动微调节流以真实时钟计时：把上次放置时间拨回过去，模拟间隔已过。 */
function rewindNudgeWindow(ui) {
  ui.inlineImages.lastPlaceAt -= 1_000;
}

function withEnv(overrides, run) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("appendInlineImage：封口尾部、追加图片段（kitty 场景含占位行）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-inline-ui-"));
  try {
    const pngPath = path.join(dir, "shot.png");
    fs.writeFileSync(pngPath, fakePng(1440, 757));
    const ui = createTerminalUI();

    const result = withEnv({ HAJI_IMAGE_PROTOCOL: "kitty" }, () => ui.appendInlineImage(pngPath));
    assert.deepEqual(result, { ok: true });
    assert.equal(ui.chatContent, "", "图片段入列后尾部必须清空");

    const segment = ui.sealedSegments.at(-1);
    assert.equal(segment.kind, "image");
    assert.equal(segment.image.desc.protocol, "kitty");
    assert.ok(segment.image.desc.png.length > 0, "kitty 场景应带上 PNG 数据");
    assert.equal(segment.image.uploaded, false, "数据尚未上传终端");
    assert.equal(segment.image.placed, undefined, "placement 尚未放置");

    const rows = ui.getSealedRows(100);
    const count = segment.rows.length;
    assert.equal(rows.length, count, "getSealedRows 应包含图片段全部行");
    // 末行是说明行；前面是等比占位空行（1440×757 在 100 宽、20 行上限下 → 76×20）
    assert.match(rows.at(-1), /shot\.png · 1440×757/);
    assert.ok(count >= 2, "至少要有占位行与说明行");
    assert.ok(
      rows.slice(-count, -1).every((row) => row === ""),
      "占位行必须是空串",
    );
    assert.deepEqual(segment.image.fitted, { cols: 76, rows: 20 });

    stopScheduledRender(ui);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendInlineImage 先写入的正文被封口成 plain 段，顺序保持在前", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-inline-ui-"));
  try {
    const pngPath = path.join(dir, "a.png");
    fs.writeFileSync(pngPath, fakePng(80, 40));
    const ui = createTerminalUI();
    ui.writeChat("先来一句话\n");

    withEnv({ HAJI_IMAGE_PROTOCOL: "kitty" }, () => ui.appendInlineImage(pngPath));

    assert.equal(ui.sealedSegments.length, 2);
    assert.equal(ui.sealedSegments[0].kind, "plain");
    assert.ok(ui.sealedSegments[0].raw.includes("先来一句话"));
    assert.equal(ui.sealedSegments[1].kind, "image");
    // 图片之后新写入的内容从空尾部重新开始，不会插进图片前面
    ui.writeChat("后来的内容\n");
    assert.equal(ui.chatContent, "后来的内容\n");
    stopScheduledRender(ui);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("非 kitty 协议降级为单行说明，不准备像素数据", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-inline-ui-"));
  try {
    const pngPath = path.join(dir, "b.png");
    fs.writeFileSync(pngPath, fakePng(100, 50));
    const ui = createTerminalUI();

    const result = withEnv({ HAJI_IMAGE_PROTOCOL: "none" }, () => ui.appendInlineImage(pngPath));
    assert.deepEqual(result, { ok: true });

    const segment = ui.sealedSegments.at(-1);
    assert.equal(segment.kind, "image");
    assert.equal(segment.image.desc.png, undefined);
    // 降级段只有说明行（getSealedRows 会去掉末尾光标行，段 rows 剩 1 行）
    ui.getSealedRows(100);
    assert.equal(segment.rows.length, 1);
    assert.match(segment.rows[0], /此终端不支持内联贴图/);
    assert.match(segment.rows[0], /\/view/);
    stopScheduledRender(ui);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendInlineImage 失败路径返回可读原因，不动对话区", () => {
  const ui = createTerminalUI();
  ui.writeChat("正文\n");
  const before = ui.sealedSegments.length;

  const missing = withEnv({ HAJI_IMAGE_PROTOCOL: "kitty" }, () =>
    ui.appendInlineImage("/nonexistent/definitely-missing.png"),
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error, /图片不存在/);
  assert.equal(ui.sealedSegments.length, before, "失败不应追加任何段");
  assert.equal(ui.chatContent, "正文\n");
  stopScheduledRender(ui);
});

test("同步层：位置未变零输出；移动只重放；滚出删 placement 保留数据", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-inline-ui-"));
  try {
    const pngPath = path.join(dir, "c.png");
    fs.writeFileSync(pngPath, fakePng(100, 40));
    const ui = createTerminalUI();
    withEnv({ HAJI_IMAGE_PROTOCOL: "kitty" }, () => ui.appendInlineImage(pngPath));
    const segment = ui.sealedSegments.at(-1);
    ui.getSealedRows(100);

    // 模拟帧渲染给的视口与段行区间：图片段前面有 5 行其他内容，整图可见
    const visible = { visibleStart: 0, visibleEnd: 50, chatRegionStart: 2, chatPadding: 3 };
    ui.sealedRowIndex = [{ id: segment.id, start: 5, count: segment.rows.length }];

    const first = ui.syncInlineImages({ ...visible, suppressed: false });
    assert.match(first, /a=t,f=100/, "首次应包含上传");
    assert.match(first, /\[8;4H/, "光标定位到 chatRegionStart+1 行、padding+1 列");
    assert.match(first, /a=p,i=\d+,p=1,c=\d+,r=\d+/);
    assert.equal(segment.image.uploaded, true);
    assert.equal(segment.image.placed.row, 8);

    // 再来一帧：位置没变 → 零输出
    assert.equal(ui.syncInlineImages({ ...visible, suppressed: false }), "");

    // 视口下移 2 行（图片整体仍可见）：越过节流间隔后只重放 placement，不再上传
    rewindNudgeWindow(ui);
    const scrolled = ui.syncInlineImages({
      ...visible,
      visibleStart: 2,
      visibleEnd: 52,
    });
    assert.equal(/a=t/.test(scrolled), false, "移动不应重传数据");
    assert.match(scrolled, /a=p/);
    assert.equal(segment.image.placed.row, 6);

    // 滚出视口：删 placement，数据保留
    const gone = ui.syncInlineImages({ ...visible, visibleStart: 40, visibleEnd: 90 });
    assert.match(gone, /a=d,d=i,i=\d+,p=1/);
    assert.equal(segment.image.placed, undefined);
    assert.equal(segment.image.uploaded, true, "删 placement 不清数据");

    // 滚回来：只放置不重传
    const back = ui.syncInlineImages({ ...visible, suppressed: false });
    assert.equal(/a=t/.test(back), false);
    assert.match(back, /a=p/);
    stopScheduledRender(ui);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("同步层：部分可见时按源矩形只贴可见段，滚动渐进出入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-inline-ui-"));
  try {
    const pngPath = path.join(dir, "d.png");
    fs.writeFileSync(pngPath, fakePng(100, 40)); // fitted 100×20，每行 2px
    const ui = createTerminalUI();
    withEnv({ HAJI_IMAGE_PROTOCOL: "kitty" }, () => ui.appendInlineImage(pngPath));
    const segment = ui.sealedSegments.at(-1);
    ui.getSealedRows(100);
    // 图片矩形占逻辑行 5..24，前面有 5 行其他内容
    ui.sealedRowIndex = [{ id: segment.id, start: 5, count: segment.rows.length }];
    const frame = { chatRegionStart: 2, chatPadding: 3, suppressed: false };

    // 向下滚动到 visibleStart=8：顶部裁掉 3 行，可见 17 行从聊天区第一行开始贴
    const topClipped = ui.syncInlineImages({ ...frame, visibleStart: 8, visibleEnd: 58 });
    assert.match(topClipped, /a=t,f=100/, "首次仍需上传");
    assert.match(topClipped, /\[3;4H/, "首个可见行定位到聊天区第一行");
    assert.match(topClipped, /a=p,i=\d+,p=1,c=100,r=17,x=0,y=6,w=100,h=34,q=2/);
    assert.deepEqual(segment.image.placed, {
      row: 3,
      col: 4,
      cols: 100,
      rows: 17,
      src: { x: 0, y: 6, w: 100, h: 34 },
    });

    // 再滚 1 行：越过节流间隔后只重放 placement（含新裁剪），不重传数据
    rewindNudgeWindow(ui);
    const scrolled = ui.syncInlineImages({ ...frame, visibleStart: 9, visibleEnd: 59 });
    assert.equal(/a=t/.test(scrolled), false);
    assert.match(scrolled, /a=p,i=\d+,p=1,c=100,r=16,x=0,y=8,w=100,h=32,q=2/);

    // 向上滚动：图片改为从底部滚入，只贴顶部若干行
    rewindNudgeWindow(ui);
    const bottomClipped = ui.syncInlineImages({ ...frame, visibleStart: 0, visibleEnd: 10 });
    assert.equal(/a=t/.test(bottomClipped), false);
    assert.match(bottomClipped, /a=p,i=\d+,p=1,c=100,r=5,x=0,y=0,w=100,h=10,q=2/);
    assert.equal(segment.image.placed.row, 8);

    // 完全滚出视口上方：删 placement、保留数据
    const gone = ui.syncInlineImages({ ...frame, visibleStart: 30, visibleEnd: 80 });
    assert.match(gone, /a=d,d=i/);
    assert.equal(segment.image.placed, undefined);
    stopScheduledRender(ui);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("同步层：滚动微调节流，收尾帧把最终位置对齐", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-inline-ui-"));
  try {
    const pngPath = path.join(dir, "e.png");
    fs.writeFileSync(pngPath, fakePng(100, 40));
    const ui = createTerminalUI();
    withEnv({ HAJI_IMAGE_PROTOCOL: "kitty" }, () => ui.appendInlineImage(pngPath));
    const segment = ui.sealedSegments.at(-1);
    ui.getSealedRows(100);
    ui.sealedRowIndex = [{ id: segment.id, start: 5, count: segment.rows.length }];
    const visible = { visibleStart: 0, visibleEnd: 50, chatRegionStart: 2, chatPadding: 3 };

    // 首次放置（含上传）不受节流
    const first = ui.syncInlineImages({ ...visible, suppressed: false });
    assert.match(first, /a=p/);

    // 间隔内的滚动微调被抑制：零输出、placement 不动，但安排了收尾帧
    const nudged = ui.syncInlineImages({ ...visible, visibleStart: 2, visibleEnd: 52 });
    assert.equal(nudged, "");
    assert.equal(segment.image.placed.row, 8, "抑制期间不更新已放置状态");
    assert.ok(ui.inlineImages.settleTimer, "应安排收尾帧");
    assert.equal(ui.inlineImages.nudgePending, true);

    // 越过间隔后：一条 a=p 对齐到精确位置
    rewindNudgeWindow(ui);
    const snapped = ui.syncInlineImages({ ...visible, visibleStart: 2, visibleEnd: 52 });
    assert.match(snapped, /a=p/);
    assert.equal(segment.image.placed.row, 6);
    assert.equal(ui.inlineImages.nudgePending, false);
    stopScheduledRender(ui);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("内联图片段不改变选区行号：拖选文字复制到的就是选中的那几行", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-inline-ui-"));
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  try {
    const pngPath = path.join(dir, "shot.png");
    fs.writeFileSync(pngPath, fakePng(160, 90));
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 61 });
    const ui = createTerminalUI();
    const width = 60;

    ui.writeChat("先来一段正文\n");
    withEnv({ HAJI_IMAGE_PROTOCOL: "kitty" }, () => ui.appendInlineImage(pngPath));
    ui.writeChat("图一之后的正文\n");
    withEnv({ HAJI_IMAGE_PROTOCOL: "kitty" }, () => ui.appendInlineImage(pngPath));
    const tail = "| 12s | 表格行 |\n## 未完成的项\n- 本机没有 ASR 模型\n";
    ui.writeChat(tail);

    const sealedRows = ui.getSealedRows(width).map(stripAnsi);
    const layout = ui.getSelectionLayout();
    // 图片段的占位行同样占行：布局必须逐行对上屏幕行，多一行就会让后续选区整体上移。
    for (const [index, row] of sealedRows.entries()) {
      assert.equal(layout.rows[index]?.plain, row, `第 ${index} 行应与屏幕一致`);
    }
    const tailRows = wrapAnsi(tail, width).slice(0, -1).map(stripAnsi);
    for (const [index, row] of tailRows.entries()) {
      assert.equal(
        layout.rows[sealedRows.length + index]?.plain,
        row,
        `尾部第 ${index} 行应与屏幕一致`,
      );
    }

    // 从「## 未完成的项」拖到最后一行：复制出的就是这三行原文，不带上方的表格。
    const headingRow = sealedRows.length + 1;
    const lastRow = sealedRows.length + tailRows.length - 1;
    const start = cellAtColumn(layout.rows[headingRow], 1);
    const end = cellAtColumn(layout.rows[lastRow], width, true);
    assert.ok(start && end, "选区端点应落在正文上");
    ui.textSelection.begin(start);
    ui.textSelection.finish(end);
    assert.equal(ui.getSelectedChatText(), "## 未完成的项\n- 本机没有 ASR 模型");

    stopScheduledRender(ui);
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, "columns", descriptor);
    else delete process.stdout.columns;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
