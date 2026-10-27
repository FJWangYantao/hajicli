import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPermissionPreview,
  DIFF_PREVIEW_LINES,
  summarizeToolResult,
} from "../dist/cli-runtime.js";
import {
  buildEditDiff,
  buildWriteDiff,
  diffWidthFor,
  formatDiffHeader,
  normalizeDiffLines,
  preferredDiffWidth,
} from "../dist/diff-preview.js";
import { fitText, terminalWidth } from "../dist/terminal-text.js";
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
  // 常规宽度走单列 unified：上下文行 `行号 │ 内容`，删/增各占一行。
  assert.ok(lines.some((line) => /^ {3}1 │ {3}const a = 1;/.test(line)));
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

test("preferredDiffWidth mirrors the TUI chat width, and ANSI rows truncate cleanly", () => {
  // 宽终端（120 列）：wide 布局 chatPadding=3，safeWidth=119 → 对话区 113 → 内容宽 105。
  // 偏宽哪怕 1 列都会让补白到满宽的分栏行整行被截断（右栏消失）。
  Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
  try {
    assert.equal(preferredDiffWidth(), 105);
    // 舒适档（80 列）：chatPadding=2 → safeWidth=79 → 75 − 8 = 67。
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
    assert.equal(preferredDiffWidth(), 67);
  } finally {
    Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
  }
  // fitText 截断带 ANSI 的行时不能把转义序列当可见字符吃宽度（会提前截进转义中间、右栏被裁）。
  const colored = `\x1b[38;2;120;184;146m${"const value = ".repeat(12)}\x1b[0m`;
  const fitted = fitText(colored, 40);
  assert.ok(terminalWidth(fitted) <= 40, `截断后宽度应 ≤40: ${terminalWidth(fitted)}`);
  assert.ok(fitted.endsWith("…"), "截断应以省略号收尾");
  // 截断点之后的可见内容确实被丢掉，且没有裸露的半个转义序列。
  assert.ok(!/\[[0-9;]*$/.test(fitted), "不应残留不完整的转义序列");
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

/** 与工具层 contentHash 同口径（sha256 前 16 位），用来构造 edit 成功输出。 */
function sha16(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 构造 edit 工具的成功输出（含 oldHash 与「改后片段」行号回显）。 */
function editSuccessOutput(before, after, newText, startLine) {
  return [
    "[文件精准编辑成功]",
    "路径: sample.ts",
    `oldHash=${sha16(before)}`,
    `newHash=${sha16(after)}`,
    "替换次数=1",
    `改后片段（第 ${startLine} 行起）:`,
    `   ${startLine} | ${newText}`,
  ].join("\n");
}

test("completed edit block reuses the pre-edit content (same patch as the permission card)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-diff-complete-"));
  try {
    const oldText = "const b = load(path);";
    const newText = "const b = await load(path);";
    const after = SAMPLE.replace(oldText, newText);
    fs.writeFileSync(path.join(cwd, "sample.ts"), after, "utf8");
    const args = { path: "sample.ts", oldText, newText };
    const output = editSuccessOutput(SAMPLE, after, newText, 2);

    // 传了 cwd：从磁盘内容把 newText 换回 oldText 重建原文，渲染出与授权卡片同一份 patch。
    const summary = summarizeToolResult("edit", output, { blocked: false }, args, cwd);
    assert.equal(summary.status, "success");
    // 改动行数并进头行（`+a −r`），不再占单独的 `└` 结果行。
    assert.deepEqual(summary.stats, { added: 1, removed: 1 });
    assert.equal(summary.text, "");
    assert.deepEqual(
      summary.preview,
      buildEditDiff(SAMPLE, oldText, newText, preferredDiffWidth(), DIFF_PREVIEW_LINES).lines,
    );
    // 单 hunk 不画 `@@` 头，位置由行号说明。
    assert.ok(!summary.preview.some((line) => plain(line).includes("@@")));
    assert.ok(summary.preview.some((line) => plain(line).includes("− const b = load(path);")));
    assert.ok(
      summary.preview.some((line) => plain(line).includes("+ const b = await load(path);")),
    );

    // 回放历史（不传 cwd）时退回片段对比：仍有增删行，但没有真实行号与上下文。
    const replayed = summarizeToolResult("edit", output, { blocked: false }, args);
    assert.ok(replayed.preview.some((line) => plain(line).includes("− const b = load(path);")));
    assert.ok(!replayed.preview.some((line) => plain(line).includes("const a = 1;")));

    // oldHash 对不上（重建结果不可信）时也退回片段对比，不拿错版本冒充真实行号。
    const tampered = summarizeToolResult(
      "edit",
      output.replace(/oldHash=.*/, `oldHash=${sha16("另一个版本")}`),
      { blocked: false },
      args,
      cwd,
    );
    assert.ok(!tampered.preview.some((line) => plain(line).includes("const a = 1;")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("truncated previews keep the changed rows instead of the leading context", () => {
  const original = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const body = buildEditDiff(original, "line 6", "line six", 80, 3);
  const lines = body.lines.map(plain);
  assert.ok(body.hiddenLines > 0);
  // 3 行窗口：单 hunk 不画头；单列视图删、增各占一行，后跟下一行上下文。
  assert.ok(lines[0].includes("− line 6"));
  assert.ok(lines[1].includes("+ line six"));
  assert.ok(lines.some((line) => line.includes("还有")));
});

test("wide terminals pair del with add side-by-side; regular widths use unified rows", () => {
  const original = ["head", "alpha = 1;", "beta = 2;", "tail"].join("\n");
  const args = ["beta = 2;", ["beta = 20;", "gamma = 3;"].join("\n")];

  // 宽终端（每侧 ≥68 列）才左右分栏：配对的删 + 增合并为同一视觉行（左旧右新）。
  const split = buildEditDiff(original, args[0], args[1], 160);
  const splitLines = split.lines.map(plain);
  const paired = splitLines.find((line) => line.includes("− beta = 2;"));
  assert.ok(paired, "配对行应包含左侧删除");
  assert.ok(paired?.includes("+ beta = 20;"), "配对行应同时包含右侧新增");
  // 未配对的新增行：左侧整栏留空（行号也不画），新行号从配对行顺延。
  const unpaired = splitLines.find((line) => line.includes("+ gamma = 3;"));
  assert.match(unpaired ?? "", /^\s*│ {3}4 \+ gamma = 3;/);
  // 所有分栏行的分隔符列与行宽一致（右栏不漂移、整行不超宽）。
  const dividers = new Set(splitLines.map((line) => line.indexOf("│")));
  assert.equal(dividers.size, 1, `分隔符应固定在同一列: ${splitLines.join("\n")}`);
  for (const line of split.lines) {
    assert.ok(terminalWidth(line) <= 160, `行宽超限: ${terminalWidth(line)}`);
  }

  // 常规宽度（120 列终端的 105）退回单列 unified：删/增分行、内容占满全宽。
  const unified = buildEditDiff(original, args[0], args[1], 105);
  const unifiedLines = unified.lines.map(plain);
  assert.ok(unifiedLines.some((line) => /^ {3}3 │ − beta = 2;/.test(line)));
  assert.ok(unifiedLines.some((line) => /^ {3}3 │ \+ beta = 20;/.test(line)));
  assert.ok(unifiedLines.some((line) => /^ {3}4 │ \+ gamma = 3;/.test(line)));
  for (const line of unified.lines) {
    assert.ok(terminalWidth(line) <= 105, `行宽超限: ${terminalWidth(line)}`);
  }
});

test("change cells paint a whole-cell bar in truecolor; context rows stay plain", () => {
  setActiveColorLevel("truecolor");
  try {
    // 新建文件：纯新增行，整块铺淡绿条。
    const created = buildWriteDiff(undefined, "alpha = 1;\n", 80);
    const added = created.lines[0];
    assert.match(added, /\x1b\[48;/, "变更行应带背景铺色");
    assert.match(added, / {2,}\x1b\[0m/, "铺色应延伸覆盖行尾补白");
    // 单元格内截断也不产生残缺转义（… 落在铺色/重置之后）。
    const long = buildWriteDiff(undefined, `${"const x".repeat(30)} = 1;\n`, 64);
    for (const line of long.lines) {
      assert.ok(!/\[[0-9;]*$/.test(line), "不应残留不完整的转义序列");
    }
    // 编辑：变更行带铺色，上下文行保持无底色。
    const edited = buildEditDiff(
      SAMPLE,
      "const b = load(path);",
      "const b = await load(path);",
      80,
    );
    const context = edited.lines.find((line) => plain(line).includes("const a = 1;"));
    assert.ok(context, "应存在上下文行");
    assert.ok(!/\x1b\[48;/.test(context ?? ""), "上下文行不应铺底色");
    const change = edited.lines.find((line) => plain(line).includes("− const b ="));
    assert.match(change ?? "", /\x1b\[48;/, "变更行应铺底色");
  } finally {
    setActiveColorLevel("mono");
  }
});

test("diffWidthFor derives the build width from the UI content width", () => {
  assert.equal(diffWidthFor(113), 105);
  assert.equal(diffWidthFor(72), 64);
  assert.equal(diffWidthFor(30), 40);
  assert.equal(diffWidthFor(300), 232);
});

test("buildPermissionPreview honors the UI content width (sidebar-aware)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-diff-width-"));
  try {
    const target = path.join(cwd, "sample.ts");
    fs.writeFileSync(target, SAMPLE, "utf8");
    // 120 列终端 + 侧栏打开：对话区内容宽只剩 72，diff 必须按 64 建，
    // 否则每行都比渲染宽长一截，右栏整列被裁。
    const preview = buildPermissionPreview(
      "edit",
      {
        path: "sample.ts",
        oldText: "const b = load(path);",
        newText: "const b = await load(path);",
      },
      cwd,
      72,
    );
    for (const line of preview) {
      assert.ok(terminalWidth(line) <= 64, `行宽应 ≤64: ${terminalWidth(line)}`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
