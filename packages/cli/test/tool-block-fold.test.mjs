import assert from "node:assert/strict";
import test from "node:test";

import { ToolRunView } from "../dist/activity-indicator.js";
import { FoldStatsCollector } from "../dist/process-fold.js";
import { TerminalUI } from "../dist/terminal-input.js";
import { fgSeq, getTheme, resetActiveColorLevel, setActiveColorLevel } from "../dist/theme.js";
import {
  isToolBlockExpandable,
  renderToolBlockRows,
  TOOL_BLOCK_COLLAPSE_LINES,
  TOOL_BLOCK_EXPAND_LINES,
  TOOL_BLOCK_OUTPUT_MAX_CHARS,
} from "../dist/tool-block-fold.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value) => value.replace(ANSI_RE, "");

function restoreProperty(target, name, descriptor) {
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else delete target[name];
}

/** 交互模式的最小 TerminalUI：不碰真实 raw mode / 备屏（与 process-fold-ui 同一套路）。 */
function createTerminalUI(columns = 80, rows = 24) {
  const ui = new TerminalUI({
    header: "",
    compactHeader: "",
    inputPrompt: "",
    renderBorder: (width) => "-".repeat(width),
  });
  ui.interactive = true;
  ui.started = true;
  ui.startupHeaderVisible = false;
  ui.sidebarEnabled = false;
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
  return ui;
}

function cleanupTerminalUI(ui) {
  for (const key of ["streamRenderTimer", "protocolFlushTimer", "transientHintTimer"]) {
    if (ui[key]) clearTimeout(ui[key]);
    ui[key] = null;
  }
  for (const key of ["agentPanelTimer", "selectionAutoScrollTimer"]) {
    if (ui[key]) clearInterval(ui[key]);
    ui[key] = null;
  }
  ui.started = false;
  ui.interactive = false;
}

/** 在假 stdout 上渲染一帧，返回去掉 ANSI 的屏幕行与原始写缓冲。 */
function render(ui) {
  const writes = [];
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "write");
  try {
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      value: (chunk) => {
        writes.push(String(chunk));
        return true;
      },
    });
    ui.renderFrame();
  } finally {
    restoreProperty(process.stdout, "write", descriptor);
  }
  return {
    writes,
    rows: ui.renderedScreenRows.map(stripAnsi),
    rawRows: [...ui.renderedScreenRows],
  };
}

function withUI(columns, rows, callback) {
  const descriptors = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
    rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
  };
  const ui = createTerminalUI(columns, rows);
  try {
    return callback(ui);
  } finally {
    cleanupTerminalUI(ui);
    restoreProperty(process.stdout, "columns", descriptors.columns);
    restoreProperty(process.stdout, "rows", descriptors.rows);
  }
}

/** 生成 N 行输出文本。 */
const makeOutput = (n) => Array.from({ length: n }, (_, i) => `line-${i}`).join("\n");

function bashBlockInfo(lines = 60, previewLines = 10) {
  return {
    status: "success",
    toolName: "bash",
    summary: "npm test",
    timing: "1.2s",
    resultText: "12 行输出",
    preview: Array.from({ length: previewLines }, (_, i) => `tail-${i}`),
    fullOutput: makeOutput(lines),
    keep: "tail",
  };
}

function runStats() {
  const collector = new FoldStatsCollector();
  collector.addTool("bash", { command: "npm test" }, "success");
  return collector.snapshot();
}

/** 一次完整的「写入工具格 → 封口」流程，返回 UI。 */
function writeToolTurn(ui, info) {
  ui.writeChat("› 跑一下测试\n\n");
  const handle = ui.beginFoldGroup();
  const rows = renderToolBlockPreviewText(info);
  ui.writeToolCells(rows.text, [{ start: 0, end: rows.text.length, info }]);
  ui.sealFoldGroup(handle, ui.getChatLength(), runStats());
  ui.writeChat("结论：测试全绿。\n");
}

/** 模拟提交格文本：用渲染配方拼出头行 + 预览行（与 formatToolCell 口径一致即可）。 */
function renderToolBlockPreviewText(info) {
  const preview = (info.preview ?? []).slice(0, 10);
  const text = [
    `  ✓ ${info.toolName}  ${info.summary}  ${info.timing ?? ""}`,
    `    └ ${info.resultText ?? ""}`,
    ...preview.map((line) => `    ${line}`),
    "",
  ].join("\n");
  return { text };
}

test("renderToolBlockRows collapses to a few preview lines with an expand indicator", () => {
  setActiveColorLevel("mono");
  const info = bashBlockInfo();
  assert.ok(isToolBlockExpandable(info), "10 行预览 + 60 行全文，肯定可展开");
  const rendered = renderToolBlockRows(info, 80, { expanded: false });
  const plain = rendered.rows.map(stripAnsi);

  assert.match(plain[0], /✓ bash\s+npm test/, "头行在最前");
  const previewLines = plain.filter((row) => /tail-\d/.test(row));
  assert.equal(previewLines.length, TOOL_BLOCK_COLLAPSE_LINES, "收起时只给 3 行预览");
  const indicator = plain[rendered.indicatorRow];
  assert.match(indicator, /还有 \d+ 行 · 点击展开/, "指示行报出被折叠的行数");
  resetColors();
});

test("renderToolBlockRows keeps short blocks indicator-free", () => {
  setActiveColorLevel("mono");
  const info = {
    status: "success",
    toolName: "read",
    summary: "src/a.ts",
    resultText: "12 行",
    preview: ["a", "b"],
    keep: "head",
  };
  assert.equal(isToolBlockExpandable(info), false, "预览 2 行且无全文");
  const rendered = renderToolBlockRows(info, 80, { expanded: false });
  assert.equal(rendered.indicatorRow, undefined, "没有可展开的余量就不出指示行");
  resetColors();
});

test("expanded blocks show full preview, output body and a collapse indicator", () => {
  setActiveColorLevel("mono");
  const info = bashBlockInfo(80);
  const rendered = renderToolBlockRows(info, 80, { expanded: true });
  const plain = rendered.rows.map(stripAnsi);

  const previewLines = plain.filter((row) => /tail-\d/.test(row));
  assert.equal(previewLines.length, 10, "预览全量显示");
  const bodyLines = plain.filter((row) => /line-\d/.test(row));
  assert.equal(bodyLines.length, TOOL_BLOCK_EXPAND_LINES, "输出正文给到上限行数");
  // bash 保尾：正文显示的是输出的最后若干行。
  assert.match(bodyLines[0], new RegExp(`line-${80 - TOOL_BLOCK_EXPAND_LINES}`), "保尾从头裁掉");
  assert.match(bodyLines[bodyLines.length - 1], /line-79/, "保尾包含最后一行");
  assert.match(plain[rendered.indicatorRow], /点击收起/);
  assert.match(plain.join("\n"), /前 \d+ 行未显示/, "超出部分有省略标注");
  resetColors();
});

test("hover paints the header with an underline and the indicator with accent color", () => {
  setActiveColorLevel("ansi16");
  const info = bashBlockInfo();
  const plain = renderToolBlockRows(info, 80, { expanded: false, hovered: false });
  const hovered = renderToolBlockRows(info, 80, { expanded: false, hovered: true });
  assert.ok(!plain.rows[0].includes("\x1b[4m"), "常态头行没有下划线");
  assert.ok(hovered.rows[0].includes("\x1b[4m"), "悬停头行加下划线");
  assert.ok(
    stripAnsi(hovered.rows[hovered.indicatorRow]) === stripAnsi(plain.rows[plain.indicatorRow]),
  );
  resetColors();
});

test("tool header keeps the tool name vivid and the summary at full contrast", () => {
  setActiveColorLevel("truecolor");
  const theme = getTheme();
  const [header] = renderToolBlockRows(
    {
      status: "success",
      toolName: "edit",
      summary: "src/theme.ts",
      timing: "1.2s",
      stats: { added: 12, removed: 3 },
      keep: "head",
    },
    80,
    { expanded: false },
  ).rows;

  // 工具名：加粗正文色，靠字重抢眼。
  assert.ok(header.includes(`\x1b[1m${fgSeq(theme.foreground)}edit`), "工具名加粗正文色");
  // 摘要（路径/命令）：强调色、不加粗——与工具名靠色相区分，而不是一起刷成同一种颜色。
  assert.ok(header.includes(`${fgSeq(theme.accent)}src/theme.ts`), "摘要用强调色");
  assert.ok(!header.includes(`\x1b[1m${fgSeq(theme.accent)}src/theme.ts`), "摘要不加粗");
  assert.ok(!header.includes(`${fgSeq(theme.cyan)}src/theme.ts`), "摘要不用青色");
  // 改动行数：加粗红绿，把饱和度留给增删语义。
  assert.ok(header.includes(`\x1b[1m${fgSeq(theme.green)}+12`), "+行数加粗绿");
  assert.ok(header.includes(`\x1b[1m${fgSeq(theme.red)}−3`), "−行数加粗红");
  resetColors();
});

test("ToolRunView.finish archives full output and commitWithBlocks reports block ranges", () => {
  setActiveColorLevel("mono");
  const writes = [];
  const view = new ToolRunView({
    render: (text) => writes.push(text),
    getWidth: () => 80,
  });
  view.register("t1", "bash", "npm test");
  view.start("t1");
  view.finish(
    "t1",
    { status: "success", text: "3 行输出", preview: ["a", "b", "c", "d", "e"] },
    1200,
    makeOutput(30),
  );
  const committed = view.commitWithBlocks();
  assert.ok(committed.text.length > 0);
  assert.equal(committed.blocks.length, 1);
  const block = committed.blocks[0];
  assert.equal(block.start, 0);
  assert.equal(block.end, committed.text.length, "块区间覆盖整格文本");
  assert.equal(block.info.toolName, "bash");
  assert.equal(block.info.keep, "tail", "bash 展开保尾");
  assert.equal(block.info.fullOutput, makeOutput(30));
  assert.equal(block.info.preview.length, 5, "预览全量进配方");
  assert.match(stripAnsi(committed.text.slice(block.start, block.end)), /✓ bash/);
  resetColors();
});

test("full output is archived up to the char cap", () => {
  setActiveColorLevel("mono");
  const view = new ToolRunView({ render: () => {}, getWidth: () => 80 });
  view.register("t1", "read", "big.ts");
  view.start("t1");
  view.finish(
    "t1",
    { status: "success", text: "5000 行" },
    10,
    "x".repeat(TOOL_BLOCK_OUTPUT_MAX_CHARS + 500),
  );
  const { blocks } = view.commitWithBlocks();
  assert.equal(blocks[0].info.fullOutput.length, TOOL_BLOCK_OUTPUT_MAX_CHARS);
  resetColors();
});

test("edit/write receipts are not replayed as the expanded body", () => {
  setActiveColorLevel("mono");
  const receipt =
    "[文件精准编辑成功]\n路径: a.ts\noldHash=0123456789abcdef\nnewHash=fedcba9876543210\n替换次数=1\n改后片段（第 2 行起）:\n   2 | b";
  for (const toolName of ["edit", "write"]) {
    const view = new ToolRunView({ render: () => {}, getWidth: () => 80 });
    view.register("t1", toolName, "a.ts");
    view.start("t1");
    view.finish(
      "t1",
      { status: "success", text: "", preview: ["@@ -1 +1 @@", "-a", "+b"] },
      10,
      receipt,
    );
    const { blocks } = view.commitWithBlocks();
    assert.equal(blocks[0].info.preview.length, 3, "diff 预览保留");
    assert.equal(blocks[0].info.fullOutput, undefined, `${toolName} 回执不进展开正文`);
  }
  // 没有 diff 预览时仍保留正文，但同样剥掉回执外壳（路径 / hash / 片段标签）。
  const bare = new ToolRunView({ render: () => {}, getWidth: () => 80 });
  bare.register("t1", "edit", "a.ts");
  bare.start("t1");
  bare.finish("t1", { status: "success", text: "已替换 1 处" }, 10, receipt);
  const bareBody = bare.commitWithBlocks().blocks[0].info.fullOutput;
  assert.equal(bareBody, "   2 | b");
  assert.doesNotMatch(bareBody, /oldHash|newHash|文件精准编辑成功/);
  resetColors();
});

test("expanded bash body drops the command receipt and section markers", () => {
  setActiveColorLevel("mono");
  const view = new ToolRunView({ render: () => {}, getWidth: () => 80 });
  view.register("t1", "bash", "npm test");
  view.start("t1");
  view.finish(
    "t1",
    { status: "success", text: "2 行输出", preview: ["build=0", "test=0"] },
    10,
    [
      "[命令执行结果 - 退出码 0；耗时 15316ms]",
      "--- 标准输出 (stdout，保留头尾) ---",
      "build=0",
      "test=0",
      "[verification_evidence_id: call_1]",
    ].join("\n"),
  );
  const info = view.commitWithBlocks().blocks[0].info;
  assert.equal(info.fullOutput, "build=0\ntest=0");
  assert.equal(info.keep, "tail");
  resetColors();
});

test("sealed tool blocks open with the fold and collapse individually on click", () => {
  setActiveColorLevel("mono");
  // 高视口 + 小数据：展开态（预览 6 + 正文 10 + 收起行）能整块落在屏内。
  const info = bashBlockInfo(10, 6);
  withUI(80, 44, (ui) => {
    writeToolTurn(ui, info);

    // 折叠态：整段只剩摘要行，块不可见。
    const folded = render(ui).rows.join("\n");
    assert.match(folded, /● 运行 1 条命令/);
    assert.doesNotMatch(folded, /npm test/);

    // 展开过程段：块默认全展开，直接看到输出全文与「点击收起」。
    ui.dispatchKeypress("\x0f", { ctrl: true, name: "o" });
    const expandedRows = render(ui).rows;
    const expanded = expandedRows.join("\n");
    assert.match(expanded, /✓ bash\s+npm test/);
    assert.match(expanded, /点击收起/);
    assert.doesNotMatch(expanded, /还有 \d+ 行 · 点击展开/);
    assert.ok(expanded.includes("line-9"), "段展开后输出全文可见");

    // 点头行 → 只收起这一块：3 行预览 + 展开指示。
    const headerIndex = expandedRows.findIndex((row) => /✓ bash\s+npm test/.test(row));
    assert.ok(headerIndex >= 0, "块头行在屏上");
    ui.handleMouseEvent({ action: "down", button: 0, column: 6, row: headerIndex + 1 });
    ui.handleMouseEvent({ action: "up", button: 0, column: 6, row: headerIndex + 1 });
    const collapsedRows = render(ui).rows;
    const collapsed = collapsedRows.join("\n");
    assert.match(collapsed, /还有 \d+ 行 · 点击展开/);
    assert.ok(!collapsed.includes("line-9"), "全文重新收起");
    const tailCount = collapsedRows.filter((row) => /tail-\d/.test(row)).length;
    assert.equal(tailCount, TOOL_BLOCK_COLLAPSE_LINES);

    // 再点指示行 → 这块重新展开。
    const indicatorIndex = collapsedRows.findIndex((row) => row.includes("点击展开"));
    assert.ok(indicatorIndex >= 0, "指示行在屏上");
    ui.handleMouseEvent({ action: "down", button: 0, column: 6, row: indicatorIndex + 1 });
    ui.handleMouseEvent({ action: "up", button: 0, column: 6, row: indicatorIndex + 1 });
    const blockOpen = render(ui).rows.join("\n");
    assert.match(blockOpen, /点击收起/);
    assert.ok(blockOpen.includes("line-9"), "输出全文再次可见");
  });
  resetColors();
});

test("hovering a tool block underlines its header row", () => {
  setActiveColorLevel("ansi16");
  withUI(80, 24, (ui) => {
    writeToolTurn(ui, bashBlockInfo());
    ui.dispatchKeypress("\x0f", { ctrl: true, name: "o" });
    const before = render(ui).rawRows;
    const headerIndex = before.findIndex((row) => stripAnsi(row).includes("✓ bash"));
    assert.ok(headerIndex >= 0);

    // 悬停（无按键移动，button=3）在块头行上。
    ui.handleMouseEvent({ action: "move", button: 3, column: 6, row: headerIndex + 1 });
    assert.ok(ui.chatHoverTarget?.type === "block", "悬停目标登记为工具块");
    const after = render(ui).rawRows;
    assert.ok(after[headerIndex].includes("\x1b[4m"), "悬停后头行带下划线");

    // 移开：高亮消失。
    ui.handleMouseEvent({ action: "move", button: 3, column: 6, row: 1 });
    const away = render(ui).rawRows;
    assert.ok(!away[headerIndex].includes("\x1b[4m"));
  });
  resetColors();
});

test("hovering a fold summary row highlights it", () => {
  setActiveColorLevel("ansi16");
  withUI(80, 24, (ui) => {
    writeToolTurn(ui, bashBlockInfo());
    const rows = render(ui).rows;
    const summaryIndex = rows.findIndex((row) => row.includes("● 运行 1 条命令"));
    assert.ok(summaryIndex >= 0);
    ui.handleMouseEvent({ action: "move", button: 3, column: 4, row: summaryIndex + 1 });
    assert.ok(ui.chatHoverTarget?.type === "fold");
    const hovered = render(ui).rawRows;
    assert.ok(hovered[summaryIndex].includes("\x1b[1m"), "悬停摘要行换强调色");
  });
  resetColors();
});

test("fold disabled shows blocks fully expanded and still collapsible", () => {
  setActiveColorLevel("mono");
  withUI(80, 44, (ui) => {
    writeToolTurn(ui, bashBlockInfo(10, 6));
    ui.setFoldEnabled(false);
    const rows = render(ui).rows;
    const joined = rows.join("\n");
    assert.match(joined, /✓ bash\s+npm test/, "关闭过程折叠后块完整可见");
    assert.match(joined, /点击收起/, "块默认全展开");
    assert.ok(joined.includes("line-9"), "全文直接铺开");
    assert.doesNotMatch(joined, /还有 \d+ 行 · 点击展开/);

    const headerIndex = rows.findIndex((row) => /✓ bash\s+npm test/.test(row));
    ui.handleMouseEvent({ action: "down", button: 0, column: 6, row: headerIndex + 1 });
    ui.handleMouseEvent({ action: "up", button: 0, column: 6, row: headerIndex + 1 });
    const collapsedRows = render(ui).rows;
    assert.ok(!collapsedRows.join("\n").includes("line-9"), "点头行可单独收起");

    const indicatorIndex = collapsedRows.findIndex((row) => row.includes("点击展开"));
    assert.ok(indicatorIndex >= 0, "收起后出现展开指示行");
    ui.handleMouseEvent({ action: "down", button: 0, column: 6, row: indicatorIndex + 1 });
    ui.handleMouseEvent({ action: "up", button: 0, column: 6, row: indicatorIndex + 1 });
    assert.ok(render(ui).rows.join("\n").includes("line-9"), "点击后重新展开全文");
  });
  resetColors();
});

test("normalization-mismatched cells fall back to plain write", () => {
  setActiveColorLevel("mono");
  withUI(80, 24, (ui) => {
    const before = ui.getChatLength();
    // 文本含制表符：writeChat 归一化会展开，长度变化 → 块元数据弃用。
    ui.writeToolCells("\t✓ bash\tnpm test\n", [{ start: 0, end: 18, info: bashBlockInfo() }]);
    assert.equal(ui.tailToolBlocks.length, 0, "区间会错位的块不登记");
    assert.equal(ui.getChatLength() > before, true, "文本本身照常写入");
  });
  resetColors();
});

/** 回到默认探测（测试进程是非 TTY，等价 mono），避免色档泄漏到其他测试。 */
function resetColors() {
  resetActiveColorLevel();
}
