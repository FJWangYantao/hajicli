/**
 * PR 巡检详情页的纯渲染层：把巡检任务列表排成占据对话区的一屏。
 *
 * 与 cost-log-page 同一模式：只读标量状态、输出 ANSI 行，不做 I/O、不持定时器。
 * 每行宽度严格等于传入的 width，超出统一裁剪，因此可以固定宽度直接单测。
 *
 * 版式：顶框（巡检状态与任务数）/ 列名 / 可滚动的任务列表 / 分隔 / 选中项口径 / 底框。
 * 打开期间侧栏临时收起（由 TerminalUI 统一处理），所以这里按整行宽度排版。
 */

import {
  backHit,
  backLabelFor,
  bottomBorder,
  frameRow,
  hLine,
  padToWidth,
  topBorder,
} from "./cost-log-page.js";
import { SEQ, terminalWidth, truncateText } from "./terminal-text.js";

/** 页面本身要求的最小宽度/高度；再小由调用方拦下并提示。 */
export const PATROL_PAGE_MIN_COLUMNS = 48;
export const PATROL_PAGE_MIN_ROWS = 8;
/** 低于该宽度时只保留「PR / 状态 / 费用」三列。 */
const COMPACT_MIN_WIDTH = 76;

const PR_WIDTH = 5;
const STATUS_WIDTH = 8;
const HEAD_WIDTH = 7;
const ROUNDS_WIDTH = 7;
const COST_WIDTH = 9;
const FIXED_COLUMNS = PR_WIDTH + STATUS_WIDTH + HEAD_WIDTH + ROUNDS_WIDTH + COST_WIDTH + 5; // 5 个列间空格
const BRANCH_MIN_WIDTH = 12;

/** 页面展示用的任务快照：由调用方从 core 的 PatrolJob 投影，页面层不依赖存储细节。 */
export interface PatrolPageJob {
  prNumber: number;
  branch: string;
  targetBranch: string;
  /** 状态中文标签（由调用方按 core 状态映射）。 */
  statusLabel: string;
  /** 已进入终态（已合并 / 已终止）：用成功色，与进行中的橙色区分。 */
  terminal: boolean;
  headSha: string;
  fixRounds: number;
  adjudicationRounds: number;
  costCny: number;
  taskBrief: string;
  terminatedReason?: string;
  /** 最近一次运行的摘要（例如「审查中 · 第 2 次重试」），没有时缺省。 */
  lastRun?: string;
}

/** 页面状态：由 TerminalUI 持有；刷新任务列表只替换 jobs。 */
export interface PatrolPageState {
  jobs: PatrolPageJob[];
  selectedIndex: number;
  /** 巡检循环是否在跑。 */
  running: boolean;
  paused: boolean;
  repo?: string;
}

/** 一帧的产物：屏幕行 + 鼠标命中区域（行号均为 0 基，相对本帧）。 */
export interface PatrolPageFrame {
  rows: string[];
  listTop: number;
  listHeight: number;
  listLeft: number;
  listWidth: number;
  /** 列表首行对应的下标；选中项滚出视野时 > 0。 */
  listOffset: number;
  itemHeight: number;
  /** 当前选中项在列表里的下标（夹紧后的值，回写给调用方）。 */
  selectedIndex: number;
  /** 顶栏「Esc 返回」的命中范围。 */
  back: { row: number; left: number; width: number };
}

/** 顶栏标题：巡检循环状态 + 任务数 + 仓库。 */
function titleText(state: PatrolPageState): string {
  const phase = state.paused ? "已暂停" : state.running ? "运行中" : "未运行";
  const parts = ["PR 巡检", phase, `共 ${state.jobs.length} 个任务`];
  if (state.repo) parts.push(state.repo);
  return parts.join(" · ");
}

/** 列名行；窄屏只保留三列，避免把列挤成一团。 */
function headerRow(inner: number, compact: boolean): string {
  const cell = (text: string, width: number, align: "left" | "right" = "left"): string =>
    padToWidth(`${SEQ.muted}${text}${SEQ.reset}`, width, align);
  if (compact) {
    return padToWidth(
      [cell("PR", PR_WIDTH), cell("状态", STATUS_WIDTH), cell("费用", COST_WIDTH, "right")].join(
        " ",
      ),
      inner,
    );
  }
  const branchWidth = Math.max(BRANCH_MIN_WIDTH, inner - FIXED_COLUMNS);
  return padToWidth(
    [
      cell("PR", PR_WIDTH),
      cell("分支 → 目标", branchWidth),
      cell("状态", STATUS_WIDTH),
      cell("head", HEAD_WIDTH),
      cell("轮次", ROUNDS_WIDTH, "right"),
      cell("费用", COST_WIDTH, "right"),
    ].join(" "),
    inner,
  );
}

/** 一个任务占一行。 */
function jobRow(
  job: PatrolPageJob,
  inner: number,
  branchWidth: number,
  compact: boolean,
  selected: boolean,
): string {
  const marker = selected ? "▸" : " ";
  const pr = padToWidth(
    `${selected ? SEQ.boldAccent : SEQ.faint}${marker}#${job.prNumber}${SEQ.reset}`,
    PR_WIDTH,
  );
  const statusColor = job.terminal ? SEQ.green : SEQ.yellow;
  const status = padToWidth(
    `${statusColor}${truncateText(job.statusLabel, STATUS_WIDTH)}${SEQ.reset}`,
    STATUS_WIDTH,
  );
  const cost = padToWidth(
    `${selected ? SEQ.accent : SEQ.reset}¥${job.costCny.toFixed(2)}${SEQ.reset}`,
    COST_WIDTH,
    "right",
  );
  if (compact) return padToWidth([pr, status, cost].join(" "), inner);
  const branch = padToWidth(
    `${selected ? SEQ.accent : SEQ.muted}${truncateText(
      `${job.branch} → ${job.targetBranch}`,
      branchWidth,
    )}${SEQ.reset}`,
    branchWidth,
  );
  const head = padToWidth(`${SEQ.faint}${job.headSha.slice(0, 7)}${SEQ.reset}`, HEAD_WIDTH);
  const rounds = padToWidth(
    `${selected ? SEQ.accent : SEQ.faint}${job.fixRounds}/${job.adjudicationRounds}${SEQ.reset}`,
    ROUNDS_WIDTH,
    "right",
  );
  return padToWidth([pr, branch, status, head, rounds, cost].join(" "), inner);
}

/** 选中项的完整口径：任务简述、终止原因、最近一次运行。 */
function detailLine(job: PatrolPageJob | undefined, width: number): string {
  if (!job) return frameRow(width, `${SEQ.muted}暂无巡检任务。${SEQ.reset}`);
  const parts = [
    `#${job.prNumber}`,
    job.statusLabel,
    `修改 ${job.fixRounds} / 裁决 ${job.adjudicationRounds}`,
    `¥${job.costCny.toFixed(2)}`,
  ];
  if (job.terminatedReason) parts.push(`终止原因：${job.terminatedReason}`);
  if (job.lastRun) parts.push(job.lastRun);
  parts.push(job.taskBrief);
  return frameRow(width, `${SEQ.muted}${parts.join(" · ")}${SEQ.reset}`);
}

/**
 * 排出整屏页面。
 *
 * 行结构：顶框 / 列名 / 列表 ×N / 分隔 / 选中详情 / 底框，固定占 5 行；
 * 高度不够时优先保住列表。
 */
export function buildPatrolFrame(
  state: PatrolPageState,
  width: number,
  height: number,
): PatrolPageFrame {
  const safeWidth = Math.max(PATROL_PAGE_MIN_COLUMNS, Math.floor(width));
  const safeHeight = Math.max(PATROL_PAGE_MIN_ROWS, Math.floor(height));
  const inner = safeWidth - 2;
  const compact = safeWidth < COMPACT_MIN_WIDTH;
  const branchWidth = Math.max(BRANCH_MIN_WIDTH, inner - FIXED_COLUMNS);
  const itemHeight = 1;

  const selectedIndex = Math.min(
    Math.max(0, state.selectedIndex),
    Math.max(0, state.jobs.length - 1),
  );
  const listHeight = Math.max(itemHeight, safeHeight - 5);
  const visibleItems = Math.max(1, Math.floor(listHeight / itemHeight));
  const listOffset = Math.max(
    0,
    Math.min(selectedIndex - visibleItems + 1, Math.max(0, state.jobs.length - visibleItems)),
  );

  const listRows: string[] = [];
  for (let index = 0; index < visibleItems; index += 1) {
    const job = state.jobs[listOffset + index];
    if (!job) {
      listRows.push("");
      continue;
    }
    const isSelected = listOffset + index === selectedIndex;
    listRows.push(jobRow(job, inner, branchWidth, compact, isSelected));
  }
  while (listRows.length < listHeight) listRows.push("");

  const rows: string[] = [];
  rows.push(topBorder(safeWidth, titleText(state)));
  rows.push(frameRow(safeWidth, headerRow(inner, compact)));
  for (const row of listRows.slice(0, listHeight)) rows.push(frameRow(safeWidth, row));
  rows.push(hLine(safeWidth));
  rows.push(detailLine(state.jobs[selectedIndex], safeWidth));
  rows.push(bottomBorder(safeWidth, compact ? "Esc 或点右上返回" : "↑↓ 选择 · Esc 或点右上返回"));
  while (rows.length < safeHeight) rows.push(padToWidth("", safeWidth));

  const backText = ` ${backLabelFor(safeWidth)} `;
  return {
    rows: rows.slice(0, safeHeight),
    listTop: 2,
    listHeight,
    listLeft: 1,
    listWidth: inner,
    listOffset,
    itemHeight,
    selectedIndex,
    back: backHit(terminalWidth(backText), safeWidth),
  };
}
