/**
 * 底部面板的纯构建函数：状态栏、活动状态行、任务面板。
 *
 * 与 agent-panel.ts 的 buildAgentPanelRows 同一模式：只读入标量状态，
 * 输出 ANSI 行，不做任何 I/O 或定时器操作，方便用固定宽度做单元测试。
 * TerminalUI 的同名 private 方法是对这里的一层薄委托。
 */
import type { ActivityFrame } from "./activity-indicator.js";
import { formatAgentTokens } from "./agent-panel.js";
import {
  fitHint,
  fitText,
  SEQ,
  splitGraphemes,
  terminalWidth,
  truncateAnsiText,
  truncateTailText,
  truncateText,
} from "./terminal-text.js";
import type { TuiStatusDetail } from "./tui-layout.js";

/** 状态栏所需的会话状态（TerminalUI 持有，渲染时快照传入）。 */
export interface StatusBarState {
  permissionMode: string;
  modelName: string;
  providerName: string;
  reasoningEffort: string;
  currentPath: string;
}

/** 权限档的中文标签（状态栏 / 活动行徽标共用）。 */
export function formatPermissionModeLabel(mode: string): string {
  const modeLabels: Record<string, string> = {
    plan: "计划",
    default: "默认",
    "accept-edit": "自动编辑",
    auto: "自动",
    "bypass-permissions": "全放行",
  };
  return modeLabels[mode] || mode.toUpperCase();
}

/** 构建状态栏单行：权限档 · 模型/强度 · 路径。 */
export function buildStatusBarRow(
  state: StatusBarState,
  width: number,
  detail: TuiStatusDetail = "full",
): string {
  if (width <= 0) return "";
  const modeLabel = formatPermissionModeLabel(state.permissionMode);
  const permText = state.permissionMode ? `[${modeLabel}]` : "";
  // 底栏只有模式标签用强调色；「全放行」是真要警惕的状态，保留红色。
  const permColor = !permText
    ? ""
    : state.permissionMode === "bypass-permissions"
      ? SEQ.boldRed
      : state.permissionMode === "default"
        ? SEQ.muted
        : SEQ.accent;
  const permAnsi = permText ? `${permColor}${permText}${SEQ.reset}` : "";

  // 模型区按实际剩余空间分配（路径优先级最低，排在它之后）。
  const modelLimit = Math.max(
    6,
    Math.min(detail === "full" ? 48 : 40, width - terminalWidth(permAnsi) - 3),
  );
  // 空间不足时依次舍弃提供商、截短模型名，思考强度始终完整保留。
  let modelStr = "";
  if (detail !== "minimal" && state.modelName) {
    const effort = state.reasoningEffort.toLowerCase();
    const candidates = [
      detail === "full" ? [state.providerName, state.modelName, effort] : [],
      [state.modelName, effort],
    ].map((parts) => parts.filter(Boolean).join(" · "));
    modelStr =
      candidates.find((candidate) => candidate && terminalWidth(candidate) <= modelLimit) ||
      (effort
        ? `${fitText(state.modelName, Math.max(1, modelLimit - terminalWidth(effort) - 3))} · ${effort}`
        : fitText(state.modelName, modelLimit));
  }
  const modelAnsi = modelStr ? `${SEQ.muted}${modelStr}${SEQ.reset}` : "";

  const baseLeftAnsi = [permAnsi, modelAnsi].filter(Boolean).join("  ");
  const baseLeftWidth = terminalWidth(baseLeftAnsi);

  let pathAnsi = "";
  if (detail === "full" && state.currentPath) {
    const pathMaxWidth = Math.max(0, width - baseLeftWidth - 3);
    if (pathMaxWidth >= 3) {
      pathAnsi = `${SEQ.muted}${truncateTailText(state.currentPath, pathMaxWidth)}${SEQ.reset}`;
    }
  }
  const fullLeftAnsi = [baseLeftAnsi, pathAnsi].filter(Boolean).join("  ");
  const fitted = truncateAnsiText(fullLeftAnsi, width);
  const padding = " ".repeat(Math.max(0, width - terminalWidth(fitted)));
  return `${fitted}${padding}`;
}

/** 解码动效一轮的时长：前 70% 逐字还原，余下时间完整停留，随后重新打乱。 */
const DECODE_CYCLE_MS = 2600;
const DECODE_RESOLVE_RATIO = 0.7;
/** 乱码字符只用 ASCII：方块/线框类字符在东亚终端里宽度不定，会把行宽撑乱。 */
const DECODE_GLYPHS = "<>/{}=+*#%&$?!~^";
const DECODE_GLYPH_STEP_MS = 140;

/**
 * 「解码」文字：从左到右把乱码还原成目标文字，刚还原的那个字加粗高亮。
 * elapsedMs 为 undefined 时直接输出完整文字（静止态 / 测试）。
 * 宽字符按列宽替换成等宽的乱码，动画过程中整行宽度不变。
 */
export function buildDecodedText(text: string, color: string, elapsedMs?: number): string {
  const graphemes = splitGraphemes(text);
  const plain = `${color}${text}${SEQ.reset}`;
  if (elapsedMs === undefined || graphemes.length === 0) return plain;
  const safeMs = Math.max(0, elapsedMs);
  const progress = (safeMs % DECODE_CYCLE_MS) / (DECODE_CYCLE_MS * DECODE_RESOLVE_RATIO);
  const resolved = Math.min(graphemes.length, Math.floor(progress * graphemes.length));
  if (resolved >= graphemes.length) return plain;

  const step = Math.floor(safeMs / DECODE_GLYPH_STEP_MS);
  let output = "";
  if (resolved > 1) output += `${color}${graphemes.slice(0, resolved - 1).join("")}${SEQ.reset}`;
  if (resolved > 0) output += `${SEQ.bold}${graphemes[resolved - 1]}${SEQ.reset}`;
  output += SEQ.faint;
  for (let index = resolved; index < graphemes.length; index += 1) {
    const cells = terminalWidth(graphemes[index]);
    for (let cell = 0; cell < cells; cell += 1) {
      output += DECODE_GLYPHS[(index * 7 + cell * 3 + step * 13) % DECODE_GLYPHS.length];
    }
  }
  return `${output}${SEQ.reset}`;
}

/** 细节文字的阶段色：等待 / 停滞统一黄色，其余按阶段区分。 */
function activityDetailColor(frame: ActivityFrame): string {
  if (frame.tone === "stalled") return SEQ.boldYellow;
  if (frame.tone === "waiting" || frame.phase === "permission") return SEQ.yellow;
  return frame.phase === "stopping" ? SEQ.red : SEQ.muted;
}

/** 构建活动状态行：图标 + 阶段标签 + 耗时/细节；宽屏右侧显示权限/ctx 徽标或 Esc 提示。 */
export interface ActivityBadge {
  /** 权限档标签（如“自动”），空串时不显示。 */
  modeLabel: string;
  /** 上下文占用比例（0-1）；缺省只显示模式。 */
  ctxRatio?: number;
}

export function buildActivityRow(
  frame: ActivityFrame | undefined,
  width: number,
  badge?: ActivityBadge,
  now = Date.now(),
): string {
  if (!frame || width <= 0) return "";

  // 正常进行中统一用强调色；只有等用户 / 卡住了才换黄色。
  const color =
    frame.tone === "stalled"
      ? SEQ.boldYellow
      : frame.tone === "waiting" || frame.phase === "permission"
        ? SEQ.yellow
        : SEQ.accent;
  // 等待与停滞已由颜色区分；只有停滞时补一个文字提示，避免同一状态重复描述。
  const toneText = frame.tone === "stalled" ? "等待较久" : "";
  const meta = [toneText, frame.idleText].filter(Boolean).join(" · ");
  // 详情保持稳定，活动图标承担动态提示。
  const decodedDetail = frame.detail
    ? buildDecodedText(frame.detail, activityDetailColor(frame))
    : "";
  const primary = `${color}${frame.icon}${SEQ.reset} ${SEQ.bold}${frame.label}${SEQ.reset}`;
  const suffix = `${SEQ.muted}${frame.elapsed}${meta ? ` · ${meta}` : ""}${frame.detail ? " · " : ""}${SEQ.reset}${decodedDetail}`;
  if (width < 32) {
    return truncateAnsiText(`${primary}  ${SEQ.muted}${frame.elapsed}${SEQ.reset}`, width);
  }
  if (width < 60) {
    const compactState = toneText ? ` · ${toneText}` : "";
    return truncateAnsiText(
      `${primary}  ${SEQ.muted}${frame.elapsed}${compactState}${SEQ.reset}`,
      width,
    );
  }
  const row = `${primary}  ${suffix}`;
  if (width < 72) return truncateAnsiText(row, width);

  // 右侧信息：阶段开始后的前 3 秒显示“Esc 中止”（快捷键列表里仍能查到），
  // 之后让位给 [权限] ctx N% 徽标——长任务期间随时可见是否仍在全放行、上下文是否快满。
  const interruptible = ["thinking", "responding", "tool", "batch"].includes(frame.phase);
  const phaseElapsedMs =
    frame.startedAt !== undefined ? now - frame.startedAt : Number.POSITIVE_INFINITY;
  const hintFirst = interruptible && phaseElapsedMs <= 3000 && width >= 100;

  let rightText = "";
  if (hintFirst) {
    rightText = `${SEQ.muted}Esc 中止${SEQ.reset}`;
  } else if (badge?.modeLabel) {
    let ratioColor = SEQ.muted;
    if (badge.ctxRatio !== undefined) {
      if (badge.ctxRatio >= 0.85) ratioColor = SEQ.boldRed;
      else if (badge.ctxRatio >= 0.6) ratioColor = SEQ.yellow;
    }
    const modeColor = badge.modeLabel === "全放行" ? SEQ.boldRed : SEQ.muted;
    const ctxText =
      badge.ctxRatio !== undefined
        ? ` ${ratioColor}ctx ${Math.round(badge.ctxRatio * 100)}%${SEQ.reset}`
        : "";
    rightText = `${SEQ.reset}[${modeColor}${badge.modeLabel}${SEQ.reset}]${ctxText}`;
  }
  if (!rightText) return truncateAnsiText(row, width);
  const rightWidth = terminalWidth(rightText);
  const fittedRow = truncateAnsiText(row, Math.max(1, width - rightWidth - 2));
  const padding = " ".repeat(Math.max(2, width - terminalWidth(fittedRow) - rightWidth));
  return `${fittedRow}${padding}${rightText}`;
}

/** 任务面板条目（含关联 Agent 的展示信息）。 */
export interface TaskPanelItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** 进入进行中的时间戳（ms）；用于右侧显示已耗时。 */
  startedAt?: number;
  agent?: {
    id: string;
    role: string;
    status: "running" | "awaiting_verification" | "verified" | "rejected" | "failed" | "aborted";
    summary?: string;
    /** 子代理累计 tokens（含输入输出）。 */
    tokens?: number;
  };
}

/** 任务面板状态（TerminalUI 持有，渲染时快照传入）。 */
export interface TaskPanelState {
  title: string;
  items: TaskPanelItem[];
  expanded: boolean;
}

/** 已耗时展示：进行中任务与状态栏的口径一致（秒 / 分秒）。 */
function formatElapsedSince(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** 任务面板渲染选项。 */
export interface TaskPanelRenderOptions {
  /**
   * 紧凑模式（侧栏用）：已完成项收成一行计数，把行数让给进行中与待处理项。
   * 用户按 Ctrl+T 展开后恢复逐条显示——那是主动要求看全量，不该再压缩。
   */
  compact?: boolean;
}

/** 构建任务面板行：标题（含整体进度）+ 状态符号行（✓/●/○）+ 可选 Agent 子行 + 折叠脚注。 */
export function buildTaskPanelRows(
  state: TaskPanelState,
  width: number,
  maxRows = 8,
  now = Date.now(),
  options: TaskPanelRenderOptions = {},
): string[] {
  if (!state.title || maxRows <= 0) return [];
  const total = state.items.length;
  const done = state.items.filter((task) => task.status === "completed").length;
  const panelTitle = `任务 · ${state.title}${total > 0 ? `  ${done}/${total}` : ""}`;
  const rows = [`${SEQ.bold}${truncateText(panelTitle, width)}${SEQ.reset}`];
  const compact = options.compact === true && !state.expanded;
  // 紧凑模式下逐条已完成的让位给计数行：标题里的 done/total 已经说明数量。
  const completedTasks = compact ? state.items.filter((task) => task.status === "completed") : [];
  const visibleTasks = compact
    ? state.items.filter((task) => task.status !== "completed")
    : state.expanded
      ? state.items
      : state.items.slice(0, 5);
  const needsFooter =
    completedTasks.length > 0 || state.expanded || state.items.length > visibleTasks.length;
  const taskRowLimit = Math.max(1, maxRows - (needsFooter ? 1 : 0));
  let renderedTaskCount = 0;

  for (const task of visibleTasks) {
    if (rows.length >= taskRowLimit) break;
    if (task.status === "completed") {
      rows.push(
        `${SEQ.green}✓${SEQ.reset} ${SEQ.dim}${truncateText(task.content, Math.max(1, width - 2))}${SEQ.reset}`,
      );
    } else if (task.status === "in_progress") {
      const elapsed = formatElapsedSince(task.startedAt, now);
      const text =
        elapsed && width >= 40
          ? `${truncateText(task.content, Math.max(1, width - elapsed.length - 4))}  ${SEQ.muted}${elapsed}${SEQ.reset}`
          : truncateText(task.content, Math.max(1, width - 2));
      rows.push(`${SEQ.accent}●${SEQ.reset} ${text}`);
    } else {
      rows.push(`${SEQ.muted}○${SEQ.reset} ${truncateText(task.content, Math.max(1, width - 2))}`);
    }
    renderedTaskCount += 1;
    if (task.agent && rows.length < taskRowLimit) {
      const statusLabel =
        task.agent.status === "running"
          ? "运行中"
          : task.agent.status === "awaiting_verification"
            ? "待验证"
            : task.agent.status === "verified"
              ? "已验证"
              : task.agent.status === "aborted"
                ? "已中止"
                : "失败";
      // 状态色只上状态词，角色名用灰。
      const color =
        task.agent.status === "running"
          ? SEQ.accent
          : task.agent.status === "verified"
            ? SEQ.green
            : task.agent.status === "awaiting_verification"
              ? SEQ.yellow
              : SEQ.red;
      const tokensText =
        task.agent.tokens !== undefined && task.agent.tokens > 0
          ? ` · ${SEQ.muted}${formatAgentTokens(task.agent.tokens)}${SEQ.reset}`
          : "";
      rows.push(
        truncateAnsiText(
          `${SEQ.muted}    ↳ ${task.agent.role} · ${SEQ.reset}${color}${statusLabel}${SEQ.reset}${tokensText}`,
          width,
        ),
      );
    }
  }

  if (needsFooter && rows.length < maxRows) {
    // 紧凑模式下被收起来的是「已完成」项，它们排在其它隐藏项之前；
    // 逐条计数仍然准确，用户看到的数量与标题里的 done/total 对得上。
    const hiddenTasks = compact
      ? [...completedTasks, ...visibleTasks.slice(renderedTaskCount)]
      : state.items.slice(renderedTaskCount);
    if (hiddenTasks.length > 0) {
      const doneCount = hiddenTasks.filter((task) => task.status === "completed").length;
      const activeCount = hiddenTasks.filter((task) => task.status === "in_progress").length;
      const pendingCount = hiddenTasks.filter((task) => task.status === "pending").length;
      const statusSummary = [
        doneCount > 0 ? `${doneCount} 已完成` : "",
        activeCount > 0 ? `${activeCount} 进行中` : "",
        pendingCount > 0 ? `${pendingCount} 待处理` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const counts = statusSummary ? ` (${statusSummary})` : "";
      const head = `… 另有 ${hiddenTasks.length} 项${counts}`;
      rows.push(
        `${SEQ.muted}${fitHint(
          [
            `${head} · Ctrl+T ${state.expanded ? "收起" : "展开"}`,
            `${head} · Ctrl+T`,
            head,
            `… 另有 ${hiddenTasks.length} 项`,
          ],
          width,
        )}${SEQ.reset}`,
      );
    } else {
      rows.push(`${SEQ.muted}${fitHint(["… Ctrl+T 收起"], width)}${SEQ.reset}`);
    }
  }
  return rows;
}

/** 回合小结的输入数据（turn-runner 收集，这里只做拼装与宽度舍弃）。 */
export interface TurnSummaryStats {
  durationMs: number;
  outputTokens?: number;
  toolCalls: number;
  /** 本回合工作区改动（来自快照日志）；无改动或缺省时不显示。 */
  changedFiles?: { files: number; added: number; removed: number };
  /** 本回合最近一次编辑后验证结果；未触发时不显示。 */
  typeCheck?: { ok: boolean };
  /** 本回合费用增量（元）；未定价模型传 undefined。 */
  costDeltaCny?: number;
}

/**
 * 构建回合小结单行：完成 · 耗时 · 改动 · 类型检查 · 费用 · 输出 · 工具次数。
 * 超宽时按「工具次数 → 费用 → 类型检查」依次舍弃，保证单行。
 */
export function buildTurnSummary(stats: TurnSummaryStats, width: number): string {
  const duration = formatToolDurationSafe(stats.durationMs);
  const base = `完成 · ${duration}`;
  const changeText = stats.changedFiles
    ? `改动 ${stats.changedFiles.files} 个文件 +${stats.changedFiles.added} −${stats.changedFiles.removed}`
    : "";
  const typeCheckText = stats.typeCheck ? (stats.typeCheck.ok ? "类型检查 ✓" : "类型检查 ✕") : "";
  const costText =
    stats.costDeltaCny !== undefined && stats.costDeltaCny > 0
      ? `¥${stats.costDeltaCny < 0.01 ? stats.costDeltaCny.toFixed(4) : stats.costDeltaCny.toFixed(3)}`
      : "";
  const outputText =
    stats.outputTokens !== undefined ? `输出 ${formatAgentTokens(stats.outputTokens)} tokens` : "";
  const toolText = stats.toolCalls > 0 ? `${stats.toolCalls} 次工具调用` : "";

  const segments = [base, changeText, typeCheckText, costText, outputText, toolText].filter(
    Boolean,
  );
  const dropOrder: Array<() => void> = [
    () => {
      const index = segments.indexOf(toolText);
      if (index >= 0) segments.splice(index, 1);
    },
    () => {
      const index = segments.indexOf(costText);
      if (index >= 0) segments.splice(index, 1);
    },
    () => {
      const index = segments.indexOf(typeCheckText);
      if (index >= 0) segments.splice(index, 1);
    },
  ];
  let dropIndex = 0;
  while (terminalWidth(segments.join(" · ")) > width && dropIndex < dropOrder.length) {
    dropOrder[dropIndex]();
    dropIndex += 1;
  }
  return segments.join(" · ");
}

/** 工具耗时：亚秒显示毫秒，一分钟内保留一位小数（与 cli-runtime.formatToolDuration 同口径）。 */
function formatToolDurationSafe(durationMs: number): string {
  const ms = Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
