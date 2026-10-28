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
  const contentWidth = Math.min(80, Math.max(1, width - (width >= 40 ? 8 : 6)));
  return {
    contentWidth,
    left: Math.floor((width - contentWidth) / 2),
    footerRows: height >= 18 ? 6 : 2,
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
  // 外框上下各预留一行，状态区预算用于裁剪欢迎内容；最终紧跟内容排放。
  const footerTop = height - footerRows - 1;
  const rows: string[] = Array.from({ length: height }, () => "");
  const hits: LauncherHit[] = [];
  const paint = (row: number, text: string, column = left, budget = contentWidth): void => {
    if (row < 0 || row >= height) return;
    rows[row] = " ".repeat(column) + truncateAnsiText(text, budget);
  };
  const centered = (row: number, text: string): void => {
    const clipped = truncateAnsiText(text, contentWidth);
    paint(row, clipped, Math.max(0, Math.floor((width - terminalWidth(clipped)) / 2)));
  };
  // 先为真实输入预留空间，依次收紧会话间距、Logo 和引导空行。
  const remaining = footerTop - options.inputRows.length;
  const fullHeader =
    options.header.length > 0 &&
    options.header.length <= 7 &&
    options.header.every((row) => terminalWidth(row) <= contentWidth) &&
    remaining >= options.header.length + 12;
  const header = remaining < 3 ? [] : fullHeader ? options.header : [options.compactHeader];
  const headerTop = remaining >= header.length + 14 ? 2 : 1;
  header.forEach((row, index) => {
    centered(headerTop + index, row);
  });
  let next = headerTop + header.length;
  if (remaining >= header.length + 11) {
    centered(++next, `${SEQ.boldAccent}你想完成什么？${SEQ.reset}`);
    next += 2;
  } else next++;
  const inputTop = Math.min(next, Math.max(0, footerTop - options.inputRows.length));
  options.inputRows.forEach((row, index) => {
    paint(inputTop + index, row);
  });
  next = inputTop + options.inputRows.length;
  if (footerTop - next >= 10) next++;
  const workspace = state.workspace;
  const branch =
    workspace?.gitStatus === "not-repository"
      ? "非 Git 仓库"
      : workspace?.gitStatus === "unavailable"
        ? "Git 状态暂不可用"
        : clean(workspace?.branch ?? "");
  const project = workspace
    ? `工作区  ${clean(workspace.name)}${branch ? ` · ${branch}` : ""}`
    : "工作区  状态读取中";
  const counts =
    workspace && workspace.gitStatus === "ready"
      ? `修改 ${workspace.modified} · 新增 ${workspace.added} · 删除 ${workspace.deleted} · 未跟踪 ${workspace.untracked}${workspace.conflicted ? ` · 冲突 ${workspace.conflicted}` : ""}`
      : "";
  const task = state.taskPlan;
  const taskText = task
    ? `任务 ${task.items.filter((item) => item.status === "completed").length}/${task.items.length} · ${clean(task.title)}`
    : state.goal?.status === "active"
      ? `目标 ${clean(state.goal.text)}`
      : "当前任务  尚未开始";
  const statusRows = footerRows >= 6 ? 3 : 2;
  const entriesBottom = height - statusRows - 1;
  if (footerRows >= 6) {
    paint(next++, `${SEQ.accent}${project}${SEQ.reset}`);
    paint(next++, `${SEQ.accent}${taskText}${SEQ.reset}`);
    paint(next++, `${workspace?.conflicted ? SEQ.yellow : SEQ.muted}${counts}${SEQ.reset}`);
    if (entriesBottom - next >= 5) next++;
  }
  const actions = startupActions(options.sessions);
  const horizontal = contentWidth >= 62;
  const actionCount = Math.min(3, Math.max(0, entriesBottom - next));
  if (horizontal && actionCount > 0) {
    const slot = Math.floor(contentWidth / 3);
    let line = "";
    for (let index = 0; index < 3; index++) {
      const active = index === options.selected;
      const label = truncateText(`${active ? "›" : "·"} ${actions[index].label}`, slot - 1);
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
      hits.push({ row: next, left, right: left + contentWidth - 1, index });
      paint(
        next++,
        `${index === options.selected ? SEQ.boldAccent : SEQ.muted}${index === options.selected ? "›" : "·"} ${actions[index].label}${SEQ.reset}`,
      );
    }
  }
  const available = entriesBottom - next;
  const recent = options.sessions.slice(0, Math.max(0, Math.min(3, available - 2)));
  if (recent.length) {
    const step = available >= recent.length * 2 + 3 ? 2 : 1;
    next++;
    paint(next++, `${SEQ.accent}最近会话${SEQ.reset}`);
    const now = options.now ?? Date.now();
    recent.forEach((session, index) => {
      const stamp = relativeTime(session.updatedAt, now);
      const titleWidth = Math.max(1, contentWidth - (contentWidth >= 40 ? 16 : 2));
      const title = truncateText(clean(session.title) || "未命名会话", titleWidth);
      const active = index + 3 === options.selected;
      paint(
        next,
        `${active ? SEQ.boldAccent : SEQ.muted}${active ? "›" : "·"} ${contentWidth >= 40 ? pad(title, titleWidth) + stamp : title}${SEQ.reset}`,
      );
      hits.push({ row: next, left, right: left + contentWidth - 1, index: index + 3 });
      next += step;
    });
  }
  if (entriesBottom - next >= 2) {
    centered(next++, `${SEQ.muted}Tab 选择 · Enter 打开 · 点击入口${SEQ.reset}`);
  }
  const statusTop = Math.min(entriesBottom, next + (entriesBottom - next >= 2 ? 1 : 0));
  const footerWidth = contentWidth;
  const footer = (offset: number, text: string): void =>
    paint(statusTop + offset, text, left, footerWidth);
  footer(0, `${SEQ.softAccent}${"─".repeat(footerWidth)}${SEQ.reset}`);
  const ratio = state.maxTokens > 0 ? Math.round((state.usedTokens / state.maxTokens) * 100) : 0;
  const resource = `上下文 ${ratio}% · ${state.usedTokens.toLocaleString("en-US")} / ${state.maxTokens.toLocaleString("en-US")}   费用 ¥${(state.costCny ?? 0).toFixed(4)}${state.hasUnpricedCost ? " + 未定价" : ""}`;
  const contextRow = statusTop + 1;
  if (footerRows >= 6) {
    const compactResource = `上下文 ${ratio}% · ¥${(state.costCny ?? 0).toFixed(4)}${state.hasUnpricedCost ? "+?" : ""}`;
    footer(
      1,
      `${SEQ.muted}${terminalWidth(resource) <= footerWidth ? resource : compactResource}${SEQ.reset}`,
    );
    footer(2, options.notice || options.status);
  } else {
    footer(
      1,
      `${SEQ.muted}${truncateText(clean(workspace?.name ?? "工作区"), Math.max(1, footerWidth - 18))} · ${ratio}% · ¥${(state.costCny ?? 0).toFixed(2)}${state.hasUnpricedCost ? "+?" : ""}${SEQ.reset}`,
    );
  }
  const panelBottom = statusTop + statusRows;
  const panelLeft = left - 2;
  const innerWidth = contentWidth + 2;
  const background = bgSeq(getTheme().userMsgBg);
  const reset = themeReset();
  const panelReset = reset + background;
  const surface = (text: string): string => (reset ? text.split(reset).join(panelReset) : text);
  const border = (first: string, last: string): string =>
    `${" ".repeat(panelLeft)}${background}${SEQ.softAccent}${first}${"─".repeat(innerWidth)}${last}${reset}`;
  rows[0] = border("╭", "╮");
  for (let row = 1; row < panelBottom; row++) {
    // 已排好的行采用屏幕列；去掉外部留白，再补满面板内部。每个 reset 后恢复卡片底色。
    const content = (rows[row] ?? "").slice(left);
    rows[row] =
      `${" ".repeat(panelLeft)}${background}${SEQ.softAccent}│${SEQ.reset}${background} ${surface(pad(content, contentWidth))} ${SEQ.softAccent}│${reset}`;
  }
  rows[panelBottom] = border("╰", "╯");
  const shift = Math.max(0, Math.floor((height - panelBottom - 1) / 2));
  const screen = Array.from({ length: height }, (_, row) =>
    row >= shift ? rows[row - shift] : "",
  );
  return {
    rows: screen,
    inputTop: inputTop + shift,
    hits: hits.map((hit) => ({ ...hit, row: hit.row + shift })),
    footerTop: statusTop + shift,
    contextRow: contextRow + shift,
  };
}
