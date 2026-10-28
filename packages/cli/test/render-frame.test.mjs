import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildScreenUpdate,
  clearTerminalWidthCache,
  terminalWidth,
} from "../dist/terminal-text.js";
import { resetActiveColorLevel, setActiveColorLevel, setThemePreset } from "../dist/theme.js";

setActiveColorLevel("mono");
setThemePreset("default");
const ESC = String.fromCharCode(27);

test("terminalWidth measures ASCII, CJK and emoji at their real cell widths", () => {
  assert.equal(terminalWidth("hello"), 5);
  assert.equal(terminalWidth("你好"), 4);
  assert.equal(terminalWidth("a你b"), 4);
  assert.equal(terminalWidth("👨‍👩‍👧"), 2, "ZWJ family emoji is one grapheme of width 2");
  assert.equal(terminalWidth(`${ESC}[1m你好${ESC}[0m`), 4, "SGR sequences take no cells");
  assert.equal(terminalWidth(""), 0);
});

test("terminalWidth counts emoji presentation (with or without VS16) as two cells", () => {
  // 这些符号的码位不在手写宽字符区间里，但终端按 emoji 渲染成 2 列；
  // 漏算会让推理预览行宽少 1 列，右侧侧栏分割线随之错位。
  assert.equal(terminalWidth("✅"), 2);
  assert.equal(terminalWidth("⏳"), 2);
  assert.equal(terminalWidth("⚠️"), 2, "VS16 把文本符号强制成 emoji 呈现");
  assert.equal(terminalWidth("1️⃣"), 2, "keycap 也是双宽");
  assert.equal(terminalWidth("⚠"), 1, "没有 VS16 时仍按文本符号计宽");
  assert.equal(terminalWidth("┊ 推理 ✅"), 9, "emoji 与中文、ASCII 混排逐字累加");
});

test("terminalWidth is memoised without changing results", () => {
  clearTerminalWidthCache();
  const sample = `${ESC}[38;2;1;2;3m中文 abc${ESC}[0m`;
  const first = terminalWidth(sample);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(terminalWidth(sample), first);
  }
  clearTerminalWidthCache();
  assert.equal(terminalWidth(sample), first);
});

test("buildScreenUpdate only rewrites changed rows and clears them to the terminal background", () => {
  setActiveColorLevel("truecolor");
  const update = buildScreenUpdate(["a", "b"], ["a", "c"]);
  assert.ok(!update.includes("1;1H"), "unchanged row must not be repainted");
  assert.equal(update, `${ESC}[2;1H${ESC}[49m${ESC}[2Kc`);
  setActiveColorLevel("mono");
});

test("frames are wrapped in synchronized output (DECSET 2026)", () => {
  const source = fs.readFileSync(new URL("../src/terminal-input.ts", import.meta.url), "utf8");
  const opens = source.match(/\\x1b\[\?2026h/g) ?? [];
  const closes = source.match(/\\x1b\[\?2026l/g) ?? [];
  assert.ok(opens.length >= 2, "init and per-frame writes both open synchronized output");
  assert.equal(opens.length, closes.length, "every synchronized-output block is closed");

  // 帧必须以 2026h 开头、以 2026l 收尾，且光标显示切换发生在同步块内部。
  assert.match(source, /let frame = "\\x1b\[\?2026h\\x1b\[\?25l";/);
  assert.match(source, /frame \+= cursorState;\s*\n\s*frame \+= "\\x1b\[\?2026l";/);

  resetActiveColorLevel();
});
