import assert from "node:assert/strict";
import test from "node:test";

import { terminalWidth } from "../dist/terminal-text.js";
import {
  collapseShellOutput,
  collapseToolOutput,
  formatOmittedLines,
  SHELL_PREVIEW_LINES,
  stripToolOutputEnvelope,
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

test("shell preview budget is the documented six lines", () => {
  assert.equal(SHELL_PREVIEW_LINES, 6);
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

test("stripToolOutputEnvelope drops receipts but keeps the real output", () => {
  const bash = [
    "[命令执行结果 - 退出码 0；耗时 15316ms]",
    "--- 标准输出 (stdout，保留头尾) ---",
    "build=0",
    "test=0",
    "[verification_evidence_id: call_1]",
  ].join("\n");
  assert.equal(stripToolOutputEnvelope("bash", bash), "build=0\ntest=0");

  const read = [
    "[文件读取结果 - a.ts]",
    "总行数=2；返回=1-2；hash=abc；hasMore=false",
    "   1 | x",
    "   2 | y",
  ].join("\n");
  assert.equal(stripToolOutputEnvelope("read", read), "   1 | x\n   2 | y");

  const grep = [
    "[Grep 搜索结果 - x]",
    "引擎=ripgrep；offset=0；limit=50；返回=1；hasMore=false",
    "a.ts:1:2: x",
  ].join("\n");
  assert.equal(stripToolOutputEnvelope("grep", grep), "a.ts:1:2: x");

  const global = [
    "[全局文件查找结果 - *.ts]",
    "引擎=fd；offset=0；limit=50；返回=1；hasMore=false",
    "src/a.ts",
  ].join("\n");
  assert.equal(stripToolOutputEnvelope("global", global), "src/a.ts");

  // 只剥开头连续块与已知分隔行；正文里形如回执的行原样保留。
  const noisyBody = [
    "[命令执行结果 - 退出码 0；耗时 1ms]",
    "--- 标准输出 (stdout，保留头尾) ---",
    "[1, 2, 3]",
    "路径: 正常输出",
    "总行数=保留",
  ].join("\n");
  assert.equal(
    stripToolOutputEnvelope("bash", noisyBody),
    "[1, 2, 3]\n路径: 正常输出\n总行数=保留",
  );

  // 只有回执、没有正文时剥成空串；未知工具只去证据编号。
  assert.equal(
    stripToolOutputEnvelope(
      "bash",
      "[命令执行结果 - 退出码 0；耗时 1ms]\n(命令执行完成，无控制台输出)",
    ),
    "",
  );
  assert.equal(stripToolOutputEnvelope("mcp_x", "ok\n[verification_evidence_id: c]"), "ok");
});
