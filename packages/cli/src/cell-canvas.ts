/**
 * 逐格画布：首页这类需要「背景层 + 文字层」叠加的整屏视图用它排版。
 *
 * 字符串拼 ANSI 做不到逐格背景（光晕每格颜色都不同，而文字里的 themeReset 会把背景清回主题色），
 * 所以这里先把所有内容落成格子（字符 / 前景 / 背景 / 属性），最后按行串成 ANSI。
 * 颜色一律存「已按当前色彩档位生成的 SGR 序列」（fgSeq / bgSeq 的输出），画布本身不关心档位。
 */

import { mixHexOklab } from "./oklab.js";
import { splitGraphemes, terminalWidth } from "./terminal-text.js";
import { bgSeq, fgSeq, getColorLevel, getTheme } from "./theme.js";

export interface CellStyle {
  /** 前景 SGR；空串表示主题正文色。 */
  fg?: string;
  /** 背景 SGR；undefined 表示透明（落到背景层或主题底色）。 */
  bg?: string;
  bold?: boolean;
}

interface Cell {
  ch: string;
  /** 0 表示宽字符的第二格（不单独输出）。 */
  width: 0 | 1 | 2;
  fg: string;
  bg?: string;
  /** 额外 SGR 参数（粗体 1、反显 7…），按数值排序去重。 */
  attrs: readonly number[];
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/y;
const OTHER_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/y;
const ATTR_ON = new Set([1, 2, 3, 4, 7, 9]);
const ATTR_OFF: Record<number, readonly number[]> = {
  22: [1, 2],
  23: [3],
  24: [4],
  27: [7],
  29: [9],
};

function blank(): Cell {
  return { ch: " ", width: 1, fg: "", attrs: [] };
}

export class CellCanvas {
  readonly cols: number;
  readonly rows: number;
  private readonly cells: Cell[][];
  /** 透明格的背景来源（光晕）；返回 undefined 表示用主题底色。 */
  backdrop?: (column: number, row: number) => string | undefined;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(0, cols);
    this.rows = Math.max(0, rows);
    this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, blank));
  }

  /** 该格是否还没被写过（空格且透明），星点这类装饰只落在空白处。 */
  isEmpty(column: number, row: number): boolean {
    const cell = this.cells[row]?.[column];
    return Boolean(cell && cell.ch === " " && cell.bg === undefined && cell.attrs.length === 0);
  }

  fill(column: number, row: number, width: number, height: number, bg: string | undefined): void {
    for (let y = row; y < row + height; y++) {
      for (let x = column; x < column + width; x++) {
        const cell = this.cells[y]?.[x];
        if (cell) cell.bg = bg;
      }
    }
  }

  /** 写纯文本（不含转义序列），返回写完后的列号；越界部分丢弃，宽字符放不下整个时不写。 */
  text(column: number, row: number, text: string, style: CellStyle = {}): number {
    const attrs = style.bold ? [1] : [];
    let x = column;
    for (const grapheme of splitGraphemes(text)) {
      x = this.put(x, row, grapheme, style.fg ?? "", style.bg, attrs, style.bg !== undefined);
    }
    return x;
  }

  /**
   * 写一段带 SGR 的文本（输入行、补全候选这类外部已上色的内容）。
   * 主题底色与 SGR 49 都视为透明，透明格用 `bg`（卡片底色）兜底。
   */
  ansi(column: number, row: number, text: string, bg?: string): number {
    const theme = getTheme();
    const themeBg = bgSeq(theme.background);
    let fg = "";
    let cellBg: string | undefined;
    let attrs: number[] = [];
    let x = column;
    let index = 0;
    let plain = "";
    const flush = (): void => {
      if (!plain) return;
      for (const grapheme of splitGraphemes(plain)) {
        x = this.put(x, row, grapheme, fg, cellBg ?? bg, attrs, true);
      }
      plain = "";
    };
    while (index < text.length) {
      if (text[index] === "\x1b") {
        SGR_PATTERN.lastIndex = index;
        const sgr = SGR_PATTERN.exec(text);
        if (sgr) {
          flush();
          const state = applySgr(sgr[1], { fg, bg: cellBg, attrs });
          fg = state.fg;
          cellBg = state.bg === themeBg ? undefined : state.bg;
          attrs = state.attrs;
          index += sgr[0].length;
          continue;
        }
        OTHER_ESCAPE.lastIndex = index;
        const other = OTHER_ESCAPE.exec(text);
        if (other) {
          flush();
          index += other[0].length;
          continue;
        }
      }
      plain += text[index];
      index += 1;
    }
    flush();
    return x;
  }

  private put(
    column: number,
    row: number,
    grapheme: string,
    fg: string,
    bg: string | undefined,
    attrs: readonly number[],
    overrideBg: boolean,
  ): number {
    const width = Math.min(2, terminalWidth(grapheme)) as 0 | 1 | 2;
    if (width === 0) return column;
    const line = this.cells[row];
    if (!line || column < 0 || column + width > this.cols) return column + width;
    const first = line[column];
    // 覆盖到宽字符的后半格时，把前半格清掉，避免残留半个字。
    if (first.width === 0 && column > 0) line[column - 1] = { ...blank(), bg: line[column - 1].bg };
    const keepBg = overrideBg ? bg : first.bg;
    line[column] = { ch: grapheme, width, fg, bg: keepBg, attrs: [...attrs] };
    if (width === 2) {
      const second = line[column + 1];
      line[column + 1] = { ch: "", width: 0, fg, bg: overrideBg ? bg : second.bg, attrs: [] };
      if (line[column + 2]?.width === 0) line[column + 2] = { ...blank(), bg: line[column + 2].bg };
    }
    return column + width;
  }

  /**
   * 把另一张画布已写过的格子叠上来（透明格不覆盖）。`alpha` < 1 时：能混色（见 canBlendCells）
   * 就把前景 / 背景朝底色混（淡入淡出）；否则按格子位置伪随机整格丢弃（溶解），任何色彩档位都成立。
   * `dx` / `dy` 是源画布左上角落在本画布上的位置，小画布（一张卡片、一行文字）不必铺满整屏。
   */
  overlay(source: CellCanvas, alpha: number, toward?: string, dx = 0, dy = 0): void {
    if (alpha <= 0) return;
    const fade = alpha < 1 && canBlendCells(toward) ? 1 - alpha : 0;
    const baseFg = getTheme().foreground;
    for (let sy = 0; sy < source.rows; sy++) {
      const y = sy + dy;
      const to = this.cells[y];
      if (!to) continue;
      const from = source.cells[sy];
      for (let sx = 0; sx < source.cols; sx++) {
        const x = sx + dx;
        if (x < 0 || x >= this.cols) continue;
        const cell = from[sx];
        if (cell.width === 0) continue;
        if (cell.ch === " " && cell.bg === undefined && cell.attrs.length === 0) continue;
        if (cell.width === 2 && x + 1 >= this.cols) continue;
        let fg = cell.fg;
        let bg = cell.bg;
        if (fade > 0) {
          const fgHex = sgrHex(fg) ?? (fg === "" ? baseFg : undefined);
          const bgHex = bg === undefined ? undefined : sgrHex(bg);
          if (fgHex && (bg === undefined || bgHex)) {
            fg = fadedSeq(fgHex, toward as string, fade, false);
            if (bgHex) bg = fadedSeq(bgHex, toward as string, fade, true);
          } else if (dissolveHash(x, y) >= alpha) continue;
        } else if (alpha < 1 && dissolveHash(x, y) >= alpha) continue;
        // 覆盖宽字符的后半格时连前半格一起清掉，和 put() 同一口径。
        if (to[x].width === 0 && x > 0) to[x - 1] = { ...blank(), bg: to[x - 1].bg };
        to[x] = { ...cell, fg, bg, attrs: [...cell.attrs] };
        if (cell.width === 2) {
          to[x + 1] = { ch: "", width: 0, fg, bg, attrs: [] };
          if (to[x + 2]?.width === 0) to[x + 2] = { ...blank(), bg: to[x + 2].bg };
        }
      }
    }
  }

  /** 串成 ANSI 行：同样式的相邻格合并；行尾透明空白裁掉，最后补主题重置。 */
  toRows(): string[] {
    const mono = getColorLevel() === "mono";
    const theme = getTheme();
    const baseFg = fgSeq(theme.foreground);
    const baseBg = bgSeq(theme.background);
    return this.cells.map((line, row) => {
      const effective = line.map(
        (cell, column) =>
          cell.bg ??
          (cell.width === 0 && column > 0 ? line[column - 1].bg : undefined) ??
          this.backdrop?.(column, row),
      );
      let end = line.length;
      while (end > 0) {
        const cell = line[end - 1];
        if (cell.ch !== " " || cell.attrs.length > 0 || effective[end - 1] !== undefined) break;
        end -= 1;
      }
      let out = "";
      let current = "";
      for (let column = 0; column < end; column++) {
        const cell = line[column];
        if (cell.width === 0) continue;
        const attrs = mono ? cell.attrs.filter((code) => code === 7) : cell.attrs;
        const style = mono
          ? attrs.length > 0
            ? `\x1b[0;${attrs.join(";")}m`
            : current
              ? "\x1b[0m"
              : ""
          : `\x1b[0${attrs.length > 0 ? `;${attrs.join(";")}` : ""}m${cell.fg || baseFg}${effective[column] ?? baseBg}`;
        if (style !== current) {
          out += style;
          current = style;
        }
        out += cell.ch;
      }
      if (current) out += mono ? "\x1b[0m" : `\x1b[0m${baseFg}${baseBg}`;
      return out;
    });
  }
}

/** 叠层能否按颜色淡入淡出：要知道底色，且是真彩色或 256 色（16 色 / 无色只能溶解）。 */
export function canBlendCells(toward: string | undefined): toward is string {
  const level = getColorLevel();
  return Boolean(toward) && (level === "truecolor" || level === "ansi256");
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
const fadeCache = new Map<string, string>();
const hexCache = new Map<string, string | undefined>();

/** 淡出后的颜色序列：混合比例按 1/32 取整后缓存，整屏几千格只算几十次 Oklab。 */
function fadedSeq(hex: string, toward: string, fade: number, background: boolean): string {
  const step = Math.round(fade * 32);
  const key = `${background ? "b" : "f"}${getColorLevel()}${hex}${toward}${step}`;
  let sequence = fadeCache.get(key);
  if (sequence === undefined) {
    const mixed = mixHexOklab(hex, toward, step / 32);
    sequence = background ? bgSeq(mixed) : fgSeq(mixed);
    if (fadeCache.size > 4096) fadeCache.clear();
    fadeCache.set(key, sequence);
  }
  return sequence;
}

/** SGR 颜色还原成 #rrggbb：真彩色直接取值，256 色查色立方 / 灰阶；16 色返回 undefined。 */
function sgrHex(sequence: string): string | undefined {
  if (hexCache.has(sequence)) return hexCache.get(sequence);
  const hex = parseSgrHex(sequence);
  if (hexCache.size > 4096) hexCache.clear();
  hexCache.set(sequence, hex);
  return hex;
}

function parseSgrHex(sequence: string): string | undefined {
  const truecolor = /^\x1b\[[34]8;2;(\d+);(\d+);(\d+)m$/.exec(sequence);
  let rgb: number[] | undefined;
  if (truecolor) rgb = truecolor.slice(1, 4).map(Number);
  else {
    const indexed = /^\x1b\[[34]8;5;(\d+)m$/.exec(sequence);
    const index = indexed ? Number(indexed[1]) : -1;
    if (index >= 232 && index <= 255) rgb = new Array(3).fill(8 + (index - 232) * 10);
    else if (index >= 16 && index < 232) {
      const offset = index - 16;
      rgb = [Math.floor(offset / 36), Math.floor(offset / 6) % 6, offset % 6].map(
        (level) => CUBE_LEVELS[level],
      );
    }
  }
  return rgb ? `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}` : undefined;
}

/** 溶解用的格子阈值：同一位置每帧相同，画面是逐格散开而不是闪烁。 */
function dissolveHash(column: number, row: number): number {
  let value = (column * 374761393 + row * 668265263) | 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

function applySgr(
  params: string,
  state: { fg: string; bg: string | undefined; attrs: readonly number[] },
): { fg: string; bg: string | undefined; attrs: number[] } {
  let { fg, bg } = state;
  const attrs = new Set(state.attrs);
  const codes = params === "" ? [0] : params.split(";").map((value) => Number(value) || 0);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0) {
      fg = "";
      bg = undefined;
      attrs.clear();
    } else if (ATTR_ON.has(code)) attrs.add(code);
    else if (ATTR_OFF[code]) for (const off of ATTR_OFF[code]) attrs.delete(off);
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = `\x1b[${code}m`;
    else if (code === 39) fg = "";
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = `\x1b[${code}m`;
    else if (code === 49) bg = undefined;
    else if (code === 38 || code === 48) {
      const mode = codes[index + 1];
      const span = mode === 2 ? 4 : mode === 5 ? 2 : 0;
      if (span === 0) continue;
      const sequence = `\x1b[${codes.slice(index, index + 1 + span).join(";")}m`;
      if (code === 38) fg = sequence;
      else bg = sequence;
      index += span;
    }
  }
  return { fg, bg, attrs: [...attrs].sort((a, b) => a - b) };
}
