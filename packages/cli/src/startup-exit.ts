/**
 * 首页 → 对话的退场过渡（约 260ms）。
 *
 * 首页最后一帧拆成三层：背景层（Logo / 入口 / 会话 / 星点 / 状态行）、输入卡片、卡片里的草稿。
 * 每帧把真实的对话画面放在下面，按进度合成：
 * - 背景层淡出、光晕向 Logo 中心收拢；对话画面随后淡入；
 * - 卡片（底色 + 渐变竖条）滑到对话区输入行的位置、拉成输入行的宽度，最后褪掉底色；
 * - 草稿文字飞向对话区里刚写下的那条用户消息，落点重合后换成真实画面。
 * 知道底色且是真彩色 / 256 色时用混色淡入淡出；否则改成逐格溶解，并且先溶掉首页再溶入对话，
 * 两层不同时出现，避免满屏碎字。
 */
import { CellCanvas, canBlendCells } from "./cell-canvas.js";
import { mixHexOklab } from "./oklab.js";
import {
  buildStartupLauncher,
  glowLayer,
  type StartupLauncherOptions,
} from "./startup-launcher.js";
import { terminalWidth } from "./terminal-text.js";
import { bgSeq, fgSeq, getColorLevel, getTheme } from "./theme.js";

export const STARTUP_EXIT_MS = 260;

export interface StartupExitScene {
  width: number;
  height: number;
  decor: CellCanvas;
  card: { top: number; height: number; left: number; width: number; hex: string };
  /** 卡片里的输入行（带 SGR）与第一行在屏幕上的位置。 */
  text: { top: number; left: number; rows: readonly string[] };
  /** 草稿第一行在首页上的起始列：与对话区里那条消息的落点对齐用。 */
  needle?: { text: string; column: number };
  heroCenter: number;
  glowBase?: string;
  /** 淡入淡出混色的目标底色；未知时退化成溶解。 */
  surfaceBase?: string;
}

export interface StartupExitTarget {
  /** 本帧真实的对话画面（已拼好侧栏）。 */
  rows: readonly string[];
  /** 对话区输入行的位置与宽度：卡片的落点。 */
  input: { top: number; height: number; left: number; width: number };
  /** 用户消息在对话区里的位置；没找到时草稿随卡片一起淡出。 */
  anchor?: { row: number; column: number };
}

/**
 * 从首页最后一帧的排版参数生成退场场景。`inputRows` 是卡片里的输入行（不含附件 chip），
 * `draft` 是提交的原文，只取第一行做落点匹配。
 */
export function buildStartupExitScene(
  options: StartupLauncherOptions,
  layout: { chips: number; inputRows: readonly string[]; inputLeft: number; draft: string },
): StartupExitScene {
  rowCache.clear();
  const frame = buildStartupLauncher({ ...options, exitScene: true, motionElapsed: undefined });
  const textTop = frame.inputTop + layout.chips;
  const needleText = startupExitNeedle(layout.draft);
  let needle: StartupExitScene["needle"];
  if (needleText) {
    const first = stripAnsi(layout.inputRows[0] ?? "");
    const index = first.indexOf(needleText);
    if (index >= 0) {
      needle = {
        text: needleText,
        column: layout.inputLeft + terminalWidth(first.slice(0, index)),
      };
    }
  }
  return {
    width: options.width,
    height: options.height,
    decor: frame.canvas,
    card: frame.card,
    text: { top: textTop, left: layout.inputLeft, rows: layout.inputRows },
    needle,
    heroCenter: frame.heroCenter,
    glowBase: frame.glowBase,
    surfaceBase: frame.surfaceBase,
  };
}

/** 落点匹配用的草稿片段：第一行去掉首尾空白后的前 24 个字符（对话区可能再折行）。 */
export function startupExitNeedle(draft: string): string {
  return [...(draft.split("\n")[0] ?? "").trim()].slice(0, 24).join("");
}

/** 在对话画面里找用户消息：第一个包含草稿片段的行，返回片段起点。 */
export function findStartupExitAnchor(
  rows: readonly string[],
  needle: string,
  fromRow = 0,
): { row: number; column: number } | undefined {
  if (!needle) return undefined;
  for (let row = Math.max(0, fromRow); row < rows.length; row++) {
    const plain = stripAnsi(rows[row]);
    const index = plain.indexOf(needle);
    if (index >= 0) return { row, column: terminalWidth(plain.slice(0, index)) };
  }
  return undefined;
}

/** 合成一帧过渡画面；progress ≥ 1 时直接返回真实画面。 */
export function composeStartupExit(
  scene: StartupExitScene,
  target: StartupExitTarget,
  progress: number,
): string[] {
  if (progress >= 1) return [...target.rows];
  const p = Math.max(0, progress);
  const theme = getTheme();
  const { width, height } = scene;
  const toward = scene.surfaceBase;
  const blend = canBlendCells(toward);
  const canvas = new CellCanvas(width, height);
  if (scene.glowBase) {
    canvas.backdrop = glowLayer(
      width,
      height,
      scene.heroCenter,
      scene.glowBase,
      theme.accent,
      1 - smoothstep(0, 0.7, p),
    );
  }

  const decorAlpha = 1 - (blend ? smoothstep(0, 0.55, p) : smoothstep(0, 0.5, p));
  const liveAlpha = blend ? smoothstep(0.3, 1, p) : smoothstep(0.5, 0.8, p);
  const drawLive = (): void => {
    target.rows.slice(0, height).forEach((row, index) => {
      canvas.overlay(parsedRow(row, width), liveAlpha, toward, 0, index);
    });
  };
  // 谁更实就画在上面：重叠的格子不会出现半透明叠字。
  if (decorAlpha >= liveAlpha) {
    drawLive();
    canvas.overlay(scene.decor, decorAlpha, toward);
  } else {
    canvas.overlay(scene.decor, decorAlpha, toward);
    drawLive();
  }

  // 卡片：位置与尺寸按缓动插值，后段褪去底色变成真实的输入行。
  const move = easeInOutCubic(Math.min(1, p / 0.85));
  const from = scene.card;
  const to = target.input;
  const cardTop = Math.round(lerp(from.top, to.top, move));
  const cardHeight = Math.max(1, Math.round(lerp(from.height, to.height, move)));
  const cardLeft = Math.round(lerp(from.left, to.left, move));
  const cardWidth = Math.max(2, Math.round(lerp(from.width, to.width, move)));
  const card = new CellCanvas(cardWidth, cardHeight);
  const colorful = getColorLevel() !== "mono";
  for (let row = 0; row < cardHeight; row++) {
    if (colorful) card.fill(1, row, cardWidth - 1, 1, bgSeq(from.hex));
    const t = cardHeight > 1 ? row / (cardHeight - 1) : 0;
    card.text(0, row, "▌", {
      fg: fgSeq(colorful ? mixHexOklab(theme.accent, theme.cyan, t) : theme.accent),
    });
  }
  canvas.overlay(card, 1 - smoothstep(0.65, 1, p), toward, cardLeft, cardTop);

  // 草稿：找到落点就飞过去并保持可见，没找到就随卡片淡出。
  if (scene.text.rows.length > 0) {
    const fly = easeInOutCubic(Math.min(1, p / 0.8));
    const anchor = target.anchor;
    const sourceColumn = scene.needle?.column ?? scene.text.left;
    const dx = anchor ? anchor.column - sourceColumn : cardLeft - from.left;
    const dy = anchor ? anchor.row - scene.text.top : cardTop - from.top;
    const shiftX = Math.round(dx * (anchor ? fly : 1));
    const shiftY = Math.round(dy * (anchor ? fly : 1));
    const alpha = anchor ? 1 : 1 - smoothstep(0.2, 0.7, p);
    scene.text.rows.forEach((row, index) => {
      canvas.overlay(
        parsedRow(row, width),
        alpha,
        toward,
        scene.text.left + shiftX,
        scene.text.top + index + shiftY,
      );
    });
  }
  return canvas.toRows();
}

/** 对话画面逐行解析的缓存：过渡期间大部分行不变，拆字素是合成里最贵的一步。 */
const rowCache = new Map<string, CellCanvas>();
function parsedRow(row: string, width: number): CellCanvas {
  const key = `${width}|${row}`;
  let canvas = rowCache.get(key);
  if (!canvas) {
    canvas = new CellCanvas(width, 1);
    canvas.ansi(0, 0, row);
    if (rowCache.size > 512) rowCache.clear();
    rowCache.set(key, canvas);
  }
  return canvas;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
