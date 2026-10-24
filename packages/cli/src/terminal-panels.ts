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
  fitText,
  SEQ,
  terminalWidth,
  truncateAnsiText,
  truncateTailText,
  truncateText,
} from "./terminal-text.js";
import type { TuiStatusDetail } from "./tui-layout.js";

/** 状态栏所需的会话状态（TerminalUI 持有，渲染时快照传入）。 */
export interface StatusBarState {
  permissionMode: string;
  usedTokens: number;
  maxTokens: number;
  modelName: string;
  providerName: string;
  reasoningEffort: string;
  currentPath: string;
}

/** 构建状态栏单行：权限档 · 模型/强度 · 路径（左） 与 ctx 用量条（右）。 */
export function buildStatusBarRow(
  state: StatusBarState,
  width: number,
  detail: TuiStatusDetail = "full",
): string {
  const modeLabels: Record<string, string> = {
    plan: "计划",
    default: "默认",
    "accept-edit": "自动编辑",
    auto: "自动",
    "bypass-permissions": "全放行",
  };
  const modeLabel = modeLabels[state.permissionMode] || state.permissionMode.toUpperCase();
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

  const used = state.usedTokens;
  const max = state.maxTokens;
  const ratio = Math.min(1, Math.max(0, used / max));

  // 平时用淡紫、数字用灰，不抢眼；快满时才换成黄 / 红提醒。
  let colorCode = SEQ.softAccent;
  let valueColor = SEQ.muted;
  if (ratio >= 0.85) {
    colorCode = SEQ.boldRed;
    valueColor = SEQ.boldRed;
  } else if (ratio >= 0.6) {
    colorCode = SEQ.yellow;
    valueColor = SEQ.yellow;
  }

  const percentText = `${Math.round(ratio * 100)}%`;
  const numText = `${formatAgentTokens(used)}/${formatAgentTokens(max)}`;
  const ctxLabel = "ctx";
  const barCapacity = detail === "full" && width >= 72 ? 8 : 0;

  const filledCount = Math.min(barCapacity, Math.max(0, Math.round(ratio * barCapacity)));
  const emptyCount = Math.max(0, barCapacity - filledCount);
  const barStr =
    barCapacity > 0
      ? `${colorCode}${"█".repeat(filledCount)}${SEQ.reset}${SEQ.faint}${"░".repeat(emptyCount)}${SEQ.reset} `
      : "";
  const valueText = detail === "full" ? numText : percentText;
  const rightAnsi = `${barStr}${SEQ.muted}${ctxLabel}${SEQ.reset} ${valueColor}${valueText}${SEQ.reset}`;
  const rightWidth = terminalWidth(rightAnsi);

  // 模型区按实际剩余空间分配（路径优先级最低，排在它之后）。
  const modelLimit = Math.max(
    6,
    Math.min(detail === "full" ? 48 : 40, width - terminalWidth(permAnsi) - rightWidth - 4),
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
    const pathMaxWidth = Math.max(0, width - baseLeftWidth - rightWidth - 4);
    if (pathMaxWidth >= 3) {
      pathAnsi = `${SEQ.muted}${truncateTailText(state.currentPath, pathMaxWidth)}${SEQ.reset}`;
    }
  }
  const fullLeftAnsi = [baseLeftAnsi, pathAnsi].filter(Boolean).join("  ");
  const fullLeftWidth = terminalWidth(fullLeftAnsi);

  if (fullLeftWidth + rightWidth + 1 <= width) {
    const padding = " ".repeat(width - fullLeftWidth - rightWidth);
    return `${fullLeftAnsi}${padding}${rightAnsi}`;
  }

  if (rightWidth >= width) return truncateAnsiText(rightAnsi, width);
  const availableLeft = Math.max(0, width - rightWidth - 1);
  const fittedLeft = truncateAnsiText(fullLeftAnsi, availableLeft);
  const padding = " ".repeat(Math.max(1, width - terminalWidth(fittedLeft) - rightWidth));
  return `${fittedLeft}${padding}${rightAnsi}`;
}

/** 构建活动状态行：图标 + 阶段标签 + 耗时/细节，右侧按空间常驻 Esc 中止提示。 */
export function buildActivityRow(frame: ActivityFrame | undefined, width: number): string {
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
  const detail = [toneText, frame.idleText, frame.detail].filter(Boolean).join(" · ");
  const primary = `${color}${frame.icon}${SEQ.reset} ${SEQ.bold}${frame.label}${SEQ.reset}`;
  const suffix = `${SEQ.muted}${frame.elapsed}${detail ? ` · ${detail}` : ""}${SEQ.reset}`;
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
  // 可中止的阶段在右侧常驻按键提示；空间不足时让位给左侧状态。
  const interruptible = ["thinking", "responding", "tool", "batch"].includes(frame.phase);
  const hint = "Esc 中止";
  const hintWidth = terminalWidth(hint);
  if (!interruptible || width < 100) return truncateAnsiText(row, width);
  const fittedRow = truncateAnsiText(row, width - hintWidth - 2);
  const padding = " ".repeat(Math.max(2, width - terminalWidth(fittedRow) - hintWidth));
  return `${fittedRow}${padding}${SEQ.muted}${hint}${SEQ.reset}`;
}

/** 任务面板条目（含关联 Agent 的展示信息）。 */
export interface TaskPanelItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  agent?: {
    id: string;
    role: string;
    status: "running" | "awaiting_verification" | "verified" | "rejected" | "failed" | "aborted";
    summary?: string;
  };
}

/** 任务面板状态（TerminalUI 持有，渲染时快照传入）。 */
export interface TaskPanelState {
  title: string;
  items: TaskPanelItem[];
  expanded: boolean;
}

/** 构建任务面板行：标题 + 状态符号行（✓/●/○）+ 可选 Agent 子行 + 折叠脚注。 */
export function buildTaskPanelRows(state: TaskPanelState, width: number, maxRows = 8): string[] {
  if (!state.title || maxRows <= 0) return [];
  const panelTitle = state.title ? `任务 · ${state.title}` : "任务";
  const rows = [`${SEQ.bold}${truncateText(panelTitle, width)}${SEQ.reset}`];
  const visibleTasks = state.expanded ? state.items : state.items.slice(0, 5);
  const needsFooter = state.expanded || state.items.length > visibleTasks.length;
  const taskRowLimit = Math.max(1, maxRows - (needsFooter ? 1 : 0));
  let renderedTaskCount = 0;

  for (const task of visibleTasks) {
    if (rows.length >= taskRowLimit) break;
    if (task.status === "completed") {
      rows.push(
        `${SEQ.green}✓${SEQ.reset} ${SEQ.dim}${truncateText(task.content, Math.max(1, width - 2))}${SEQ.reset}`,
      );
    } else if (task.status === "in_progress") {
      rows.push(`${SEQ.accent}●${SEQ.reset} ${truncateText(task.content, Math.max(1, width - 2))}`);
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
      rows.push(
        truncateAnsiText(
          `${SEQ.muted}    ↳ ${task.agent.role} · ${SEQ.reset}${color}${statusLabel}${SEQ.reset}`,
          width,
        ),
      );
    }
  }

  if (needsFooter && rows.length < maxRows) {
    const hiddenTasks = state.items.slice(renderedTaskCount);
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
      rows.push(
        `${SEQ.muted}${truncateText(`… 另有 ${hiddenTasks.length} 项${counts} · Ctrl+T ${state.expanded ? "收起" : "展开"}`, width)}${SEQ.reset}`,
      );
    } else {
      rows.push(`${SEQ.muted}${truncateText("… Ctrl+T 收起", width)}${SEQ.reset}`);
    }
  }
  return rows;
}
