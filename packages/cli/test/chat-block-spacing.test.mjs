import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 对话区按「块」排版：推理块、助手正文、工具块之间都要有空行。
// 这些间距写在各自的调用点，用源码断言锁住，避免以后又粘回去。
const testDir = path.dirname(new URL(import.meta.url).pathname);
const turnSource = fs.readFileSync(path.resolve(testDir, "../src/turn-runner.ts"), "utf8");
const sessionSource = fs.readFileSync(path.resolve(testDir, "../src/session-commands.ts"), "utf8");

test("实时回合：推理块收尾后与助手正文之间补空行", () => {
  assert.match(
    turnSource,
    /if \(reasoningBlock\.seal\(reasoningContent\)\) ui\.writeBlankLine\(\);/,
  );
});

test("恢复历史：推理块与助手正文之间补空行", () => {
  assert.match(
    sessionSource,
    /if \(m\.reasoning_content && thinkingVisible\) appendHistoryLine\(\);/,
  );
});

test("恢复历史：助手正文与工具块、推理与工具块之间都补空行", () => {
  assert.match(sessionSource, /if \(m\.reasoning_content\) appendHistoryLine\(\);/);
  assert.match(
    sessionSource,
    /正文和工具块之间留一个空行，再让工具块开新段。\s*\n\s*appendHistoryLine\(\);/,
  );
});
