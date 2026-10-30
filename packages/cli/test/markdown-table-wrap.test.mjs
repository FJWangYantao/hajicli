import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MarkdownStreamRenderer } from "../dist/markdown-renderer.js";
import {
  resetActiveTheme,
  resetThemeAppearance,
  setActiveColorLevel,
  themeReset,
} from "../dist/theme.js";

/**
 * 表格可用性回归：143 列终端 + 右侧栏时 `ui.getContentWidth()` 实测为 101
 * （resolveTuiLayout(143, 40).safeWidth = 142，侧栏 34 + 间距 3，两侧内边距 2×2）。
 * 夹具就是在这个宽度下抓的真实输出。
 */
const CONTENT_WIDTH = 101;

const WIDE_TABLE_MARKDOWN = [
  "| 模块 | 负责人 | 状态 | 最近更新时间 | 备注说明 |",
  "| --- | --- | --- | --- | --- |",
  "| 终端 Markdown 流式渲染引擎 | 张伟 | 进行中 | 2025-06-11 14:32 | 需要保证 CJK 双宽字符对齐且不截断长中文单元格内容 |",
  "| 会话上下文压缩与摘要 | 李娜 | 已完成 | 2025-06-10 09:05 | 压缩后仍需保留关键工具调用记录与验证证据链 |",
  "| 权限规则引擎 | 王强 | 待开始 | 2025-06-09 18:47 | 需要覆盖项目级与会话级两级授权以及拒绝后的降级路径 |",
].join("\n");

const WIDE_TABLE_CELLS = [
  "终端 Markdown 流式渲染引擎",
  "会话上下文压缩与摘要",
  "权限规则引擎",
  "2025-06-11 14:32",
  "需要保证 CJK 双宽字符对齐且不截断长中文单元格内容",
  "压缩后仍需保留关键工具调用记录与验证证据链",
  "需要覆盖项目级与会话级两级授权以及拒绝后的降级路径",
];

const NARROW_TABLE_MARKDOWN = [
  "| 名称 | 状态 |",
  "| --- | --- |",
  "| 渲染器 | 就绪 |",
  "| 侧栏 | 关闭 |",
].join("\n");

const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

/** 折行会在单元格内插入换行与内边距，校验「原文没丢」时按空白归一后再比对。 */
const squeeze = (value) => value.replace(/\s+/g, "");

const isWideChar = (cp) =>
  cp >= 0x1100 &&
  (cp <= 0x115f ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd));

/** 终端显示宽度：CJK / 全角 / Emoji 按 2 列计。 */
const displayWidth = (value) => {
  let width = 0;
  for (const ch of value) width += isWideChar(ch.codePointAt(0)) ? 2 : 1;
  return width;
};

/** 每个匹配字符所在的显示列（从 0 起），用于校验竖线对齐。 */
const displayColumnsOf = (value, needle) => {
  const columns = [];
  let width = 0;
  for (const ch of value) {
    if (ch === needle) columns.push(width);
    width += isWideChar(ch.codePointAt(0)) ? 2 : 1;
  }
  return columns;
};

/**
 * 按竖线把每行切回列，再把同一列在各物理行上的片段拼起来。
 * 折行只会在单元格内部插入换行与内边距，因此「某一列的拼接结果包含完整原文」
 * 就等价于该单元格没有被截断。
 */
const columnTexts = (rows) => {
  const dividerRow = rows.find((row) => row.includes("│"));
  const dividerColumns = displayColumnsOf(dividerRow, "│");
  const texts = dividerColumns.map(() => "");
  for (const row of rows) {
    if (!row.includes("│")) continue;
    let width = 0;
    let next = 0;
    let current = "";
    const flush = () => {
      if (next < texts.length) texts[next] += current;
      current = "";
      next += 1;
    };
    for (const ch of row) {
      if (next < dividerColumns.length && width === dividerColumns[next]) flush();
      if (ch !== "│") current += ch;
      width += isWideChar(ch.codePointAt(0)) ? 2 : 1;
    }
    flush();
  }
  return texts.map(squeeze);
};

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function renderTable(markdown, width = CONTENT_WIDTH) {
  setActiveColorLevel("truecolor");
  resetThemeAppearance();
  resetActiveTheme();
  return new MarkdownStreamRenderer(() => width).render(markdown, true);
}

test("长中文 5 列表按列宽折行：单元格原文完整保留，不再出现省略号", () => {
  const rendered = renderTable(WIDE_TABLE_MARKDOWN);
  const plain = stripAnsi(rendered);

  assert.equal(`${rendered}\n`, fixture("markdown-table-wide-143.after.ansi.txt"));
  assert.equal(rendered.includes("…"), false);
  const columns = columnTexts(plain.split("\n"));
  for (const cell of WIDE_TABLE_CELLS) {
    assert.ok(
      columns.some((column) => column.includes(squeeze(cell))),
      `单元格原文应完整保留：${cell}`,
    );
  }
  // 短列（负责人 = 6 列宽）不再被按比例压窄，表头不被截断。
  assert.ok(plain.includes("│ 负责人 │"));
  assert.equal(plain.includes("负责…"), false);
});

test("改造前的输出确实被截断（回归夹具留档）", () => {
  const before = fixture("markdown-table-wide-143.before.ansi.txt");
  const plain = stripAnsi(before);

  assert.ok(before.includes("…"), "改造前的夹具应记录硬截断症状");
  assert.ok(plain.includes("负责…"), "改造前连表头都被按比例压窄后截断");
  assert.equal(
    plain.includes("需要保证 CJK 双宽字符对齐且不截断长中文单元格内容"),
    false,
    "改造前长中文单元格内容被截断",
  );
});

test("每行显示宽度一致且不超过内容宽（CJK 双宽按 2 列计），竖线逐列对齐", () => {
  for (const width of [CONTENT_WIDTH, 72, 60]) {
    const rendered = renderTable(WIDE_TABLE_MARKDOWN, width);
    const rows = stripAnsi(rendered).split("\n");

    for (const row of rows) {
      assert.ok(
        displayWidth(row) <= width,
        `行宽 ${displayWidth(row)} 超过内容宽 ${width}：${row}`,
      );
    }
    const widths = new Set(rows.map(displayWidth));
    assert.equal(widths.size, 1, `同一张表的所有行应等宽，实际：${[...widths].join(",")}`);

    const barColumns = rows
      .filter((row) => row.includes("│"))
      .map((row) => displayColumnsOf(row, "│").join(","));
    assert.equal(
      new Set(barColumns).size,
      1,
      `折行后竖线仍应在同一显示列：${barColumns.join(" | ")}`,
    );
    assert.equal(rendered.includes("…"), false);
  }
});

test("折行保留 ANSI 样式：每行重新开启粗体，且行尾样式不溢出到边框", () => {
  const longBold = "这是一段需要折行的加粗长中文说明，用来验证样式在换行后仍然续接而不是被截断";
  const rendered = renderTable(
    ["| 名称 | 说明 |", "| --- | --- |", `| **重点** | **${longBold}** |`].join("\n"),
    72,
  );
  const rows = rendered.split("\n");
  const plain = stripAnsi(rendered);

  assert.ok(
    columnTexts(plain.split("\n")).some((column) => column.includes(squeeze(longBold))),
    "加粗单元格原文应完整保留",
  );
  // 表头一行 + 折行后的表体若干行，每行都要自带粗体开启序列。
  const boldRows = rows.filter((row) => row.includes("\x1b[1m"));
  assert.ok(boldRows.length >= 3, `长文本应折成多行且每行重新开启粗体，实际 ${boldRows.length} 行`);
  // 边框与内边距在单元格 reset 之后输出，行尾必须是主题 reset（样式不溢出）。
  const reset = themeReset();
  for (const row of rows) {
    assert.ok(row.endsWith(reset), `行尾应以主题 reset 收尾：${JSON.stringify(row.slice(-24))}`);
  }
  assert.ok(rows.every((row) => displayWidth(stripAnsi(row)) === displayWidth(stripAnsi(rows[0]))));
});

test("表格紧跟在工具块行之后仍按表格折行渲染，工具块行原样保留", () => {
  const longNote =
    "改动集中在 renderTable 的列宽分配与单元格折行，工具块与 Markdown 表在同一个对话缓冲里相邻时不应互相影响";
  const rendered = renderTable(
    [
      "  ✓ bash  已运行  12ms",
      "  │ total 3 files changed",
      "",
      "| 文件 | 变更说明 |",
      "| --- | --- |",
      `| packages/cli/src/markdown-renderer.ts | ${longNote} |`,
    ].join("\n"),
    101,
  );
  const plain = stripAnsi(rendered);
  const rows = plain.split("\n");

  assert.ok(plain.includes("  ✓ bash  已运行  12ms"), "工具块头行应原样保留");
  assert.ok(plain.includes("  │ total 3 files changed"), "工具块输出行应原样保留");
  assert.equal(rendered.includes("…"), false);

  const gridRows = rows.filter(
    (row) =>
      row.startsWith("┌") || row.startsWith("│") || row.startsWith("├") || row.startsWith("└"),
  );
  assert.ok(gridRows.length >= 5, "应渲染出带边框的表格");
  assert.ok(
    columnTexts(gridRows).some((column) => column.includes(squeeze(longNote))),
    "表格长单元格应完整折行",
  );
  const gridWidths = new Set(gridRows.map(displayWidth));
  assert.equal(gridWidths.size, 1, "表格各行等宽");
});

test("窄表（列宽够）输出与改造前逐字节一致", () => {
  const rendered = renderTable(NARROW_TABLE_MARKDOWN);

  assert.equal(`${rendered}\n`, fixture("markdown-table-narrow.ansi.txt"));
  assert.equal(rendered.includes("…"), false);
});
