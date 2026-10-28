import { type RecentSessionEntry, relativeTime, startupActions } from "./startup-home.js";
import { formatPermissionModeLabel } from "./terminal-panels.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { SEQ, terminalWidth, truncateAnsiText, truncateText } from "./terminal-text.js";
import { bgSeq, fgSeq, getTheme } from "./theme.js";
import type { SidebarState } from "./tui-sidebar.js";

export interface LauncherHit {
  row: number;
  left: number;
  right: number;
  index: number;
}

/** 输入卡片左侧竖条 + 一格内边距；右侧同样留两格，正文宽 = 卡片宽 − 4。 */
const CARD_INSET = 2;
/** 状态行在倒数第二行，最后一行留白与顶部一行对称。 */
const FOOTER_ROWS = 2;
/** 快捷入口的说明列：入口名占 14 列，说明从这里起排。 */
const ACTION_LABEL_COLUMNS = 14;

/** 每个入口一句说明，只在内容区够宽时显示。 */
const ACTION_HINTS = ["梳理结构、入口与运行方式", "看看改动，找出回归风险", "从一句话开始"];

export const STARTUP_TAGLINE = "把想法，写成下一步。";
/** 空输入时的占位提示，按可用宽度从长到短挑一条（不截成半句）。 */
export const STARTUP_PLACEHOLDERS = [
  "描述你想完成的事 · / 指令 · @ 引用文件",
  "描述你想完成的事 · / 指令",
  "描述你想完成的事",
  "描述需求",
] as const;

/**
 * 首屏几何：内容列居中，最宽 72 列；卡片正文宽度 = contentWidth − 4。
 * 输入行上限按高度给，保证极矮窗口也能放下「卡片 + 状态行」。
 */
export function startupLauncherGeometry(width: number, height: number) {
  const contentWidth = Math.max(8, Math.min(72, width - (width >= 40 ? 8 : 4)));
  return {
    contentWidth,
    inputWidth: Math.max(1, contentWidth - CARD_INSET * 2),
    left: Math.floor((width - contentWidth) / 2),
    inputLeft: Math.floor((width - contentWidth) / 2) + CARD_INSET,
    footerRows: FOOTER_ROWS,
    maxInputRows: Math.max(1, Math.min(8, Math.floor(height / 5))),
    maxSuggestionRows: height >= 30 ? 5 : height >= 20 ? 3 : 1,
  };
}

function clean(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function fit(text: string, width: number): string {
  const clipped = truncateAnsiText(text, Math.max(0, width));
  return clipped + " ".repeat(Math.max(0, width - terminalWidth(clipped)));
}

/**
 * 在一段带底色的区域里续上底色：子串里的 SGR 0 / 49 会清掉背景，
 * 每次清除之后立刻补回底色与正文色，色块才能连续铺到行尾。
 */
function onSurface(text: string, background: string): string {
  if (!background) return text;
  const theme = getTheme();
  const foreground = fgSeq(theme.foreground);
  const base = bgSeq(theme.background);
  return (base ? text.split(base).join(background) : text)
    .split("\x1b[0m")
    .join(`\x1b[0m${foreground}${background}`)
    .split("\x1b[49m")
    .join(background);
}

interface LauncherOptions {
  width: number;
  height: number;
  /** 多行彩色 Logo；宽高都够时才整块画出。 */
  header: readonly string[];
  /** 卡片上方的排队提示（已截到 inputWidth）。 */
  leading?: readonly string[];
  /** 卡片内部的行：图片附件 chip + 输入行，均已截到 inputWidth。 */
  cardRows: readonly string[];
  /** 卡片下方的斜杠/文件补全候选。 */
  suggestions?: readonly string[];
  sessions: readonly RecentSessionEntry[];
  selected: number;
  hovered?: number;
  state: SidebarState;
  model?: {
    permissionMode: string;
    modelName: string;
    providerName: string;
    reasoningEffort: string;
  };
  /** Ctrl+C 确认、复制成功这类临时提示，暂时顶替状态行左侧。 */
  notice?: string;
  now?: number;
}

interface LayoutPlan {
  hero: "logo" | "wordmark" | "none";
  cardPadding: boolean;
  meta: boolean;
  gaps: boolean;
  labels: boolean;
  actions: "list" | "inline" | "none";
  sessions: number;
}

type Block =
  | { kind: "blank" }
  | { kind: "text"; text: string; align?: "center" }
  | { kind: "card"; text: string; inputIndex?: number }
  | { kind: "action"; index: number; label: string; hint: string }
  | { kind: "inline-actions" }
  | { kind: "session"; index: number; title: string; stamp: string }
  | { kind: "label"; text: string; aside?: string };

/**
 * 首屏排版：Logo → 输入卡片 → 快捷入口 → 最近会话，整块在状态行上方垂直居中（略偏上）。
 * 空间不够时按固定顺序逐级让步，输入卡片与状态行永远保留。
 * 光标、补全与输入选区仍由 TerminalUI 管理，这里只消费已排好的输入行。
 */
export function buildStartupLauncher(options: LauncherOptions): {
  rows: string[];
  inputTop: number;
  hits: LauncherHit[];
  footerTop: number;
  contextRow: number;
} {
  const { width, height, state } = options;
  const geometry = startupLauncherGeometry(width, height);
  const { contentWidth, inputWidth, left } = geometry;
  const theme = getTheme();
  const cardBg = bgSeq(theme.userMsgBg);
  const actions = startupActions(options.sessions);
  const sessions = options.sessions.slice(0, 3);
  const leading = options.leading ?? [];
  const suggestions = options.suggestions ?? [];
  const logo = options.header.filter((line) => clean(line));
  const logoWidth = Math.max(0, ...logo.map((line) => terminalWidth(line)));
  const footerTop = height - FOOTER_ROWS;
  // 第 0 行与状态行上方各留一行空白。
  const available = Math.max(0, footerTop - 2);

  const compose = (plan: LayoutPlan): { blocks: Block[]; inputTop: number } => {
    const blocks: Block[] = [];
    const gap = (): void => {
      if (plan.gaps && blocks.length > 0) blocks.push({ kind: "blank" });
    };
    if (plan.hero === "logo") {
      for (const line of logo) blocks.push({ kind: "text", text: line, align: "center" });
      blocks.push({ kind: "blank" });
      blocks.push({
        kind: "text",
        text: `${SEQ.muted}${STARTUP_TAGLINE}${SEQ.reset}`,
        align: "center",
      });
    } else if (plan.hero === "wordmark") {
      // 字标放不下标语时只留品牌名，不截成半句。
      const withTagline = terminalWidth(`haji  ·  ${STARTUP_TAGLINE}`) <= contentWidth;
      blocks.push({
        kind: "text",
        text: withTagline
          ? `${SEQ.boldAccent}haji${SEQ.reset}${SEQ.faint}  ·  ${SEQ.reset}${SEQ.muted}${STARTUP_TAGLINE}${SEQ.reset}`
          : `${SEQ.boldAccent}haji${SEQ.reset}`,
        align: "center",
      });
    }
    gap();
    for (const line of leading) blocks.push({ kind: "text", text: line });
    if (plan.cardPadding) blocks.push({ kind: "card", text: "" });
    const inputTop = blocks.length;
    options.cardRows.forEach((text, index) => {
      blocks.push({ kind: "card", text, inputIndex: index });
    });
    if (plan.cardPadding) blocks.push({ kind: "card", text: "" });
    if (plan.meta && options.model)
      blocks.push({ kind: "card", text: buildMetaRow(options.model, inputWidth) });
    for (const line of suggestions) blocks.push({ kind: "text", text: line });

    if (plan.actions !== "none") {
      gap();
      if (plan.labels) {
        blocks.push({
          kind: "label",
          text: "快速开始",
          aside: contentWidth >= 44 ? "Tab 选择 · Enter 打开" : undefined,
        });
      }
      if (plan.actions === "inline") blocks.push({ kind: "inline-actions" });
      else {
        for (let index = 0; index < 3; index++) {
          blocks.push({
            kind: "action",
            index,
            label: actions[index].label,
            hint: ACTION_HINTS[index],
          });
        }
      }
    }
    const shown = sessions.slice(0, plan.sessions);
    if (shown.length > 0) {
      gap();
      if (plan.labels) blocks.push({ kind: "label", text: "最近会话" });
      const now = options.now ?? Date.now();
      shown.forEach((session, index) => {
        blocks.push({
          kind: "session",
          index: index + 3,
          title: clean(session.title) || "未命名会话",
          stamp: relativeTime(session.updatedAt, now),
        });
      });
    }
    return { blocks, inputTop };
  };

  // 让步顺序：会话条数 → 卡片留白 → 段间空行 → 会话 → 模型行 → 标题 → 入口排成一行 → 字标 → 入口。
  const plan: LayoutPlan = {
    hero: logo.length > 0 && logoWidth <= contentWidth ? "logo" : "wordmark",
    cardPadding: true,
    meta: true,
    gaps: true,
    labels: true,
    actions: "list",
    sessions: sessions.length,
  };
  const steps: Array<(current: LayoutPlan) => Partial<LayoutPlan>> = [
    (current) => ({ sessions: Math.min(current.sessions, 2) }),
    (current) => ({ sessions: Math.min(current.sessions, 1) }),
    () => ({ cardPadding: false }),
    () => ({ gaps: false }),
    () => ({ sessions: 0 }),
    () => ({ meta: false }),
    () => ({ labels: false }),
    (current) => ({
      actions: current.actions === "list" && contentWidth >= 42 ? "inline" : "none",
    }),
    () => ({ hero: "none" }),
    () => ({ actions: "none" }),
  ];
  let layout = compose(plan);
  // 大 Logo 只在还能剩下至少 4 行呼吸空间时保留，否则一开始就换成单行字标。
  if (plan.hero === "logo" && layout.blocks.length + 4 > available) {
    plan.hero = "wordmark";
    layout = compose(plan);
  }
  for (const step of steps) {
    if (layout.blocks.length <= available) break;
    Object.assign(plan, step(plan));
    layout = compose(plan);
  }
  const { blocks } = layout;
  // 视觉中心略高于几何中心（上留白 : 下留白 ≈ 2 : 3）。
  const top = 1 + Math.max(0, Math.floor(((available - blocks.length) * 2) / 5));

  const rows: string[] = Array.from({ length: height }, () => "");
  const hits: LauncherHit[] = [];
  const paint = (row: number, text: string, column = left, budget = contentWidth): void => {
    if (row < 0 || row >= footerTop) return;
    rows[row] = " ".repeat(column) + truncateAnsiText(text, budget);
  };
  const barColor = SEQ.accent;
  blocks.forEach((block, offset) => {
    const row = top + offset;
    switch (block.kind) {
      case "blank":
        return;
      case "text": {
        if (block.align === "center") {
          const textWidth = Math.min(terminalWidth(block.text), contentWidth);
          paint(row, block.text, left + Math.floor((contentWidth - textWidth) / 2));
        } else paint(row, block.text, left + CARD_INSET, inputWidth);
        return;
      }
      case "card": {
        const body = onSurface(fit(block.text, contentWidth - 2), cardBg);
        paint(row, `${barColor}┃${SEQ.reset}${cardBg} ${body}${SEQ.reset}`);
        return;
      }
      case "label": {
        const label = `${SEQ.faint}${block.text}${SEQ.reset}`;
        const aside = block.aside ? `${SEQ.faint}${block.aside}${SEQ.reset}` : "";
        const spare = contentWidth - terminalWidth(block.text) - terminalWidth(block.aside ?? "");
        paint(row, aside && spare >= 4 ? `${label}${" ".repeat(spare)}${aside}` : label);
        return;
      }
      case "action": {
        const showHint = contentWidth >= 48;
        const labelText = truncateText(
          block.label,
          Math.max(1, (showHint ? ACTION_LABEL_COLUMNS : contentWidth) - 2),
        );
        const content = showHint
          ? `${fit(labelText, ACTION_LABEL_COLUMNS)}${truncateText(block.hint, contentWidth - ACTION_LABEL_COLUMNS - 4)}`
          : labelText;
        paint(
          row,
          entryRow(
            content,
            showHint
              ? terminalWidth(fit(labelText, ACTION_LABEL_COLUMNS))
              : terminalWidth(labelText),
            block.index,
          ),
        );
        hits.push({ row, left, right: left + contentWidth - 1, index: block.index });
        return;
      }
      case "inline-actions": {
        const slot = Math.floor(contentWidth / 3);
        let line = "";
        for (let index = 0; index < 3; index++) {
          const active = index === options.selected;
          const hovered = index === options.hovered;
          const label = truncateText(actions[index].label, slot - 3);
          const marker = active ? `${SEQ.accent}▸${SEQ.reset}` : `${SEQ.faint}·${SEQ.reset}`;
          const tone = active
            ? `${SEQ.bold}${fgSeq(theme.foreground)}`
            : hovered
              ? SEQ.accent
              : SEQ.muted;
          line += `${marker} ${tone}${label}${SEQ.reset}${" ".repeat(Math.max(0, slot - 2 - terminalWidth(label)))}`;
          hits.push({
            row,
            left: left + slot * index,
            right: left + slot * (index + 1) - 2,
            index,
          });
        }
        paint(row, line);
        return;
      }
      case "session": {
        const stampWidth = terminalWidth(block.stamp);
        const withStamp = contentWidth >= 32 && stampWidth > 0;
        const titleWidth = Math.max(1, contentWidth - 2 - (withStamp ? stampWidth + 2 : 0));
        const title = truncateText(block.title, titleWidth);
        const content = withStamp
          ? `${title}${" ".repeat(Math.max(0, contentWidth - 2 - terminalWidth(title) - stampWidth))}${block.stamp}`
          : title;
        paint(row, entryRow(content, terminalWidth(title), block.index));
        hits.push({ row, left, right: left + contentWidth - 1, index: block.index });
        return;
      }
    }
  });

  function entryRow(content: string, primaryWidth: number, index: number): string {
    // 入口行：两格标记位 + 主文字（正文色）+ 次要文字（faint）；选中整行铺底色。
    const active = index === options.selected;
    const hovered = index === options.hovered;
    const primary = content.slice(0, sliceIndexForWidth(content, primaryWidth));
    const secondary = content.slice(primary.length);
    const marker = active ? `${SEQ.accent}▸${SEQ.reset}` : " ";
    const tone = active
      ? `${SEQ.bold}${fgSeq(theme.foreground)}`
      : hovered
        ? SEQ.accent
        : fgSeq(theme.foreground);
    const line = fit(
      `${marker} ${tone}${primary}${SEQ.reset}${SEQ.faint}${secondary}${SEQ.reset}`,
      contentWidth,
    );
    return active && cardBg ? `${cardBg}${onSurface(line, cardBg)}${SEQ.reset}` : line;
  }

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
  const totalChanges = workspace
    ? workspace.modified + workspace.added + workspace.deleted + workspace.untracked
    : 0;
  const task = state.taskPlan;
  const taskText = task
    ? `任务 ${task.items.filter((item) => item.status === "completed").length}/${task.items.length} · ${clean(task.title)}`
    : state.goal?.status === "active"
      ? `目标 ${clean(state.goal.text)}`
      : "";
  const ratio = state.maxTokens > 0 ? Math.round((state.usedTokens / state.maxTokens) * 100) : 0;
  const cost = `¥${(state.costCny ?? 0).toFixed(4)}${state.hasUnpricedCost ? "+?" : ""}`;
  const resource = `ctx ${ratio}% · ${cost}`;
  const leftBudget = Math.max(1, contentWidth - terminalWidth(resource) - 2);
  const notice = options.notice ? clean(options.notice) : "";
  const parts = [
    project,
    totalChanges ? `${totalChanges} 项改动` : "",
    workspace?.conflicted ? `冲突 ${workspace.conflicted}` : "",
    taskText,
  ].filter(Boolean);
  // 窄时先保冲突与任务，再保项目名。
  const statusText =
    terminalWidth(parts.join(" · ")) <= leftBudget
      ? parts.join(" · ")
      : [taskText, workspace?.conflicted ? `冲突 ${workspace.conflicted}` : "", project]
          .filter(Boolean)
          .join(" · ");
  // 左侧放不下有意义的内容（< 8 列）时整段让给资源摘要。
  const leftStatus =
    leftBudget < 8
      ? ""
      : notice
        ? `${SEQ.yellow}${truncateText(notice, leftBudget)}${SEQ.reset}`
        : `${SEQ.muted}${truncateText(statusText, leftBudget)}${SEQ.reset}`;
  rows[footerTop] =
    " ".repeat(left) +
    `${fit(leftStatus, contentWidth - terminalWidth(resource))}${SEQ.faint}${resource}${SEQ.reset}`;
  return { rows, inputTop: top + layout.inputTop, hits, footerTop, contextRow: footerTop };
}

/** 卡片底部一行：权限档（强调色；全放行用红色）+ 模型 · 强度，右侧提供商。 */
function buildMetaRow(model: NonNullable<LauncherOptions["model"]>, width: number): string {
  const mode = model.permissionMode ? formatPermissionModeLabel(model.permissionMode) : "";
  const modeColor = model.permissionMode === "bypass-permissions" ? SEQ.boldRed : SEQ.accent;
  const name = [clean(model.modelName), clean(model.reasoningEffort).toLowerCase()]
    .filter(Boolean)
    .join(" · ");
  const leftText = [
    mode ? `${modeColor}${mode}${SEQ.reset}` : "",
    name ? `${SEQ.muted}${name}${SEQ.reset}` : "",
  ]
    .filter(Boolean)
    .join("  ");
  const provider = clean(model.providerName);
  const spare = width - terminalWidth(leftText) - terminalWidth(provider);
  return provider && spare >= 2
    ? `${leftText}${" ".repeat(spare)}${SEQ.faint}${provider}${SEQ.reset}`
    : truncateAnsiText(leftText, width);
}

/** 纯文本里按显示宽度找切分下标（入口行只含纯文本，不含转义序列）。 */
function sliceIndexForWidth(text: string, columns: number): number {
  let used = 0;
  let index = 0;
  for (const char of text) {
    const cell = terminalWidth(char);
    if (used + cell > columns) break;
    used += cell;
    index += char.length;
  }
  return index;
}
