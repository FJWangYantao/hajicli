import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPermissionPreview } from "../dist/cli-runtime.js";
import {
  buildEditDiff,
  buildWriteDiff,
  formatDiffHeader,
  normalizeDiffLines,
} from "../dist/diff-preview.js";
import { terminalWidth } from "../dist/terminal-text.js";
import { setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

const SAMPLE = [
  "const a = 1;",
  "const b = load(path);",
  "const c = a + b;",
  "return c;",
  "// end",
].join("\n");

function plain(line) {
  // mono 模式下无 ANSI；保险起见仍剥一遍转义序列。
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

test("buildEditDiff locates oldText with line numbers and context", () => {
  const body = buildEditDiff(SAMPLE, "const b = load(path);", "const b = await load(path);", 80);
  const lines = body.lines.map(plain);
  // 上下文 ±2 行 + 单行替换；行号从 2 开始（oldText 位于第 2 行）。
  assert.equal(body.startLine, 2);
  assert.equal(body.stats.added, 1);
  assert.equal(body.stats.removed, 1);
  assert.ok(
    lines.some((line) => /^ {1}1 {1} {3}const a = 1;$/.test(line) || line.includes("const a = 1;")),
  );
  assert.ok(lines.some((line) => line.includes("−") && line.includes("const b = load(path);")));
  assert.ok(lines.some((line) => line.includes("+") && line.includes("await load(path);")));
  // 上下文行出现（替换点前后各 2 行）。
  assert.ok(lines.some((line) => line.includes("return c;")));
});

test("buildEditDiff handles multi-line insertion", () => {
  const body = buildEditDiff(SAMPLE, "return c;", "return {\n  value: c,\n  ok: true,\n};", 80);
  assert.equal(body.stats.added, 4);
  assert.equal(body.stats.removed, 1);
  assert.equal(body.startLine, 4);
});

test("buildEditDiff normalizes CRLF files", () => {
  const crlf = SAMPLE.replace(/\n/g, "\r\n");
  const body = buildEditDiff(crlf, "const c = a + b;", "const c = a + b + 1;", 80);
  assert.equal(body.stats.added, 1);
  assert.equal(body.stats.removed, 1);
  assert.equal(body.startLine, 3);
  for (const line of body.lines) {
    assert.ok(!line.includes("\r"), "CRLF 不应残留在展示行");
  }
});

test("buildEditDiff falls back to block comparison when oldText is missing", () => {
  const body = buildEditDiff("完全不同的内容", "const x = 1;", "const x = 2;", 80);
  assert.equal(body.stats.added, 1);
  assert.equal(body.stats.removed, 1);
  assert.ok(body.lines.some((line) => plain(line).includes("const x = 1;")));
});

test("buildWriteDiff compares existing content and previews new files", () => {
  const replaced = buildWriteDiff(SAMPLE, SAMPLE.replace("const a = 1;", "const a = 2;"), 80);
  assert.equal(replaced.stats.added, 1);
  assert.equal(replaced.stats.removed, 1);

  const created = buildWriteDiff(undefined, "a\nb\nc\n", 80);
  assert.equal(created.stats.added, 3);
  assert.equal(created.stats.removed, 0);
});

test("diff rows are truncated to the requested width (wide chars included)", () => {
  const longLine = `${"很长的中文注释".repeat(20)}//`;
  const original = ["short", longLine, "tail"].join("\n");
  for (const width of [40, 80, 120]) {
    const body = buildEditDiff(original, "short", "shorter version", width);
    for (const line of body.lines) {
      assert.ok(terminalWidth(line) <= width + 2, `${width}: ${terminalWidth(line)}`);
    }
  }
});

test("buildEditDiff marks truncated remainder", () => {
  const original = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  const oldText = Array.from({ length: 20 }, (_, index) => `line ${index + 5}`).join("\n");
  const body = buildEditDiff(original, oldText, "replaced", 80, 6);
  assert.ok(body.hiddenLines > 0);
  assert.ok(body.lines.some((line) => plain(line).includes("还有")));
});

test("formatDiffHeader renders path and stats", () => {
  const header = plain(formatDiffHeader("src/foo.ts", { added: 3, removed: 1 }, "新建"));
  assert.match(header, /src\/foo\.ts {2}\+3 −1 {2}新建/);
});

test("permission preview reads the original file for an accurate diff", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-diff-preview-"));
  try {
    const target = path.join(cwd, "sample.ts");
    fs.writeFileSync(target, SAMPLE, "utf8");
    const preview = buildPermissionPreview(
      "edit",
      {
        path: "sample.ts",
        oldText: "const b = load(path);",
        newText: "const b = await load(path);",
      },
      cwd,
    );
    const lines = preview.map(plain);
    assert.match(lines[0], /sample\.ts {2}\+1 −1/);
    assert.ok(lines.some((line) => line.includes("− const b = load(path);")));
    assert.ok(lines.some((line) => line.includes("+ const b = await load(path);")));

    const write = buildPermissionPreview(
      "write",
      { path: "sample.ts", content: "// overwritten\n" },
      cwd,
    );
    assert.match(write[0], /sample\.ts {2}\+1 −5 {2}覆盖已有文件/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalizeDiffLines strips a single trailing newline and keeps empty input empty", () => {
  assert.deepEqual(normalizeDiffLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(normalizeDiffLines(""), []);
  assert.deepEqual(normalizeDiffLines("a"), ["a"]);
});
