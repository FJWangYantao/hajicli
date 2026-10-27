import assert from "node:assert/strict";
import test from "node:test";

import { TerminalProtocolParser } from "../dist/terminal-protocol.js";

const dragSequence = [
  "\x1b[<0;5;10M",
  "\x1b[<32;20;12M",
  "\x1b[<64;20;8M",
  "\x1b[<65;20;8M",
  "\x1b[<0;20;8m",
].join("");

test("decodes SGR drag and wheel events", () => {
  const parser = new TerminalProtocolParser();
  const events = parser.push(dragSequence);

  assert.deepEqual(
    events.map((event) => (event.type === "mouse" ? event.action : event.type)),
    ["down", "move", "wheel", "wheel", "up"],
  );
  assert.equal(events[2].wheelRows, 3);
  assert.equal(events[3].wheelRows, -3);
});

test("reassembles a mouse stream split at every byte", () => {
  const parser = new TerminalProtocolParser();
  const events = [];
  for (const byte of Buffer.from(dragSequence, "utf8")) {
    events.push(...parser.push(Buffer.from([byte])));
  }

  assert.equal(events.length, 5);
  assert.ok(events.every((event) => event.type === "mouse"));
});

test("never leaks dense mouse traffic into keyboard events", () => {
  const parser = new TerminalProtocolParser();
  const denseDrag = Array.from(
    { length: 500 },
    (_, index) => `\x1b[<32;${2 + (index % 70)};${2 + (index % 20)}M`,
  ).join("");
  const events = parser.push(`${denseDrag}\x03`);

  const keyboard = events.filter((event) => event.type === "keyboard");
  assert.deepEqual(keyboard, [{ type: "keyboard", data: "\x03" }]);
  assert.equal(events.filter((event) => event.type === "mouse").length, 500);
});

test("keeps bracketed paste atomic across arbitrary packets", () => {
  const parser = new TerminalProtocolParser();
  const events = [
    ...parser.push("\x1b[20"),
    ...parser.push("0~第一行\n"),
    ...parser.push("第二行\x1b[20"),
    ...parser.push("1~"),
  ];

  assert.deepEqual(events, [{ type: "paste", text: "第一行\n第二行" }]);
});

test("flushes a standalone escape as keyboard input", () => {
  const parser = new TerminalProtocolParser();
  assert.deepEqual(parser.push("\x1b"), []);
  assert.deepEqual(parser.flushPending(), [{ type: "keyboard", data: "\x1b" }]);
});

test("marks only a bare escape as pending so the UI can flush it quickly", () => {
  const lone = new TerminalProtocolParser();
  assert.deepEqual(lone.push("\x1b"), []);
  assert.equal(lone.isLoneEscapePending(), true);

  const altKey = new TerminalProtocolParser();
  assert.deepEqual(altKey.push("\x1b"), []);
  assert.deepEqual(altKey.push("x"), [{ type: "keyboard", data: "\x1bx" }]);
  assert.equal(altKey.isLoneEscapePending(), false);

  const mousePrefix = new TerminalProtocolParser();
  assert.deepEqual(mousePrefix.push("\x1b["), []);
  assert.equal(mousePrefix.isLoneEscapePending(), false);
});

// 单独的 Esc 有一个 16ms 等待窗口。1003 any-event 鼠标跟踪常开时，窗口内若来
// 一条鼠标报告，两者会在缓冲区里粘成 Esc + Esc[<b;x;yM。旧实现把它切成
// "\x1b\x1b" + "[<b;x;yM"，后半段被当键盘文本写进输入框（按 Esc 时看到的
// 35;120;12M 泄漏）。以下锁定「只消费一个 ESC、剩余按 SGR 重新识别」的行为。

const ESC = "\x1b";
const MOUSE = `${ESC}[<35;120;12M`;
const MOUSE2 = `${ESC}[<35;124;12M`;

function drain(parser, chunks) {
  const events = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.flushPending());
  return events;
}

function keyboardText(events) {
  return events
    .filter((event) => event.type === "keyboard")
    .map((event) => event.data)
    .join("");
}

test("esc stuck to a mouse report in one chunk does not leak mouse text", () => {
  const events = drain(new TerminalProtocolParser(), [`${ESC}${MOUSE}`]);
  assert.deepEqual(events, [
    { type: "keyboard", data: ESC },
    { type: "mouse", action: "move", button: 35, column: 120, row: 12 },
  ]);
  assert.equal(keyboardText(events), ESC);
  assert.doesNotMatch(keyboardText(events), /35;120;12M/);
});

test("mouse report arriving right after a lone esc does not leak", () => {
  const events = drain(new TerminalProtocolParser(), [ESC, MOUSE]);
  assert.deepEqual(events, [
    { type: "keyboard", data: ESC },
    { type: "mouse", action: "move", button: 35, column: 120, row: 12 },
  ]);
  assert.doesNotMatch(keyboardText(events), /35;/);
});

test("esc stuck to a burst of mouse reports parses all of them as mouse", () => {
  const events = drain(new TerminalProtocolParser(), [`${ESC}${MOUSE}${MOUSE2}`]);
  assert.deepEqual(events, [
    { type: "keyboard", data: ESC },
    { type: "mouse", action: "move", button: 35, column: 120, row: 12 },
    { type: "mouse", action: "move", button: 35, column: 124, row: 12 },
  ]);
});

test("two adjacent escapes split into two keyboard events", () => {
  const events = drain(new TerminalProtocolParser(), [`${ESC}${ESC}`]);
  assert.deepEqual(events, [
    { type: "keyboard", data: ESC },
    { type: "keyboard", data: ESC },
  ]);
});

test("plain CSI sequences stay intact after the esc fix", () => {
  assert.deepEqual(drain(new TerminalProtocolParser(), [`${ESC}[A`]), [
    { type: "keyboard", data: `${ESC}[A` },
  ]);
});

test("mouse report right after a paste end is still a mouse event", () => {
  const events = drain(new TerminalProtocolParser(), [`${ESC}[200~ok${ESC}[201~${MOUSE}`]);
  assert.deepEqual(events, [
    { type: "paste", text: "ok" },
    { type: "mouse", action: "move", button: 35, column: 120, row: 12 },
  ]);
});
