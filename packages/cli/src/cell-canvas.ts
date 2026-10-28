/**
 * 逐格画布：首页这类需要「背景层 + 文字层」叠加的整屏视图用它排版。
 *
 * 字符串拼 ANSI 做不到逐格背景（光晕每格颜色都不同，而文字里的 themeReset 会把背景清回主题色），
 * 所以这里先把所有内容落成格子（字符 / 前景 / 背景 / 属性），最后按行串成 ANSI。
 * 颜色一律存「已按当前色彩档位生成的 SGR 序列」（fgSeq / bgSeq 的输出），画布本身不关心档位。
 */
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
