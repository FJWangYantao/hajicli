import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 对话区按「块」排版：推理块、助手正文、工具块之间都要有空行。
// 这些间距写在各自的调用点，用源码断言锁住，避免以后又粘回去。
// 用 fileURLToPath 而不是 URL.pathname：后者在 Windows 上给出 /D:/... ，
// path.resolve 会拼成 D:\D:\... 直接 ENOENT。
const testDir = path.dirname(fileURLToPath(import.meta.url));
const turnSource = fs.readFileSync(path.resolve(testDir, "../src/turn-runner.ts"), "utf8");
const sessionSource = fs.readFileSync(path.resolve(testDir, "../src/session-commands.ts"), "utf8");
const indexSource = fs.readFileSync(path.resolve(testDir, "../src/index.ts"), "utf8");

test("实时回合：推理块收尾后与助手正文之间补空行", () => {
  assert.match(
    turnSource,
    /if \(reasoningBlock\.seal\(reasoningContent\)\) ui\.writeBlankLine\(\);/,
  );
});

test("实时回合：思考摘要行不贴在推理块最后一行下面", () => {
  assert.match(
    turnSource,
    /ui\.writeBlankLine\(\);\s*\n\s*ui\.writeLine\(colors\.faint\(` {2}思考 \$\{thinkingSeconds\}s\$\{tokenSummary\}`\)\);/,
  );
});

test("回合中寄存的立即指令输出前后各留一个空行", () => {
  assert.match(
    indexSource,
    /寄存的输出是独立块[\s\S]*?ui\.writeBlankLine\(\);\s*\n\s*for \(const notice of notices\) ui\.writeLine\(notice\);\s*\n\s*ui\.writeBlankLine\(\);/,
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
