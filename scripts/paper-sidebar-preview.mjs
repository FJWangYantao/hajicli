#!/usr/bin/env node
/** 用真实侧栏渲染函数生成纸间视觉稿；不读取会话，也不启动 provider。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  setActiveColorLevel,
  setThemeAppearance,
  setThemePreset,
} from "../packages/cli/dist/theme.js";
import { buildSidebarFrame, composeSidebarRow } from "../packages/cli/dist/tui-sidebar.js";

setActiveColorLevel("truecolor");
setThemePreset("paper");
setThemeAppearance("light");
const state = {
  usedTokens: 380_000,
  maxTokens: 1_000_000,
  goal: { status: "active", text: "让对话保持专注，让关键状态始终可见。" },
  taskPlan: {
    title: "纸间视觉",
    expanded: false,
    items: [
      { id: "1", content: "梳理信息优先级", status: "completed" },
      { id: "2", content: "收拢工具输出", status: "completed" },
      { id: "3", content: "调整侧栏视觉层级", status: "in_progress", startedAt: Date.now() - 8000 },
      { id: "4", content: "窄屏回归验证", status: "pending" },
    ],
  },
  costCny: 0.4231,
  costRequests: 18,
  lastTurnMs: 12_400,
  compactionCount: 1,
};
const chat = [
  "现在侧栏的信息有点满，能帮我把层级梳理得更清楚吗？",
  "",
  "可以。保留所有关键状态，但让视线先落在当前工作，再看资源用量。",
  "",
  "目标与进行中任务优先 · 上下文与费用退后 · 工具结果按需展开",
  "",
  "✓ read  packages/cli/src/tui-sidebar.ts",
  "✓ edit  packages/cli/src/theme.ts  +12 −8",
];
const sidebarWidth = 32,
  leftWidth = 86,
  height = 26;
const frame = buildSidebarFrame(state, sidebarWidth, height, Date.now());
const rows = Array.from({ length: height }, (_, i) =>
  composeSidebarRow(
    chat[i] ?? "",
    leftWidth,
    frame.rows[i] ?? "",
    sidebarWidth,
    frame.surfaces?.[i],
  ),
);
const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
function ansi(text) {
  let result = "",
    index = 0,
    color = "#45433e",
    background = "#f5f3ee",
    bold = false,
    open = false;
  const paint = () => `color:${color};background:${background}${bold ? ";font-weight:600" : ""}`;
  for (const match of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
    result += escapeHtml(text.slice(index, match.index));
    index = match.index + match[0].length;
    const codes = match[1].split(";").map(Number);
    if (codes[0] === 0) {
      color = "#45433e";
      background = "#f5f3ee";
      bold = false;
    } else if (codes[0] === 1) bold = true;
    else if (codes[0] === 38 && codes[1] === 2) color = `rgb(${codes.slice(2, 5).join(",")})`;
    else if (codes[0] === 48 && codes[1] === 2) background = `rgb(${codes.slice(2, 5).join(",")})`;
    else continue;
    if (open) result += "</span>";
    result += `<span style="${paint()}">`;
    open = true;
  }
  return result + escapeHtml(text.slice(index)) + (open ? "</span>" : "");
}
const html = `<!doctype html><meta charset="utf-8"><title>纸间 · 真实侧栏渲染</title><style>
body{margin:0;background:#dfdcd5;padding:36px;font:14px/1.6 ui-monospace,"Noto Sans Mono CJK SC",monospace}h1{font:500 21px system-ui;color:#45433e}p{font:12px system-ui;color:#716c62}.terminal{display:inline-block;background:#f5f3ee;padding:16px 0;box-shadow:0 12px 40px #45433e22}.top,.input,.status{padding:0 22px;white-space:pre}.top{color:#697750;font-weight:600}.input{margin:0 22px;padding:10px;border:1px solid #c5bdac;color:#716c62}.status{font-size:11px;color:#716c62;padding-top:10px}pre{margin:0;white-space:pre}
</style><h1>纸间 / Warm Paper</h1><p>真实 buildSidebarFrame + composeSidebarRow · /theme paper</p><div class="terminal"><div class="top">haji　纸间视觉　　~/hajicli　　　　　　　　　　　　　　　　master*　 deepseek · medium</div><pre>${rows.map(ansi).join("\n")}</pre><div class="input">› 继续输入，或用 / 查看指令…</div><div class="status">默认权限　 deepseek-chat　 medium　　　　　　　　　　　　　　　　　　　　? 帮助</div></div>`;
const out = join(tmpdir(), "haji", "paper-sidebar-preview.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(out);
