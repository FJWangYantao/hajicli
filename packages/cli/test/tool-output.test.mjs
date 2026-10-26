import assert from "node:assert/strict";
import test from "node:test";

import { terminalWidth } from "../dist/terminal-text.js";
import {
  collapseShellOutput,
  collapseToolOutput,
  formatOmittedLines,
  SHELL_PREVIEW_LINES,
} from "../dist/tool-output.js";

const lines = (count, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");

test("collapseToolOutput keeps the head and reports the omitted count", () => {
  const collapsed = collapseToolOutput(lines(30), { maxLines: 10, maxChars: 10 * 80 });
  assert.equal(collapsed.lines.length, 10);
  assert.equal(collapsed.lines[0], "line 1");
  assert.equal(collapsed.lines.at(-1), "line 10");
  assert.equal(collapsed.omitted, 20);

  const fits = collapseToolOutput(lines(3), { maxLines: 10, maxChars: 10 * 80 });
  assert.deepEqual(fits, { lines: ["line 1", "line 2", "line 3"], omitted: 0 });
});

test("collapseShellOutput keeps the tail — the part holding the error", () => {
  const collapsed = collapseShellOutput(lines(30), { maxLines: 10, maxChars: 10 * 80 });
  assert.equal(collapsed.lines.length, 10);
  assert.equal(collapsed.lines[0], "line 21");
  assert.equal(collapsed.lines.at(-1), "line 30");
  assert.equal(collapsed.omitted, 20);
});

test("both budgets apply: display width, not string length", () => {
  // 每行 30 个中文字符 = 60 列；预算 10 行 × 30 列 → 每行截到 30 列。
  const wide = "中".repeat(30);
  const collapsed = collapseToolOutput(`${wide}\n${wide}`, { maxLines: 10, maxChars: 10 * 30 });
  for (const line of collapsed.lines) {
    assert.ok(terminalWidth(line) <= 30, `width ${terminalWidth(line)}`);
    assert.ok(line.endsWith("…"));
  }
  // emoji 也不能被截成半个 grapheme（截断后仍能按码点整除回原字符）。
  const emoji = "🙂".repeat(20);
  const clipped = collapseToolOutput(emoji, { maxLines: 1, maxChars: 10 }).lines[0];
  assert.equal(clipped, `${"🙂".repeat(4)}…`);
});

test("shell preview budget is the documented ten lines", () => {
  assert.equal(SHELL_PREVIEW_LINES, 10);
});

test("empty output collapses to nothing, blank tails are dropped", () => {
  assert.deepEqual(collapseToolOutput("", { maxLines: 10, maxChars: 800 }), {
    lines: [],
    omitted: 0,
  });
  assert.deepEqual(collapseToolOutput("a\nb\n\n\n", { maxLines: 10, maxChars: 800 }), {
    lines: ["a", "b"],
    omitted: 0,
  });
});

test("the omission marker says which side was folded away", () => {
  assert.equal(formatOmittedLines(0, "start"), "");
  assert.equal(formatOmittedLines(84, "start"), "… 前 84 行未显示");
  assert.equal(formatOmittedLines(84, "end"), "… 另有 84 行未显示");
});
