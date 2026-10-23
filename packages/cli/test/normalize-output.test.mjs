import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTerminalOutput, TAB_WIDTH, terminalWidth } from "../dist/terminal-text.js";
import { resetActiveColorLevel, setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

test("tabs are expanded to a fixed width so measured and rendered columns agree", () => {
  const expanded = normalizeTerminalOutput("a\tb");
  assert.equal(expanded, "a" + " ".repeat(TAB_WIDTH) + "b");
  assert.equal(terminalWidth(expanded), 2 + TAB_WIDTH);

  // 多行代码片段里的每个 tab 都按同一宽度展开。
  const code = normalizeTerminalOutput("func\tmain() {\n\t\treturn\t0\n}");
  assert.ok(!code.includes("\t"));
  assert.equal(code.split("\n")[1].startsWith(" ".repeat(TAB_WIDTH * 2)), true);
});

test("tabs inside escape sequences are left alone", () => {
  const withAnsi = "\x1b[31m\tred\x1b[0m";
  const normalized = normalizeTerminalOutput(withAnsi);
  assert.equal(normalized, `\x1b[31m${" ".repeat(TAB_WIDTH)}red\x1b[0m`);
});

test("combining marks do not add columns, so SARA AM keeps its width", () => {
  // U+0E33（泰文 SARA AM）由终端渲染成一个字形；拆开后留下的组合标记 U+0E4D 不应占列。
  assert.equal(terminalWidth("\u0e4d\u0e32"), 1);
  assert.equal(terminalWidth("\u0ecd\u0eb2"), 1);
  assert.equal(terminalWidth("\u0e33"), 1);
  // 一般组合标记同理。
  assert.equal(terminalWidth("e\u0301"), 1);
  assert.equal(terminalWidth("\u0301"), 0);
});

test("plain text passes through unchanged", () => {
  const sample = "普通的一行中英混排 with ASCII 和 👨‍👩‍👧";
  assert.equal(normalizeTerminalOutput(sample), sample);

  resetActiveColorLevel();
});
