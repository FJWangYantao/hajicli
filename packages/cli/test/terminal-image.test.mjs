import assert from "node:assert/strict";
import test from "node:test";
import {
  detectImageProtocol,
  encodeDeleteImages,
  encodeIterm2Image,
  encodeKittyImage,
  fitImageCells,
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
