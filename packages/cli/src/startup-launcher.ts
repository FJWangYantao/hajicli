import { type RecentSessionEntry, relativeTime, startupActions } from "./startup-home.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { SEQ, terminalWidth, truncateAnsiText, truncateText } from "./terminal-text.js";
import { bgSeq, getTheme, themeReset } from "./theme.js";
import type { SidebarState } from "./tui-sidebar.js";

export interface LauncherHit {
  row: number;
  left: number;
  right: number;
  index: number;
}

export function startupLauncherGeometry(width: number, height: number) {
  const contentWidth = Math.min(64, Math.max(1, width - (width >= 40 ? 8 : 6)));
  return {
    contentWidth,
    left: Math.floor((width - contentWidth) / 2),
    footerRows: 2,
    maxInputRows: Math.max(1, Math.min(6, Math.floor(height / 6))),
    maxSuggestionRows: height >= 24 ? 3 : 1,
  };
}

function clean(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function pad(text: string, width: number): string {
  const clipped = truncateAnsiText(text, width);
  return clipped + " ".repeat(Math.max(0, width - terminalWidth(clipped)));
}

/** 首屏排版只消费真实输入行；光标、补全与输入选区仍由 TerminalUI 管理。 */
export function buildStartupLauncher(options: {
  width: number;
  height: number;
  header: readonly string[];
  compactHeader: string;
  inputRows: readonly string[];
  sessions: readonly RecentSessionEntry[];
  selected: number;
  state: SidebarState;
  status: string;
  notice?: string;
  now?: number;
}): {
  rows: string[];
  inputTop: number;
  hits: LauncherHit[];
  footerTop: number;
  contextRow: number;
} {
  const { width, height, state } = options;
  const geometry = startupLauncherGeometry(width, height);
  const { contentWidth, left, footerRows } = geometry;
  // 状态区始终贴近底部，内容从顶部自然排列；中间留白用于区分输入与会话。
  const footerTop = height - footerRows - 1;
  const rows: string[] = Array.from({ length: height }, () => "");
  const hits: LauncherHit[] = [];
  const paint = (row: number, text: string, column = left, budget = contentWidth): void => {
    if (row < 0 || row >= height) return;
    rows[row] = " ".repeat(column) + truncateAnsiText(text, budget);
  };
  // 品牌只保留一行；输入区是唯一带边框和底色的操作卡片。
  const remaining = footerTop - options.inputRows.length;
  if (remaining >= 3) {
    const brand = clean(options.compactHeader).toLowerCase() || "haji";
    paint(
      1,
      `${SEQ.boldAccent}${brand}${SEQ.reset}${SEQ.muted}  ·  AI coding assistant${SEQ.reset}`,
    );
  }
  const inputTop = Math.min(3, Math.max(0, footerTop - options.inputRows.length));
  const background = bgSeq(getTheme().userMsgBg);
  const reset = themeReset();
  const panelReset = reset + background;
  const surface = (text: string): string => (reset ? text.split(reset).join(panelReset) : text);
  const border = (first: string, last: string): string =>
    `${background}${SEQ.softAccent}${first}${"─".repeat(contentWidth)}${last}${reset}`;
  options.inputRows.forEach((row, index) => {
    paint(
      inputTop + index,
      `${SEQ.softAccent}│${SEQ.reset}${background} ${surface(pad(row, contentWidth))} ${SEQ.softAccent}│${reset}`,
    );
  });
  if (inputTop > 0) paint(inputTop - 1, border("╭", "╮"));
  paint(inputTop + options.inputRows.length, border("╰", "╯"));
  let next = inputTop + options.inputRows.length + 2;
  const workspace = state.workspace;
  const branch =
    workspace?.gitStatus === "not-repository"
      ? "非 Git 仓库"
      : workspace?.gitStatus === "unavailable"
        ? "Git 状态暂不可用"
        : clean(workspace?.branch ?? "");
  const project = workspace
    ? `${clean(workspace.name)}${branch ? ` · ${branch}` : ""}`
    : "状态读取中";
  const task = state.taskPlan;
  const taskText = task
    ? `任务 ${task.items.filter((item) => item.status === "completed").length}/${task.items.length} · ${clean(task.title)}`
    : state.goal?.status === "active"
      ? `目标 ${clean(state.goal.text)}`
      : "";
  const entriesBottom = footerTop;
  const actions = startupActions(options.sessions);
  const actionCount = Math.min(3, Math.max(0, entriesBottom - next));
  const horizontal = contentWidth >= 56 && actionCount === 3;
  if (horizontal) {
    const slot = Math.floor(contentWidth / 3);
    let line = "";
    for (let index = 0; index < 3; index++) {
      const active = index === options.selected;
      const label = truncateText(`${index + 1} ${actions[index].label}`, slot - 1);
      line += `${active ? SEQ.boldAccent : SEQ.muted}${pad(label, slot)}${SEQ.reset}`;
      hits.push({
        row: next,
        left: left + slot * index,
        right: left + slot * (index + 1) - 2,
        index,
      });
    }
    paint(next++, line);
  } else {
    for (let index = 0; index < actionCount; index++) {
      const active = index === options.selected;
      hits.push({ row: next, left, right: left + contentWidth - 1, index });
      paint(
        next++,
        `${active ? SEQ.boldAccent : SEQ.muted}${index + 1} ${actions[index].label}${SEQ.reset}`,
      );
    }
  }
  const available = entriesBottom - next;
  const recent = options.sessions.slice(0, Math.max(0, Math.min(3, available - 2)));
  if (recent.length) {
    next++;
    paint(next++, `${SEQ.softAccent}最近会话${SEQ.reset}`);
    const now = options.now ?? Date.now();
    recent.forEach((session, index) => {
      const stamp = relativeTime(session.updatedAt, now);
      const titleWidth = Math.max(1, contentWidth - (contentWidth >= 40 ? 16 : 2));
      const title = truncateText(clean(session.title) || "未命名会话", titleWidth);
      const active = index + 3 === options.selected;
      paint(
        next++,
        `${active ? SEQ.boldAccent : SEQ.muted}${active ? "›" : "·"} ${contentWidth >= 40 ? pad(title, titleWidth) + stamp : title}${SEQ.reset}`,
      );
      hits.push({ row: next - 1, left, right: left + contentWidth - 1, index: index + 3 });
    });
  }
  const statusTop = entriesBottom;
  const footer = (offset: number, text: string): void => paint(statusTop + offset, text);
  footer(0, `${SEQ.softAccent}${"─".repeat(contentWidth)}${SEQ.reset}`);
  const ratio = state.maxTokens > 0 ? Math.round((state.usedTokens / state.maxTokens) * 100) : 0;
  const contextRow = statusTop + 1;
  const totalChanges = workspace
    ? workspace.modified + workspace.added + workspace.deleted + workspace.untracked
    : 0;
  const projectStatus = `${project}${totalChanges ? ` · ${totalChanges} 项改动` : ""}${workspace?.conflicted ? ` · 冲突 ${workspace.conflicted}` : ""}`;
  const cost = `¥${(state.costCny ?? 0).toFixed(4)}${state.hasUnpricedCost ? "+?" : ""}`;
  const detailedResource = `ctx ${ratio}% · ${state.usedTokens.toLocaleString("en-US")} / ${state.maxTokens.toLocaleString("en-US")} · ${cost}`;
  const resource =
    terminalWidth(projectStatus) + terminalWidth(detailedResource) + 2 <= contentWidth
      ? detailedResource
      : `ctx ${ratio}% · ${cost}`;
  const taskStatus = taskText ? ` · ${taskText}` : "";
  const combinedStatus = `${projectStatus}${taskStatus}`;
  const leftStatus = truncateText(
    terminalWidth(combinedStatus) + terminalWidth(resource) + 2 <= contentWidth
      ? combinedStatus
      : [taskText, workspace?.conflicted ? `冲突 ${workspace.conflicted}` : "", projectStatus]
          .filter(Boolean)
          .join(" · "),
    Math.max(1, contentWidth - terminalWidth(resource) - 3),
  );
  footer(
    1,
    `${SEQ.muted}${pad(leftStatus, contentWidth - terminalWidth(resource) - 2)}  ${resource}${SEQ.reset}`,
  );
  return {
    rows,
    inputTop,
    hits,
    footerTop: statusTop,
    contextRow,
  };
}
