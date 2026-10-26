import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildInlineImage,
  clipInlinePlacement,
  detectImageProtocol,
  diffInlinePlacements,
  encodeDeleteImages,
  encodeIterm2Image,
  encodeKittyImage,
  encodeKittyImageDispose,
  encodeKittyPlacement,
  encodeKittyPlacementDelete,
  encodeKittyUpload,
  fitImageCells,
  INLINE_IMAGE_MAX_ROWS,
  isPng,
  readImageDimensions,
} from "../dist/terminal-image.js";

/** 造一个头部合法、body 随便的 PNG：编码测试不校验像素，只走签名与 IHDR。 */
function fakePng(width, height, padding = 0) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(padding)]);
}

test("图片协议探测：环境变量覆盖优先，其次看终端线索", () => {
  assert.equal(detectImageProtocol({ HAJI_IMAGE_PROTOCOL: "kitty" }), "kitty");
  assert.equal(detectImageProtocol({ HAJI_IMAGE_PROTOCOL: "iterm" }), "iterm2");
  assert.equal(detectImageProtocol({ HAJI_IMAGE_PROTOCOL: "none" }), "none");
  assert.equal(detectImageProtocol({ HAJI_IMAGE_PROTOCOL: "off" }), "none");
  // 覆盖值不合法时继续按线索判断
  assert.equal(detectImageProtocol({ HAJI_IMAGE_PROTOCOL: "xxx", KITTY_WINDOW_ID: "1" }), "kitty");

  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: "1" }), "kitty");
  assert.equal(detectImageProtocol({ TERM: "xterm-ghostty" }), "kitty");
  assert.equal(detectImageProtocol({ TERM_PROGRAM: "ghostty" }), "kitty");
  assert.equal(detectImageProtocol({ TERM_PROGRAM: "WezTerm" }), "kitty");
  assert.equal(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" }), "iterm2");
  // 毫无线索时按 kitty 试探：不支持的终端会静默忽略 APC 序列
  assert.equal(detectImageProtocol({ TERM: "xterm-256color" }), "kitty");
});

test("按单元格排版：等比缩放、贴边不越界，小图不放大到溢出", () => {
  // 1440×757 的截图放进 100×40：受宽度限制，约 100×26
  assert.deepEqual(fitImageCells(1440, 757, 100, 40), { cols: 100, rows: 26 });
  // 竖图受高度限制
  const tall = fitImageCells(600, 2400, 100, 40);
  assert.ok(tall.rows <= 40 && tall.cols <= 100);
  assert.equal(tall.rows, 40);
  assert.equal(tall.cols, 20);
  // 超宽裁到上限
  const wide = fitImageCells(10000, 100, 80, 24);
  assert.equal(wide.cols, 80);
  assert.ok(wide.rows >= 1);
  // 非法尺寸退化成整屏
  assert.deepEqual(fitImageCells(0, 0, 30, 10), { cols: 30, rows: 10 });
});

test("kitty 序列：a=T/f=100、单元格尺寸、分块与 tmux passthrough", () => {
  const png = fakePng(10, 10);
  const seq = encodeKittyImage(png, { cols: 12, rows: 6, id: 7 });
  assert.ok(seq.startsWith("\x1b_Ga=T,f=100,i=7,c=12,r=6,q=2;"));
  assert.ok(seq.endsWith("\x1b\\"));
  assert.ok(seq.includes(png.toString("base64").slice(0, 16)));

  // 大图分块：4096 字节 base64 一块，最后一块 m=0
  const big = fakePng(10, 10, 6000);
  const chunks = encodeKittyImage(big, { cols: 10, rows: 5 }).split("\x1b\\").filter(Boolean);
  assert.ok(chunks.length >= 2, `expect 多块, got ${chunks.length}`);
  assert.match(chunks[0], /,m=1;/);
  assert.match(chunks.at(-1), /m=0;/);

  const wrapped = encodeKittyImage(png, { cols: 10, rows: 5, tmux: true });
  assert.ok(wrapped.startsWith("\x1bPtmux;\x1b\x1b_G"));
  assert.ok(wrapped.endsWith("\x1b\\"));
  assert.equal(/(?<!\x1b)\x1b_G/.test(wrapped), false, "tmux 内容里的 ESC 必须成对转义");
});

test("iTerm2 序列：OSC 1337 + 单元格宽度 + base64 文件名", () => {
  const data = fakePng(4, 4);
  const seq = encodeIterm2Image(data, { cols: 9, name: "截图.png" });
  assert.ok(seq.startsWith("\x1b]1337;inline=1;preserveAspectRatio=1;width=9;name="));
  assert.ok(seq.includes(Buffer.from("截图.png", "utf8").toString("base64")));
  assert.ok(seq.includes(`:${data.toString("base64")}\x07`));
});

test("删除序列只对 kitty 有意义", () => {
  assert.equal(encodeDeleteImages("kitty"), "\x1b_Ga=d,d=A\x1b\\");
  assert.equal(encodeDeleteImages("kitty", true), "\x1bPtmux;\x1b\x1b_Ga=d,d=A\x1b\x1b\\\x1b\\");
  assert.equal(encodeDeleteImages("iterm2"), "");
  assert.equal(encodeDeleteImages("none"), "");
});

test("读 PNG / JPEG 头部尺寸", () => {
  assert.deepEqual(readImageDimensions(fakePng(1440, 757)), { width: 1440, height: 757 });
  assert.ok(isPng(fakePng(1, 1)));
  assert.ok(!isPng(Buffer.from([0xff, 0xd8, 0xff])));

  // 最小 JPEG：SOI + SOF0（含宽高）+ EOI
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0xc0, 0x03, 0x01, 0x22, 0x00, 0x02,
    0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
  assert.deepEqual(readImageDimensions(jpeg), { width: 960, height: 600 });
  assert.deepEqual(readImageDimensions(Buffer.from("not an image")), { width: 0, height: 0 });
});

test("kitty 内联序列：a=t 只上传、a=p 放置、a=d 按 (i,p) 删除与释放", () => {
  const png = fakePng(10, 10);
  // a=t 上传：不带 c/r（尺寸属于 placement），带稳定 id 与 q=2
  const upload = encodeKittyUpload(png, { id: 5 });
  assert.ok(upload.startsWith("\x1b_Ga=t,f=100,i=5,q=2;"));
  assert.ok(upload.endsWith("\x1b\\"));
  // 分块续传与 a=T 相同
  const big = encodeKittyUpload(fakePng(10, 10, 6000), { id: 5 })
    .split("\x1b\\")
    .filter(Boolean);
  assert.ok(big.length >= 2);
  assert.match(big[0], /,m=1;/);
  assert.match(big.at(-1), /m=0;/);
  // tmux 包裹时 ESC 成对转义
  const wrapped = encodeKittyUpload(png, { id: 5, tmux: true });
  assert.ok(wrapped.startsWith("\x1bPtmux;\x1b\x1b_Ga=t"));

  const place = encodeKittyPlacement({ id: 5, placementId: 1, cols: 40, rows: 10 });
  assert.equal(place, "\x1b_Ga=p,i=5,p=1,c=40,r=10,q=2\x1b\\");
  assert.ok(
    encodeKittyPlacement({ id: 5, placementId: 1, cols: 40, rows: 10, tmux: true }).startsWith(
      "\x1bPtmux;",
    ),
  );
  // 部分可见：源矩形（0 基像素）随 c/r 一起发送
  assert.equal(
    encodeKittyPlacement({
      id: 5,
      placementId: 1,
      cols: 40,
      rows: 6,
      src: { x: 0, y: 12, w: 400, h: 48 },
    }),
    "\x1b_Ga=p,i=5,p=1,c=40,r=6,x=0,y=12,w=400,h=48,q=2\x1b\\",
  );

  // 删除单个 placement（小写 i：保留数据）与释放数据（大写 I）
  assert.equal(
    encodeKittyPlacementDelete({ id: 5, placementId: 1 }),
    "\x1b_Ga=d,d=i,i=5,p=1,q=2\x1b\\",
  );
  assert.equal(encodeKittyImageDispose(5), "\x1b_Ga=d,d=I,i=5,q=2\x1b\\");
  assert.equal(
    encodeKittyImageDispose(5, true),
    "\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=5,q=2\x1b\x1b\\\x1b\\",
  );
});

test("内联图构建：校验、协议降级与 kitty PNG 直通", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-inline-test-"));
  try {
    const pngPath = path.join(dir, "shot.png");
    fs.writeFileSync(pngPath, fakePng(1440, 757));
    const kittyEnv = { HAJI_IMAGE_PROTOCOL: "kitty" };

    // kitty：读盘、量尺寸、产出 PNG 数据与 caption
    const built = buildInlineImage(pngPath, kittyEnv);
    assert.equal(built.ok, true);
    assert.equal(built.image.protocol, "kitty");
    assert.equal(built.image.widthPx, 1440);
    assert.equal(built.image.heightPx, 757);
    assert.equal(built.image.caption, "shot.png · 1440×757");
    assert.ok(isPng(built.image.png));

    // iTerm2 / none：不准备像素数据，渲染层降级为说明行
    for (const env of [{ HAJI_IMAGE_PROTOCOL: "iterm2" }, { HAJI_IMAGE_PROTOCOL: "none" }]) {
      const fallback = buildInlineImage(pngPath, env);
      assert.equal(fallback.ok, true);
      assert.equal(fallback.image.png, undefined);
      assert.equal(fallback.image.protocol, env.HAJI_IMAGE_PROTOCOL);
    }

    // 文件不存在 / 非图片 / 超上限
    const missing = buildInlineImage(path.join(dir, "nope.png"), kittyEnv);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /图片不存在/);
    const textPath = path.join(dir, "note.txt");
    fs.writeFileSync(textPath, "hello");
    const notImage = buildInlineImage(textPath, kittyEnv);
    assert.equal(notImage.ok, false);
    assert.match(notImage.error, /只支持 PNG \/ JPEG/);
    const bigPath = path.join(dir, "big.png");
    fs.writeFileSync(bigPath, fakePng(10, 10, 9 * 1024 * 1024));
    const tooBig = buildInlineImage(bigPath, kittyEnv);
    assert.equal(tooBig.ok, false);
    assert.match(tooBig.error, /内联上限 8MB/);

    // tmux 环境记录在描述里（序列包裹由编码函数按它决定）
    const inTmux = buildInlineImage(pngPath, { ...kittyEnv, TMUX: "/tmp/tmux-0/default,1,0" });
    assert.equal(inTmux.ok, true);
    assert.equal(inTmux.image.tmux, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("placement 同步 diff：未变零开销、移动重放、滚出删除、滚回恢复", () => {
  const at = (row) => ({ row, col: 4, cols: 40, rows: 10 });
  // 双方都没有：无事可做
  assert.deepEqual(diffInlinePlacements(undefined, undefined, false), { action: "none" });
  // 首次出现：需要上传 + 放置
  assert.deepEqual(diffInlinePlacements(undefined, at(10), false), {
    action: "place",
    plan: { upload: true, place: at(10) },
  });
  // 位置未变且已上传：零输出（流式期间的绝大多数帧）
  assert.deepEqual(diffInlinePlacements(at(10), at(10), true), { action: "none" });
  // 位置未变但数据被清（整屏重置后）：只重传不重放也可以，仍归为 place
  assert.deepEqual(diffInlinePlacements(at(10), at(10), false), {
    action: "place",
    plan: { upload: true, place: at(10) },
  });
  // 滚动导致位置变化：不重传数据，仅重放 placement（协议保证无闪烁替换）
  assert.deepEqual(diffInlinePlacements(at(10), at(8), true), {
    action: "place",
    plan: { upload: false, place: at(8) },
  });
  // 尺寸变化（终端 resize）：同样只重放
  const resized = { row: 8, col: 4, cols: 30, rows: 8 };
  assert.deepEqual(diffInlinePlacements(at(8), resized, true), {
    action: "place",
    plan: { upload: false, place: resized },
  });
  // 裁剪变化（滚动进出视口）：视为位置变化，只重放不重传
  const cropped = { row: 3, col: 4, cols: 40, rows: 6, src: { x: 0, y: 14, w: 400, h: 24 } };
  assert.deepEqual(diffInlinePlacements(at(8), cropped, true), {
    action: "place",
    plan: { upload: false, place: cropped },
  });
  // 位置尺寸裁剪全一致：零输出
  assert.deepEqual(diffInlinePlacements(cropped, cropped, true), { action: "none" });
  // 滚出视口：删 placement（保留数据）
  assert.deepEqual(diffInlinePlacements(at(8), undefined, true), { action: "delete" });
  // 滚回来：数据还在，只放置
  assert.deepEqual(diffInlinePlacements(undefined, at(12), true), {
    action: "place",
    plan: { upload: false, place: at(12) },
  });
});

test("内联排版受行数上限约束", () => {
  const fitted = fitImageCells(1440, 757, 100, INLINE_IMAGE_MAX_ROWS);
  assert.ok(fitted.rows <= INLINE_IMAGE_MAX_ROWS);
  assert.ok(fitted.cols <= 100);
});

test("视口裁剪：部分可见折算 0 基像素源矩形，完全不可见返回 undefined", () => {
  // 100×40 像素折算成 100×20 行 → 每行 2px，图片矩形占逻辑行 5..24
  const image = { start: 5, rows: 20, widthPx: 100, heightPx: 40 };
  // 整图可见：不需要源矩形
  assert.deepEqual(clipInlinePlacement(image, { visibleStart: 0, visibleEnd: 50 }), {
    clippedRows: 0,
    visibleRows: 20,
  });
  // 顶部被裁 3 行：可见 17 行，从 y=6 裁到图底 40
  assert.deepEqual(clipInlinePlacement(image, { visibleStart: 8, visibleEnd: 60 }), {
    clippedRows: 3,
    visibleRows: 17,
    src: { x: 0, y: 6, w: 100, h: 34 },
  });
  // 底部被裁 15 行：可见顶部 5 行
  assert.deepEqual(clipInlinePlacement(image, { visibleStart: 0, visibleEnd: 10 }), {
    clippedRows: 0,
    visibleRows: 5,
    src: { x: 0, y: 0, w: 100, h: 10 },
  });
  // 两端同时裁：y 区间取交集
  const both = clipInlinePlacement(image, { visibleStart: 8, visibleEnd: 20 });
  assert.equal(both.visibleRows, 12);
  assert.deepEqual(both.src, { x: 0, y: 6, w: 100, h: 24 });
  // 完全滚出视口（上 / 下）
  assert.equal(clipInlinePlacement(image, { visibleStart: 30, visibleEnd: 50 }), undefined);
  assert.equal(clipInlinePlacement(image, { visibleStart: 0, visibleEnd: 5 }), undefined);
});
