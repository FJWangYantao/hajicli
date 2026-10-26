/**
 * 终端内联图片：协议探测 + 序列编码 + 按单元格尺寸排版。
 *
 * 支持的协议：
 * - kitty graphics（kitty / ghostty / kero / WezTerm 等）
 * - iTerm2 OSC 1337（iTerm2 及其兼容终端）
 *
 * 这里只做「把一张图片变成终端转义序列」，不碰 TUI 状态；全屏查看由 TerminalUI 负责。
 * 尺寸算法把图片像素按单元格宽高比折算成行列数，避免拉扁。
 */

export type ImageProtocol = "kitty" | "iterm2" | "none";

export interface ImageCellSize {
  cols: number;
  rows: number;
}

/** 等宽字体单元格的高宽比（高 ≈ 2×宽）。取 2.0 是绝大多数等宽字体的常见值。 */
const CELL_ASPECT = 2;

/**
 * 探测当前终端支持哪种图片协议。
 * 优先读 HAJI_IMAGE_PROTOCOL（kitty / iterm2 / none），便于在探测不到的环境里手动指定；
 * 毫无线索时按 kitty 协议尝试 —— APC 序列在不支持的终端里通常被静默忽略，
 * 最坏情况是「没有图」，不会破坏界面。
 */
export function detectImageProtocol(env: NodeJS.ProcessEnv = process.env): ImageProtocol {
  const override = (env.HAJI_IMAGE_PROTOCOL ?? "").trim().toLowerCase();
  if (override === "none" || override === "off" || override === "0") return "none";
  if (override === "iterm2" || override === "iterm") return "iterm2";
  if (override === "kitty") return "kitty";

  const term = (env.TERM ?? "").toLowerCase();
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (/kitty|ghostty|kero/.test(term) || /kitty|ghostty|kero/.test(program)) return "kitty";
  if (program.includes("wezterm")) return "kitty";
  if (program.includes("iterm")) return "iterm2";
  return "kitty";
}

/**
 * 把图片像素尺寸折算成「放得下且不变形」的单元格行列数。
 * `cellAspect` 是单元格高 / 宽，默认 2。
 */
export function fitImageCells(
  widthPx: number,
  heightPx: number,
  maxCols: number,
  maxRows: number,
  cellAspect = CELL_ASPECT,
): ImageCellSize {
  const colsLimit = Math.max(1, Math.floor(maxCols));
  const rowsLimit = Math.max(1, Math.floor(maxRows));
  if (!(widthPx > 0) || !(heightPx > 0)) return { cols: colsLimit, rows: rowsLimit };
  const scale = Math.min(colsLimit / widthPx, (rowsLimit * cellAspect) / heightPx);
  const cols = Math.min(colsLimit, Math.max(1, Math.floor(widthPx * scale)));
  const rows = Math.min(rowsLimit, Math.max(1, Math.floor((heightPx * scale) / cellAspect)));
  return { cols, rows };
}

/** tmux 需要 DCS passthrough，内部的 ESC 要成对转义，否则被 tmux 自己吃掉。 */
function wrapTmux(sequence: string): string {
  return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

function wrap(sequence: string, tmux: boolean): string {
  return tmux ? wrapTmux(sequence) : sequence;
}

/**
 * kitty graphics：`a=T` 传输并显示，`f=100` 表示 PNG 原始字节，`c/r` 指定单元格尺寸。
 * base64 负载按 4096 字节分块，首块带控制键，后续块用 m=1 / m=0 续传。
 */
export function encodeKittyImage(
  png: Buffer,
  options: { cols: number; rows: number; id?: number; tmux?: boolean },
): string {
  const id = options.id ?? 1;
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  const payload = png.toString("base64");
  const chunkSize = 4096;
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(payload.slice(offset, offset + chunkSize));
  }
  if (chunks.length === 0) return "";
  const control = `a=T,f=100,i=${id},c=${cols},r=${rows},q=2`;
  const sequence = chunks
    .map((chunk, index) => {
      const isFirst = index === 0;
      const isLast = index === chunks.length - 1;
      const keys = isFirst ? `${control}${isLast ? "" : ",m=1"}` : `m=${isLast ? 0 : 1}`;
      return `\x1b_G${keys};${chunk}\x1b\\`;
    })
    .join("");
  return wrap(sequence, Boolean(options.tmux));
}

/**
 * iTerm2 内联图：OSC 1337，`width` 用单元格数列数，`preserveAspectRatio` 交给终端缩放；
 * 文件名要 base64（协议要求），缺省不影响显示。
 */
export function encodeIterm2Image(
  data: Buffer,
  options: { cols?: number; name?: string; tmux?: boolean },
): string {
  const params = ["inline=1", "preserveAspectRatio=1"];
  if (options.cols) params.push(`width=${Math.max(1, Math.floor(options.cols))}`);
  if (options.name) {
    params.push(`name=${Buffer.from(options.name, "utf8").toString("base64")}`);
  }
  const sequence = `\x1b]1337;${params.join(";")}:${data.toString("base64")}\x07`;
  return wrap(sequence, Boolean(options.tmux));
}

/** 清理上一次贴上去的图（iTerm2 无删除指令，清屏时随单元格一起消失）。 */
export function encodeDeleteImages(protocol: ImageProtocol, tmux = false): string {
  if (protocol !== "kitty") return "";
  return wrap("\x1b_Ga=d,d=A\x1b\\", tmux);
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** 从 PNG / JPEG 头部取像素尺寸；认不出来返回 0（调用方据此拒绝或按原始尺寸显示）。 */
export function readImageDimensions(buffer: Buffer): ImageDimensions {
  const bytes = buffer.subarray(0, Math.min(buffer.length, 256 * 1024));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(png)) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return { width: 0, height: 0 };
}

/** kitty 的 f=100 只吃 PNG；据此判断是否需要先转码。 */
export function isPng(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}
