import { CellCanvas } from "./cell-canvas.js";
import { mixHexOklab } from "./oklab.js";
import { type RecentSessionEntry, relativeTime, startupActions } from "./startup-home.js";
import { getDetectedTerminalBackground } from "./terminal-appearance.js";
import { formatPermissionModeLabel } from "./terminal-panels.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { terminalWidth, truncateText } from "./terminal-text.js";
import { bgSeq, dimHex, faintHex, fgSeq, getColorLevel, getTheme, softAccentHex } from "./theme.js";
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
/** 入口卡片之间的间距。 */
const TILE_GAP = 2;
/** 列表形态的入口名占 14 列，说明从这里起排。 */
const ACTION_LABEL_COLUMNS = 14;
/** 「继续上次」只给 24 小时内的会话。 */
const RESUME_WINDOW_MS = 86_400_000;
/** 启动动效总时长：标语解码 + 高光扫过 Logo + 星点闪烁，之后整屏静止。 */
export const STARTUP_MOTION_MS = 1800;

const ACTION_HINTS = ["梳理结构与入口", "找出回归风险", "从一句话开始"];
const ACTION_LONG_HINTS = ["梳理结构、入口与运行方式", "看看改动，找出回归风险", "从一句话开始"];

export const STARTUP_TAGLINE = "把想法，写成下一步。";
/** 空输入时的占位提示，按可用宽度从长到短挑一条（不截成半句）。 */
export const STARTUP_PLACEHOLDERS = [
  "描述你想完成的事 · / 指令 · @ 引用文件",
  "描述你想完成的事 · / 指令",
  "描述你想完成的事",
  "描述需求",
] as const;

/** 5×6 像素字：大 Logo 每像素 2 列 × 1 行，小 Logo 用半块字符每格叠两行像素。 */
const PIXEL_GLYPHS: Record<string, readonly string[]> = {
  H: ["X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  A: [".XXX.", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  J: ["..XXX", "....X", "....X", "....X", "X...X", ".XXX."],
  I: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
};
const LOGO_WORD = "HAJI";

function pixelRows(): string[] {
  return Array.from({ length: 6 }, (_, row) =>
    [...LOGO_WORD].map((letter) => PIXEL_GLYPHS[letter][row]).join(".."),
  );
}

/** 大 Logo：6 行高，每像素两列，接近正方形。 */
export function buildBigLogo(): string[] {
  return pixelRows().map((line) => line.replace(/X/g, "██").replace(/\./g, "  "));
}

/** 小 Logo：3 行高，上下两像素合进一格（▀ ▄ █）。 */
export function buildHalfLogo(): string[] {
  const pixels = pixelRows();
  const rows: string[] = [];
  for (let row = 0; row < 6; row += 2) {
    let line = "";
    for (let column = 0; column < pixels[row].length; column++) {
      const top = pixels[row][column] === "X";
      const bottom = pixels[row + 1][column] === "X";
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    rows.push(line);
  }
  return rows;
}

/**
 * 首屏几何：内容列居中，最宽 76 列；卡片正文宽度 = contentWidth − 4。
 * 输入行上限按高度给，保证极矮窗口也能放下「卡片 + 状态行」。
 */
export function startupLauncherGeometry(width: number, height: number) {
  const contentWidth = Math.max(8, Math.min(76, width - (width >= 40 ? 8 : 4)));
  const left = Math.floor((width - contentWidth) / 2);
  return {
    contentWidth,
    inputWidth: Math.max(1, contentWidth - CARD_INSET * 2),
    left,
    inputLeft: left + CARD_INSET,
    footerRows: FOOTER_ROWS,
    maxInputRows: Math.max(1, Math.min(8, Math.floor(height / 5))),
    maxSuggestionRows: height >= 30 ? 5 : height >= 20 ? 3 : 1,
  };
}

function clean(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

export interface StartupLauncherOptions {
  width: number;
  height: number;
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
  /** 输入框里已有内容：卡片右下角的「↵ 发送」此时才亮起。 */
  hasDraft?: boolean;
  /** 启动动效已播放的毫秒数；undefined 表示静止画面。 */
  motionElapsed?: number;
  now?: number;
  /** 只画退场用的背景层：不画输入卡片 / 补全 / 光晕，也不播动效（卡片与光晕由过渡单独合成）。 */
  exitScene?: boolean;
}

interface LayoutPlan {
  hero: "big" | "half" | "wordmark" | "none";
  resume: boolean;
  cardPadding: boolean;
  meta: boolean;
  gaps: boolean;
  labels: boolean;
  actions: "tiles" | "list" | "inline" | "none";
  sessions: number;
}

type Block =
  | { kind: "blank" }
  | { kind: "logo"; line: number; size: "big" | "half" }
  | { kind: "tagline" }
  | { kind: "wordmark" }
  | { kind: "leading"; text: string }
  | { kind: "resume" }
  | { kind: "card"; text: string; edge?: "meta" }
  | { kind: "suggestion"; text: string }
  | { kind: "label"; text: string; aside?: string }
  | { kind: "tile"; line: 0 | 1 | 2 }
  | { kind: "action"; index: number }
  | { kind: "inline-actions" }
  | { kind: "session"; index: number; first: boolean };

/**
 * 首屏：大 Logo + 光晕 + 星点 → 「继续上次」→ 输入卡片 → 入口卡片 → 会话时间线 → 状态行。
 * 整块在状态行上方垂直居中、略偏上；空间不够时按固定顺序逐级让步，输入卡片与状态行永远保留。
 * 光晕只在真彩色且知道真实底色时画；星点不进 16 色 / 无色终端。
 */
export function buildStartupLauncher(options: StartupLauncherOptions): {
  rows: string[];
  canvas: CellCanvas;
  inputTop: number;
  hits: LauncherHit[];
  footerTop: number;
  contextRow: number;
  animating: boolean;
  /** 输入卡片占的行（含上下留白与模型行），过渡动画从这里起飞。 */
  card: { top: number; height: number; left: number; width: number; hex: string };
  heroCenter: number;
  /** 光晕混色用的真实底色；不画光晕时为 undefined。 */
  glowBase?: string;
  /** 终端真实底色（主题显式背景或 OSC 11 探测值），过渡淡入淡出朝它混色；未知时为 undefined。 */
  surfaceBase?: string;
} {
  const { width, height, state } = options;
  const geometry = startupLauncherGeometry(width, height);
  const { contentWidth: W, left: L } = geometry;
  const theme = getTheme();
  const level = getColorLevel();
  const colorful = level === "truecolor" || level === "ansi256";
  const glowBase = theme.background || getDetectedTerminalBackground();
  const glowing = level === "truecolor" && Boolean(glowBase);
  const now = options.now ?? Date.now();
  const exitScene = Boolean(options.exitScene);
  const motion = exitScene ? undefined : options.motionElapsed;
  const animating = motion !== undefined && motion < STARTUP_MOTION_MS;

  const sessions = options.sessions.slice(0, 3);
  const actions = startupActions(options.sessions);
  const recentEnough = sessions[0]
    ? now - Date.parse(sessions[0].updatedAt) < RESUME_WINDOW_MS
    : false;
  const leading = options.leading ?? [];
  const suggestions = options.suggestions ?? [];
  const bigLogo = buildBigLogo();
  const halfLogo = buildHalfLogo();
  const footerTop = height - FOOTER_ROWS;
  const available = Math.max(0, footerTop - 2);

  const compose = (plan: LayoutPlan): { blocks: Block[]; inputTop: number; heroRows: number } => {
    const blocks: Block[] = [];
    const gap = (): void => {
      if (plan.gaps && blocks.length > 0) blocks.push({ kind: "blank" });
    };
    if (plan.hero === "big" || plan.hero === "half") {
      const size = plan.hero;
      const logo = size === "big" ? bigLogo : halfLogo;
      logo.forEach((_, line) => {
        blocks.push({ kind: "logo", line, size });
      });
      if (plan.gaps) blocks.push({ kind: "blank" });
      blocks.push({ kind: "tagline" });
    } else if (plan.hero === "wordmark") blocks.push({ kind: "wordmark" });
    const heroRows = blocks.length;
    gap();
    if (plan.resume) {
      blocks.push({ kind: "resume" });
      if (plan.gaps) blocks.push({ kind: "blank" });
    }
    for (const text of leading) blocks.push({ kind: "leading", text });
    if (plan.cardPadding) blocks.push({ kind: "card", text: "" });
    const inputTop = blocks.length;
    for (const text of options.cardRows) blocks.push({ kind: "card", text });
    if (plan.cardPadding) blocks.push({ kind: "card", text: "" });
    if (plan.meta && options.model) blocks.push({ kind: "card", text: "", edge: "meta" });
    for (const text of suggestions) blocks.push({ kind: "suggestion", text });

    if (plan.actions !== "none") {
      gap();
      if (plan.labels && plan.actions !== "inline") {
        blocks.push({
          kind: "label",
          text: "快速开始",
          aside: W >= 44 ? "Tab 选择 · Enter 打开" : undefined,
        });
      }
      if (plan.actions === "tiles") {
        blocks.push(
          { kind: "tile", line: 0 },
          { kind: "tile", line: 1 },
          { kind: "tile", line: 2 },
        );
      } else if (plan.actions === "inline") blocks.push({ kind: "inline-actions" });
      else for (let index = 0; index < 3; index++) blocks.push({ kind: "action", index });
    }
    const listed = sessions.slice(plan.resume ? 1 : 0, plan.sessions);
    if (listed.length > 0) {
      gap();
      if (plan.labels) blocks.push({ kind: "label", text: "最近会话" });
      listed.forEach((_, offset) => {
        const index = offset + (plan.resume ? 4 : 3);
        blocks.push({ kind: "session", index, first: index === 3 });
      });
    }
    return { blocks, inputTop, heroRows };
  };

  const plan: LayoutPlan = {
    hero:
      W >= terminalWidth(bigLogo[0])
        ? "big"
        : W >= terminalWidth(halfLogo[0])
          ? "half"
          : "wordmark",
    resume: recentEnough,
    cardPadding: true,
    meta: true,
    gaps: true,
    labels: true,
    actions: W >= 60 ? "tiles" : "list",
    sessions: sessions.length,
  };
  let layout = compose(plan);
  // Logo 只在还剩至少 4 行呼吸空间时保留：大号放不下先退小号，再退单行字标。
  while (plan.hero !== "wordmark" && layout.blocks.length + 4 > available) {
    plan.hero = plan.hero === "big" && W >= terminalWidth(halfLogo[0]) ? "half" : "wordmark";
    layout = compose(plan);
  }
  // 让步顺序：会话条数 → 卡片留白 → 入口卡片改列表 → 段间空行 → 会话 → 继续上次 → 模型行 →
  // 小标题 → 入口改一行三格 → 字标 → 入口。
  const steps: Array<(current: LayoutPlan) => Partial<LayoutPlan>> = [
    (current) => ({ sessions: Math.min(current.sessions, current.resume ? 3 : 2) }),
    (current) => ({ sessions: Math.min(current.sessions, current.resume ? 2 : 1) }),
    () => ({ cardPadding: false }),
    (current) => ({ actions: current.actions === "tiles" ? "list" : current.actions }),
    () => ({ gaps: false }),
    (current) => ({ sessions: current.resume ? Math.min(current.sessions, 1) : 0 }),
    () => ({ resume: false, sessions: 0 }),
    () => ({ meta: false }),
    () => ({ labels: false }),
    (current) => ({ actions: current.actions === "list" && W >= 42 ? "inline" : "none" }),
    () => ({ hero: "none" }),
    () => ({ actions: "none" }),
  ];
  for (const step of steps) {
    if (layout.blocks.length <= available) break;
    Object.assign(plan, step(plan));
    layout = compose(plan);
  }
  const { blocks } = layout;
  // 视觉中心略高于几何中心（上留白 : 下留白 ≈ 2 : 3）。
  const top = 1 + Math.max(0, Math.floor(((available - blocks.length) * 2) / 5));

  // ── 颜色 ──
  const mono = level === "mono";
  const cardHex = glowing ? mixHexOklab(glowBase as string, theme.accent, 0.11) : theme.userMsgBg;
  const cardBg = mono ? undefined : bgSeq(cardHex);
  const tileActiveHex = mixHexOklab(cardHex, theme.accent, 0.16);
  const pillHex = mixHexOklab(cardHex, theme.accent, 0.24);
  const capHex = mixHexOklab(cardHex, theme.foreground, 0.14);
  const leader = fgSeq(dimHex(faintHex(), 0.5));
  const strongFg = fgSeq(theme.userMsgFg);
  const fg = fgSeq(theme.foreground);
  const muted = fgSeq(theme.muted);
  const faint = fgSeq(faintHex());
  const soft = fgSeq(softAccentHex());
  const accent = fgSeq(theme.accent);
  const green = fgSeq(theme.green);
  const gradientAt = (t: number): string =>
    colorful ? mixHexOklab(theme.accent, theme.cyan, Math.max(0, Math.min(1, t))) : theme.accent;
  const optionalBg = (hex: string): string | undefined => (mono ? undefined : bgSeq(hex));
  const activeBg = optionalBg(tileActiveHex);

  const canvas = new CellCanvas(width, height);
  const hits: LauncherHit[] = [];
  const centerColumn = (text: string): number =>
    L + Math.max(0, Math.floor((W - terminalWidth(text)) / 2));
  const heroIndex = blocks.findIndex((block) => block.kind === "logo" || block.kind === "wordmark");
  const heroCenter = top + Math.max(0, heroIndex) + Math.floor(layout.heroRows / 2);
  if (glowing && !exitScene) {
    canvas.backdrop = glowLayer(width, height, heroCenter, glowBase as string, theme.accent);
  }
  const cardBlocks = blocks.filter((block) => block.kind === "card");
  const entryTone = (index: number, base = fg): string =>
    index === options.selected ? strongFg : index === options.hovered ? accent : base;

  const drawMeta = (row: number): void => {
    const model = options.model;
    if (!model) return;
    const bypass = model.permissionMode === "bypass-permissions";
    const mode = model.permissionMode ? formatPermissionModeLabel(model.permissionMode) : "";
    let x = L + CARD_INSET;
    if (mode) {
      const pillBg = mono
        ? cardBg
        : bgSeq(bypass ? mixHexOklab(cardHex, theme.red, 0.28) : pillHex);
      x = canvas.text(x, row, ` ${mode} `, {
        fg: fgSeq(bypass ? theme.red : theme.accent),
        bold: true,
        bg: pillBg,
      });
      x += 2;
    }
    const name = [clean(model.modelName), clean(model.reasoningEffort).toLowerCase()]
      .filter(Boolean)
      .join(" · ");
    const cap = " ↵ ";
    const capLabel = "发送";
    const capWidth = terminalWidth(cap) + 1 + terminalWidth(capLabel);
    const showCap = W - (x - L) - terminalWidth(name) - capWidth - 4 >= 0;
    const nameRoom = L + W - x - 2 - (showCap ? capWidth + 2 : 0);
    if (name && nameRoom > 0) {
      canvas.text(x, row, truncateText(name, nameRoom), { fg: muted, bg: cardBg });
    }
    if (showCap) {
      const ready = Boolean(options.hasDraft);
      const end = canvas.text(L + W - 2 - capWidth, row, cap, {
        fg: ready ? accent : faint,
        bold: ready,
        bg: mono ? cardBg : bgSeq(capHex),
      });
      canvas.text(end + 1, row, capLabel, { fg: ready ? fg : faint, bg: cardBg });
    }
  };

  blocks.forEach((block, offset) => {
    const row = top + offset;
    if (exitScene && (block.kind === "card" || block.kind === "suggestion")) return;
    switch (block.kind) {
      case "blank":
        return;
      case "logo": {
        const art = block.size === "big" ? bigLogo : halfLogo;
        const x = centerColumn(art[0]);
        const total = terminalWidth(art[0]);
        // 动效：一道高光在前 80% 的时间里从左扫到右。
        const shine =
          animating && colorful
            ? -0.25 + ((motion as number) / (STARTUP_MOTION_MS * 0.8)) * 1.5
            : undefined;
        [...art[block.line]].forEach((ch, column) => {
          if (ch === " ") return;
          const t = column / Math.max(1, total - 1);
          let hex = gradientAt(t);
          if (shine !== undefined) {
            const distance = Math.abs(t - shine + block.line * 0.03);
            if (distance < 0.08) {
              hex = mixHexOklab(hex, theme.userMsgFg, 0.75 * (1 - distance / 0.08));
            }
          }
          canvas.text(x + column, row, ch, { fg: fgSeq(hex) });
        });
        return;
      }
      case "tagline": {
        // 标语疏排；动效前半段逐字从乱码「解码」出来。
        const chars = [...STARTUP_TAGLINE.replace(/。$/, "")];
        const spaced = W >= chars.length * 3 + 4;
        const resolved = animating
          ? Math.min(
              chars.length,
              Math.floor(((motion as number) / (STARTUP_MOTION_MS * 0.5)) * chars.length),
            )
          : chars.length;
        const glyphs = "<>/{}=+*#%&";
        const step = Math.floor((motion ?? 0) / 90);
        let x = centerColumn(spaced ? chars.join(" ") : chars.join(""));
        chars.forEach((ch, index) => {
          const piece =
            index < resolved
              ? ch
              : glyphs[(index * 7 + step * 3) % glyphs.length] +
                glyphs[(index * 5 + step) % glyphs.length];
          x = canvas.text(x, row, piece, { fg: index < resolved ? muted : soft });
          if (spaced) x += 1;
        });
        return;
      }
      case "wordmark": {
        const full = `haji  ·  ${STARTUP_TAGLINE}`;
        const withTagline = terminalWidth(full) <= W;
        let x = centerColumn(withTagline ? full : "haji");
        [..."haji"].forEach((ch, index) => {
          x = canvas.text(x, row, ch, { fg: fgSeq(gradientAt(index / 3)), bold: true });
        });
        if (withTagline) {
          x = canvas.text(x, row, "  ·  ", { fg: faint });
          canvas.text(x, row, STARTUP_TAGLINE, { fg: muted });
        }
        return;
      }
      case "leading":
      case "suggestion":
        canvas.ansi(L + CARD_INSET, row, block.text);
        return;
      case "resume": {
        const session = sessions[0];
        const index = 3;
        const active = options.selected === index;
        if (active) canvas.fill(L, row, W, 1, activeBg);
        let x = canvas.text(L + 1, row, active ? "▸" : "●", { fg: active ? accent : green });
        x = canvas.text(x + 1, row, "继续上次", { fg: green, bold: true });
        const stamp = relativeTime(session.updatedAt, now);
        const aside = active && W >= 56 ? "Enter 继续" : "";
        const room =
          W -
          (x - L) -
          2 -
          (stamp ? terminalWidth(stamp) + 3 : 0) -
          (aside ? terminalWidth(aside) + 2 : 0);
        x = canvas.text(
          x + 2,
          row,
          truncateText(clean(session.title) || "未命名会话", Math.max(1, room)),
          { fg: entryTone(index), bold: active },
        );
        if (stamp) canvas.text(x + 1, row, `· ${stamp}`, { fg: faint });
        if (aside) canvas.text(L + W - terminalWidth(aside), row, aside, { fg: faint });
        hits.push({ row, left: L, right: L + W - 1, index });
        return;
      }
      case "card": {
        // 竖条沿卡片高度从强调色渐变到青色，和 Logo 的横向渐变呼应。
        const position = cardBlocks.indexOf(block);
        canvas.fill(L + 1, row, W - 1, 1, cardBg);
        canvas.text(L, row, "▌", {
          fg: fgSeq(gradientAt(position / Math.max(1, cardBlocks.length - 1))),
        });
        if (block.edge === "meta") drawMeta(row);
        else if (block.text) canvas.ansi(L + CARD_INSET, row, block.text, cardBg);
        return;
      }
      case "label": {
        canvas.text(L, row, block.text, { fg: faint });
        if (block.aside && W - terminalWidth(block.text) - terminalWidth(block.aside) >= 4) {
          canvas.text(L + W - terminalWidth(block.aside), row, block.aside, { fg: soft });
        }
        return;
      }
      case "tile": {
        // 入口卡片：选中卡顶边换成强调色粗线、底色稍亮；整张卡三行都可点。
        const tileWidth = Math.floor((W - TILE_GAP * 2) / 3);
        for (let index = 0; index < 3; index++) {
          const x = L + index * (tileWidth + TILE_GAP);
          const span = index === 2 ? L + W - x : tileWidth;
          const active = index === options.selected;
          const bg = active ? activeBg : cardBg;
          canvas.fill(x, row, span, 1, bg);
          if (block.line === 0) {
            const edge = active ? accent : fgSeq(mixHexOklab(cardHex, theme.foreground, 0.1));
            canvas.text(x, row, (active ? "━" : "─").repeat(span), { fg: edge, bg });
          } else if (block.line === 1) {
            canvas.text(x + 2, row, `${index + 1}`, { fg: active ? accent : soft, bold: true, bg });
            canvas.text(x + 5, row, truncateText(actions[index].label, span - 6), {
              fg: entryTone(index),
              bold: active,
              bg,
            });
          } else {
            canvas.text(x + 5, row, truncateText(ACTION_HINTS[index], span - 6), { fg: faint, bg });
          }
          hits.push({ row, left: x, right: x + span - 1, index });
        }
        return;
      }
      case "action": {
        const index = block.index;
        const active = index === options.selected;
        if (active) canvas.fill(L, row, W, 1, activeBg);
        canvas.text(L, row, active ? "▸" : " ", { fg: accent });
        const showHint = W >= 48;
        const label = truncateText(
          actions[index].label,
          Math.max(1, (showHint ? ACTION_LABEL_COLUMNS : W) - 2),
        );
        canvas.text(L + 2, row, label, { fg: entryTone(index), bold: active });
        if (showHint) {
          canvas.text(
            L + 2 + ACTION_LABEL_COLUMNS,
            row,
            truncateText(ACTION_LONG_HINTS[index], W - ACTION_LABEL_COLUMNS - 4),
            { fg: faint },
          );
        }
        hits.push({ row, left: L, right: L + W - 1, index });
        return;
      }
      case "inline-actions": {
        const slot = Math.floor(W / 3);
        for (let index = 0; index < 3; index++) {
          const x = L + slot * index;
          const active = index === options.selected;
          canvas.text(x, row, active ? "▸" : "·", { fg: active ? accent : faint });
          canvas.text(x + 2, row, truncateText(actions[index].label, slot - 3), {
            fg: entryTone(index, muted),
            bold: active,
          });
          hits.push({ row, left: x, right: x + slot - 2, index });
        }
        return;
      }
      case "session": {
        // 时间线：最近一条实心绿点，其余空心；点线引到右侧时间。
        const session = sessions[block.index - 3];
        const active = block.index === options.selected;
        if (active) canvas.fill(L, row, W, 1, activeBg);
        const dot = active ? "▸" : block.first ? "●" : "○";
        canvas.text(L + 1, row, dot, { fg: active ? accent : block.first ? green : soft });
        const stamp = relativeTime(session.updatedAt, now);
        const withStamp = W >= 32 && stamp.length > 0;
        const titleWidth = Math.max(1, W - 4 - (withStamp ? terminalWidth(stamp) + 4 : 0));
        const titleEnd = canvas.text(
          L + 4,
          row,
          truncateText(clean(session.title) || "未命名会话", titleWidth),
          { fg: entryTone(block.index, block.first ? fg : muted), bold: active },
        );
        if (withStamp) {
          const stampX = L + W - terminalWidth(stamp);
          // 只在偶数列落点，几行之间的点能上下对齐。
          for (let x = titleEnd + 2; x < stampX - 1; x++) {
            if ((x - L) % 2 === 0) canvas.text(x, row, "·", { fg: leader });
          }
          canvas.text(stampX, row, stamp, { fg: faint });
        }
        hits.push({ row, left: L, right: L + W - 1, index: block.index });
        return;
      }
    }
  });

  if (colorful) {
    drawStars(canvas, {
      width,
      height,
      left: L,
      contentWidth: W,
      footerTop,
      motion: animating ? motion : undefined,
    });
  }
  drawFooter(canvas, { left: L, contentWidth: W, row: footerTop, state, notice: options.notice });

  const cardOffset = blocks.findIndex((block) => block.kind === "card");
  return {
    rows: canvas.toRows(),
    canvas,
    inputTop: top + layout.inputTop,
    hits,
    footerTop,
    contextRow: footerTop,
    animating,
    card: {
      top: top + Math.max(0, cardOffset),
      height: cardBlocks.length,
      left: L,
      width: W,
      hex: cardHex,
    },
    heroCenter,
    glowBase: glowing ? (glowBase as string) : undefined,
    surfaceBase: glowBase || undefined,
  };
}

/**
 * 状态行：左侧「项目 分支 ~改 +增 −删 ?未跟踪 冲突 任务」，右侧「ctx ▰▱▱ 0% · ¥」。
 * 窄时先丢改动明细、再丢分支；临时提示整段顶替左侧。
 */
function drawFooter(
  canvas: CellCanvas,
  options: {
    left: number;
    contentWidth: number;
    row: number;
    state: SidebarState;
    notice?: string;
  },
): void {
  const { left: L, contentWidth: W, row, state } = options;
  const theme = getTheme();
  const fg = fgSeq(theme.foreground);
  const muted = fgSeq(theme.muted);
  const faint = fgSeq(faintHex());
  const workspace = state.workspace;
  const ratio = state.maxTokens > 0 ? Math.round((state.usedTokens / state.maxTokens) * 100) : 0;
  const cost = `¥${(state.costCny ?? 0).toFixed(4)}${state.hasUnpricedCost ? "+?" : ""}`;
  const barCells = W >= 56 ? 10 : 0;
  const tail = `${ratio}% · ${cost}`;
  const rightWidth = 4 + (barCells ? barCells + 1 : 0) + terminalWidth(tail);
  let x = canvas.text(L + W - rightWidth, row, "ctx ", { fg: faint });
  if (barCells) {
    const filled = Math.min(
      barCells,
      Math.max(state.usedTokens > 0 ? 1 : 0, Math.round((ratio / 100) * barCells)),
    );
    for (let index = 0; index < barCells; index++) {
      canvas.text(x + index, row, index < filled ? "▰" : "▱", {
        fg: index < filled ? fgSeq(theme.accent) : fgSeq(softAccentHex()),
      });
    }
    x += barCells + 1;
  }
  canvas.text(x, row, tail, { fg: faint });

  const budget = W - rightWidth - 2;
  if (budget < 8) return;
  const notice = options.notice ? clean(options.notice) : "";
  if (notice) {
    canvas.text(L, row, truncateText(notice, budget), { fg: fgSeq(theme.yellow) });
    return;
  }
  const branch =
    workspace?.gitStatus === "not-repository"
      ? "非 Git 仓库"
      : workspace?.gitStatus === "unavailable"
        ? "Git 状态暂不可用"
        : clean(workspace?.branch ?? "");
  const task = state.taskPlan;
  const taskText = task
    ? `任务 ${task.items.filter((item) => item.status === "completed").length}/${task.items.length} · ${clean(task.title)}`
    : state.goal?.status === "active"
      ? `目标 ${clean(state.goal.text)}`
      : "";
  interface Piece {
    text: string;
    fg: string;
    bold?: boolean;
    gap: number;
  }
  const name: Piece[] = workspace
    ? [{ text: clean(workspace.name), fg, bold: true, gap: 0 }]
    : [{ text: "状态读取中", fg: muted, gap: 0 }];
  const branchPiece: Piece[] = branch ? [{ text: branch, fg: muted, gap: 2 }] : [];
  const changes: Piece[] = workspace
    ? (
        [
          [`~${workspace.modified}`, theme.yellow, workspace.modified],
          [`+${workspace.added}`, theme.green, workspace.added],
          [`−${workspace.deleted}`, theme.red, workspace.deleted],
          [`?${workspace.untracked}`, faintHex(), workspace.untracked],
        ] as const
      )
        .filter(([, , count]) => count > 0)
        .map(([text, hex], index) => ({ text, fg: fgSeq(hex), gap: index === 0 ? 3 : 1 }))
    : [];
  const conflict: Piece[] = workspace?.conflicted
    ? [{ text: `冲突 ${workspace.conflicted}`, fg: fgSeq(theme.red), bold: true, gap: 3 }]
    : [];
  const taskPiece: Piece[] = taskText ? [{ text: taskText, fg: muted, gap: 3 }] : [];
  const candidates: Piece[][] = [
    [...name, ...branchPiece, ...changes, ...conflict, ...taskPiece],
    [...name, ...branchPiece, ...conflict, ...taskPiece],
    [...conflict, ...taskPiece, ...name],
    [...name],
  ];
  const measure = (pieces: Piece[]): number =>
    pieces.reduce(
      (sum, piece, index) =>
        sum + (index === 0 ? 0 : Math.max(1, piece.gap)) + terminalWidth(piece.text),
      0,
    );
  const chosen =
    candidates.find((pieces) => measure(pieces) <= budget) ?? candidates[candidates.length - 1];
  let cursor = L;
  chosen.forEach((piece, index) => {
    if (index > 0) cursor += Math.max(1, piece.gap);
    const room = L + budget - cursor;
    if (room <= 0) return;
    cursor = canvas.text(cursor, row, truncateText(piece.text, room), {
      fg: piece.fg,
      bold: piece.bold,
    });
  });
}

/**
 * 径向光晕：以 Logo 为中心的椭圆，只改透明格的背景色。半径随窗口宽高缩放，
 * 到屏幕边缘时混色比例已低于 0.25%，与真实底色肉眼不可分，不会露出边界。
 */
const glowCache = new Map<string, (string | undefined)[][]>();
/** `scale` 同时缩强度与半径（退场时光晕向中心收拢）；按 1/20 取整，缓存不会随帧数膨胀。 */
export function glowLayer(
  width: number,
  height: number,
  centerRow: number,
  base: string,
  accent: string,
  scale = 1,
): (column: number, row: number) => string | undefined {
  const level = Math.round(Math.max(0, Math.min(1, scale)) * 20) / 20;
  if (level === 0) return () => undefined;
  const key = `${width}x${height}@${centerRow}|${base}|${accent}|${level}`;
  let grid = glowCache.get(key);
  if (!grid) {
    const spread = 0.55 + 0.45 * level;
    const rx = width * 0.36 * spread;
    const ry = Math.max(6, height * 0.3) * spread;
    const cx = width / 2;
    // 混色比例按 1/2000 取整：肉眼不可分，整屏只需算几百次 Oklab（退场时每帧都要换一张）。
    const tones = new Map<number, string>();
    grid = Array.from({ length: height }, (_, row) =>
      Array.from({ length: width }, (_, column) => {
        const distance = ((column - cx) / rx) ** 2 + ((row - centerRow) / ry) ** 2;
        const strength = 0.15 * level * Math.exp(-2.2 * distance);
        if (strength <= 0.004) return undefined;
        const step = Math.round(strength * 2000);
        let tone = tones.get(step);
        if (tone === undefined) {
          tone = bgSeq(mixHexOklab(base, accent, step / 2000));
          tones.set(step, tone);
        }
        return tone;
      }),
    );
    if (glowCache.size > 32) glowCache.clear();
    glowCache.set(key, grid);
  }
  const cells = grid;
  return (column, row) => cells[row]?.[column];
}

/** 星点：伪随机但对同一尺寸稳定；动效期间按各自相位闪烁，结束后定格。 */
function drawStars(
  canvas: CellCanvas,
  options: {
    width: number;
    height: number;
    left: number;
    contentWidth: number;
    footerTop: number;
    motion?: number;
  },
): void {
  const theme = getTheme();
  const { width, height, left, contentWidth, footerTop, motion } = options;
  const rightStart = left + contentWidth + 3;
  const margin = Math.min(left - 3, width - rightStart - 1);
  if (margin < 4 || height < 14) return;
  let seed = width * 7919 + height * 104729;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const dim = fgSeq(dimHex(theme.muted, 0.5));
  const dimmer = fgSeq(dimHex(theme.muted, 0.72));
  const bright = [fgSeq(dimHex(theme.accent, 0.45)), fgSeq(dimHex(theme.cyan, 0.45))];
  const count = Math.floor((margin * 2 * (footerTop - 2)) / 48);
  for (let index = 0; index < count; index++) {
    const leftSide = random() < 0.5;
    const column = leftSide
      ? Math.floor(random() * (left - 3))
      : rightStart + Math.floor(random() * (width - rightStart - 1));
    const row = 1 + Math.floor(random() * (footerTop - 2));
    const phase = random();
    const big = random() > 0.85;
    const shape = big ? "+" : random() > 0.5 ? "·" : "˙";
    if (!canvas.isEmpty(column, row)) continue;
    const lit = motion === undefined || Math.sin((motion / 600 + phase) * Math.PI * 2) > -0.2;
    const color = big ? (lit ? bright[index % 2] : dim) : lit ? dim : dimmer;
    canvas.text(column, row, shape, { fg: color });
  }
}
