#!/usr/bin/env node
/**
 * 侧栏视觉对照表：把同一份会话状态在不同「宽 × 高」下渲染成一张 HTML，
 * 再用 scripts/shot.mjs 截成图片（终端里可以直接看图核对档位切换）。
 *
 * 为什么需要它：侧栏的档位（full / compact / minimal）、圆环→进度条的退让、
 * 「▸ 明细」提示在窄栏的取舍，都只有在真实尺寸下才看得出问题；
 * 逐个尺寸盯着测试断言读不出「看起来挤不挤」。
 *
 * 用法：
 *   node scripts/sidebar-gallery.mjs                       # 写 <tmp>/haji/sidebar-gallery.html
 *   node scripts/sidebar-gallery.mjs --out ./gallery.html
 *   node scripts/shot.mjs "$(node scripts/sidebar-gallery.mjs)"     # 一条命令出图
 *   node scripts/sidebar-gallery.mjs --text                # 只在终端里打印纯文本对照（不出图）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSidebarFrame,
  composeSidebarRow,
  resolveSidebarWidth,
  SIDEBAR_GAP_WIDTH,
  sidebarDensity,
} from "../packages/cli/dist/tui-sidebar.js";

/** 终端里除了对话视口之外的固定占用（顶栏 + 输入框），用于换算侧栏可用高度。 */
const CHROME_ROWS = 6;

const CASES = [
  { columns: 96, rows: 24, note: "窄屏最低配" },
  { columns: 120, rows: 30, note: "默认窗口" },
  { columns: 120, rows: 20, note: "矮窗口" },
  { columns: 160, rows: 40, note: "宽屏" },
];

const BASE_STATE = {
  usedTokens: 298_000,
  maxTokens: 1_000_000,
  goal: {
    status: "active",
    text: "把侧栏的信息层级重做一遍：当前在做什么优先于资源与账单，长目标不能把上下文顶出去。",
  },
  taskPlan: {
    title: "侧栏层级",
    expanded: false,
    items: [
      { id: "1", content: "重排信息优先级", status: "completed" },
      { id: "2", content: "费用明细默认折叠", status: "completed" },
      { id: "3", content: "接上键盘快捷键", status: "in_progress", startedAt: Date.now() - 92_000 },
      { id: "4", content: "补窄宽度排版测试", status: "pending" },
      { id: "5", content: "固定状态视觉核对", status: "pending" },
    ],
  },
  agents: [
    {
      id: "a1",
      role: "审阅者",
      status: "running",
      totalTokens: 24_500,
      maxTokens: 100_000,
      startedAt: Date.now() - 61_000,
      currentTool: "grep",
    },
    { id: "a2", role: "调研者", status: "verified", totalTokens: 12_000 },
  ],
  costCny: 0.4231,
  costRequests: 18,
  hasUnpricedCost: true,
  unpricedModels: ["mystery-model"],
  promptTokens: 812_400,
  completionTokens: 63_200,
  cachedPromptTokens: 604_000,
  offPeakRequests: 9,
  lastTurnMs: 12_400,
  compactionCount: 1,
};

const VARIANTS = [
  { name: "费用明细折叠", state: { costDetailsExpanded: false } },
  { name: "费用明细展开", state: { costDetailsExpanded: true } },
];

const ANSI_RE = /\x1b\[([0-9;]*)m/g;
const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** SGR → span：只处理侧栏实际用到的真彩色/加粗/暗色/重置。 */
function ansiToHtml(line) {
  const styles = { 1: "font-weight:600", 2: "opacity:.62", 3: "font-style:italic" };
  const colorPattern = /color:[^;"]+/g;
  let html = "";
  let style = null;
  let index = 0;
  for (const match of line.matchAll(ANSI_RE)) {
    html += escapeHtml(line.slice(index, match.index));
    index = match.index + match[0].length;
    const codes = match[1].split(";").filter(Boolean).map(Number);
    if (codes.length === 0 || codes.includes(0)) {
      if (style) html += "</span>";
      style = null;
      continue;
    }
    if (codes[0] === 38 && codes[1] === 2) {
      const color = `color:rgb(${codes[2]},${codes[3]},${codes[4]})`;
      style = `${(style ?? "").replace(colorPattern, "")}${color}`;
      continue;
    }
    if (codes[0] === 39) {
      style = style ? style.replace(colorPattern, "") : null;
      continue;
    }
    if (styles[codes[0]] && style === null) style = styles[codes[0]];
  }
  html += escapeHtml(line.slice(index));
  if (style) html += "</span>";
  // 未闭合的 span 会让整块串色，逐行自洽是硬要求。
  return html;
}

function stripAnsi(value) {
  return value.replace(ANSI_RE, "");
}

function escapeHtml(value) {
  return value.replace(/[&<>]/g, (char) => ESCAPE[char] ?? char);
}

/** 对话区占位：只为让侧栏处在真实宽度关系里，内容本身不重要。 */
function chatColumn(leftWidth, rows) {
  const filler = [
    "› 侧栏现在把目标放在最上面了吗？",
    "",
    "  是的：目标 → 任务 → 代理 → 上下文 → 费用。",
    "",
    "### 侧栏层级重做",
    "",
    "- 目标原文占用两行以内，超出折叠",
    "- 费用明细默认收在「▸ 明细」后面",
  ];
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    const text = filler[row % filler.length];
    lines.push(text.length > leftWidth ? text.slice(0, Math.max(0, leftWidth)) : text);
  }
  return lines;
}

function renderCase(testCase, variant) {
  const sidebarWidth = resolveSidebarWidth(testCase.columns, testCase.rows, true);
  const chatHeight = Math.max(1, testCase.rows - CHROME_ROWS);
  const leftWidth = Math.max(8, testCase.columns - sidebarWidth - SIDEBAR_GAP_WIDTH);
  const state = { ...BASE_STATE, ...variant.state };
  const frame = buildSidebarFrame(state, sidebarWidth, chatHeight, Date.now());
  const chat = chatColumn(leftWidth, chatHeight);
  const rows = [];
  for (let row = 0; row < chatHeight; row += 1) {
    rows.push(
      composeSidebarRow(
        chat[row] ?? "",
        leftWidth,
        frame.rows[row] ?? "",
        Math.max(0, sidebarWidth - 1),
      ),
    );
  }
  return { rows, sidebarWidth, chatHeight };
}

function buildHtml() {
  const blocks = [];
  for (const testCase of CASES) {
    for (const variant of VARIANTS) {
      const { rows, sidebarWidth, chatHeight } = renderCase(testCase, variant);
      const density = sidebarDensity(chatHeight);
      const caption =
        testCase.columns +
        "×" +
        testCase.rows +
        " · " +
        testCase.note +
        " · 侧栏 " +
        sidebarWidth +
        " 列 / " +
        chatHeight +
        " 行 · 档位 " +
        density +
        " · " +
        variant.name;
      blocks.push(
        "<section><h2>" +
          escapeHtml(caption) +
          "</h2><pre>" +
          rows.map((row) => ansiToHtml(row)).join("\n") +
          "</pre></section>",
      );
    }
  }
  return [
    '<!doctype html><meta charset="utf-8">',
    "<title>侧栏视觉对照表</title>",
    "<style>",
    "body{background:#141414;color:#d8d8d8;font:13px/1.28 ui-monospace,Consolas,monospace;margin:24px}",
    "h1{font:600 18px system-ui;color:#eee;margin:0 0 18px}",
    "section{margin:0 0 26px}",
    "h2{font:600 12px system-ui;color:#8ab4f8;margin:0 0 8px;letter-spacing:.02em}",
    "pre{background:#0d0d0d;border:1px solid #242424;border-radius:6px;padding:12px 14px;margin:0;white-space:pre;overflow:auto}",
    "</style>",
    "<h1>右侧栏 · 宽度 / 高度 / 折叠状态对照</h1>",
    blocks.join("\n"),
  ].join("");
}

if (process.argv.includes("--text")) {
  const asText = [];
  for (const testCase of CASES) {
    for (const variant of VARIANTS) {
      const { rows, sidebarWidth, chatHeight } = renderCase(testCase, variant);
      asText.push(
        "=== " +
          testCase.columns +
          "×" +
          testCase.rows +
          " · 侧栏 " +
          sidebarWidth +
          " 列 / " +
          chatHeight +
          " 行 · 档位 " +
          sidebarDensity(chatHeight) +
          " · " +
          variant.name +
          " ===",
      );
      for (const row of rows) {
        asText.push("|" + stripAnsi(row).padEnd(sidebarWidth - 1) + "|");
      }
      asText.push("");
    }
  }
  process.stdout.write([...asText, ""].join("\n"));
  process.exit(0);
}

const outIndex = process.argv.indexOf("--out");
const outPath =
  outIndex > 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : join(tmpdir(), "haji", "sidebar-gallery.html");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, buildHtml(), "utf8");
// 只打印路径：调用方可以直接把它喂给 scripts/shot.mjs。
process.stdout.write(outPath + "\n");
