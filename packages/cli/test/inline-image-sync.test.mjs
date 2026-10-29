import assert from "node:assert/strict";
import test from "node:test";

import { InlineImageSync, renderImageOverlayFrame } from "../dist/inline-image-sync.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value) => value.replace(ANSI_RE, "");

function makeSync() {
  const writes = [];
  const renders = [];
  const sync = new InlineImageSync({
    scheduleRender: (interactive) => renders.push(interactive),
    write: (text) => writes.push(text),
  });
  return { sync, writes, renders };
}

test("全屏看图帧：整屏清屏 + 贴图序列 + 图下一行说明", () => {
  const frame = renderImageOverlayFrame(
    {
      protocol: "kitty",
      sequence: "<IMAGE>",
      cols: 40,
      rows: 10,
      caption: "shot.png · 800×400",
      tmux: false,
    },
    80,
    24,
  );
  assert.match(frame, /^\x1b\[\?2026h/, "以同步刷新开始");
  assert.match(frame, /\x1b\[2J\x1b\[H/, "整屏清屏");
  assert.ok(frame.includes("<IMAGE>"), "贴图序列原样插入");
  assert.match(frame, /\x1b\[11;1H/, "说明行在图下第 1 行");
  assert.match(stripAnsi(frame), /shot\.png · 800×400 {2}· {2}任意键返回/);
  assert.match(frame, /\x1b\[\?2026l$/, "以同步刷新结束");
});

test("全屏看图帧：说明行不超过屏幕高度，宽度退化时按 80 列截断", () => {
  const frame = renderImageOverlayFrame(
    { protocol: "kitty", sequence: "", cols: 1, rows: 99, caption: "x".repeat(200) },
    0,
    0,
  );
  assert.match(frame, /\x1b\[24;1H/, "说明行夹到最后一屏行");
  const caption = stripAnsi(frame).split("\n").at(-1);
  assert.ok(caption.length <= 80 + "  ·  任意键返回".length + 1);
});

test("屏幕重置：所有内联图回到未放置、未上传", () => {
  const { sync } = makeSync();
  const segments = [
    { id: 1, image: { uploaded: true, placed: { row: 3, col: 1, cols: 2, rows: 2 } } },
    { id: 2 },
  ];
  sync.resetScreen(segments);
  assert.equal(segments[0].image.uploaded, false);
  assert.equal(segments[0].image.placed, undefined);
});

test("丢弃段：只释放 kitty 已上传的图，非 kitty 与无数据不写终端", () => {
  const { sync, writes } = makeSync();
  const png = Buffer.from([1, 2, 3]);
  sync.dispose([
    { id: 1, image: { kittyId: 7, desc: { protocol: "kitty", tmux: false, png } } },
    { id: 2, image: { kittyId: 8, desc: { protocol: "iterm2", tmux: false, png } } },
    { id: 3, image: { kittyId: 9, desc: { protocol: "kitty", tmux: false } } },
    { id: 4 },
  ]);
  assert.equal(writes.length, 1, "只有第一段需要释放");
  assert.match(writes[0], /a=d,d=I,i=7/);
});

test("空段列表的同步是零输出，也不安排收尾帧", () => {
  const { sync, renders } = makeSync();
  const out = sync.sync(
    { visibleStart: 0, visibleEnd: 10, chatRegionStart: 0, chatPadding: 0, suppressed: false },
    [],
    [],
  );
  assert.equal(out, "");
  assert.equal(sync.pendingNudge, false);
  assert.equal(renders.length, 0);
});
