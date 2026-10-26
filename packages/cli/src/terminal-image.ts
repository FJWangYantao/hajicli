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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** kitty 负载分块上限（base64 字符数），与官方参考实现一致。 */
const KITTY_CHUNK_SIZE = 4096;

function encodeKittyChunks(control: string, png: Buffer, tmux: boolean): string {
  const payload = png.toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += KITTY_CHUNK_SIZE) {
    chunks.push(payload.slice(offset, offset + KITTY_CHUNK_SIZE));
  }
  if (chunks.length === 0) return "";
  const sequence = chunks
    .map((chunk, index) => {
      const isFirst = index === 0;
      const isLast = index === chunks.length - 1;
      const keys = isFirst ? `${control}${isLast ? "" : ",m=1"}` : `m=${isLast ? 0 : 1}`;
      return `\x1b_G${keys};${chunk}\x1b\\`;
    })
    .join("");
  return wrap(sequence, tmux);
}

/**
 * kitty graphics：`a=T` 传输并显示，`f=100` 表示 PNG 原始字节，`c/r` 指定单元格尺寸。
 * /view 的整屏贴图走这里；聊天流内联图改用 a=t 上传 + a=p 放置（见 encodeKittyUpload）。
 */
export function encodeKittyImage(
  png: Buffer,
  options: { cols: number; rows: number; id?: number; tmux?: boolean },
): string {
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  return encodeKittyChunks(
    `a=T,f=100,i=${options.id ?? 1},c=${cols},r=${rows},q=2`,
    png,
    Boolean(options.tmux),
  );
}

/**
 * kitty graphics：`a=t` 只上传不显示（带稳定 image id）。之后任意多次 `a=p` 放置
 * 都不需要重传数据；`q=2` 抑制 ACK 响应，避免其窜入键盘输入流。
 */
export function encodeKittyUpload(png: Buffer, options: { id: number; tmux?: boolean }): string {
  return encodeKittyChunks(`a=t,f=100,i=${options.id},q=2`, png, Boolean(options.tmux));
}

/**
 * kitty graphics：`a=p` 在光标处放置已上传的图片。相同 (image id, placement id)
 * 再次发送会原地替换——这是协议提供的「无闪烁移动 / 改尺寸」手段；`c/r` 改变显示尺寸
 * 也只作用于 placement，不必重传数据。`src` 是 0 基像素源矩形（协议键 x/y/w/h），
 * 裁剪区域会被缩放到 c×r，用于部分可见时只贴可见的那段。
 */
export function encodeKittyPlacement(options: {
  id: number;
  placementId: number;
  cols: number;
  rows: number;
  src?: { x: number; y: number; w: number; h: number };
  tmux?: boolean;
}): string {
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  const src = options.src
    ? `,x=${Math.max(0, Math.floor(options.src.x))},y=${Math.max(0, Math.floor(options.src.y))},w=${Math.max(1, Math.floor(options.src.w))},h=${Math.max(1, Math.floor(options.src.h))}`
    : "";
  return wrap(
    `\x1b_Ga=p,i=${options.id},p=${options.placementId},c=${cols},r=${rows}${src},q=2\x1b\\`,
    Boolean(options.tmux),
  );
}

/**
 * kitty graphics：删除指定 (image id, placement id) 的单个 placement。
 * 小写 `d=i` 只撤画面、保留图像数据，图片滚回视口时 `a=p` 即可恢复。
 */
export function encodeKittyPlacementDelete(options: {
  id: number;
  placementId: number;
  tmux?: boolean;
}): string {
  return wrap(
    `\x1b_Ga=d,d=i,i=${options.id},p=${options.placementId},q=2\x1b\\`,
    Boolean(options.tmux),
  );
}

/** kitty graphics：按 image id 删除并释放数据（大写 `d=I`），段被丢弃时回收终端配额。 */
export function encodeKittyImageDispose(id: number, tmux = false): string {
  return wrap(`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`, tmux);
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

/** 聊天流内联图的上限：比 /view 的 20MB 紧——内联图会整段进终端图形配额。 */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
/** 内联图在聊天流里占的行数上限：再大就该用 /view 整屏看了。 */
export const INLINE_IMAGE_MAX_ROWS = 20;

/** 聊天流内联图描述：段渲染与帧尾同步层共用。 */
export interface InlineImageDescription {
  protocol: ImageProtocol;
  tmux: boolean;
  /** kitty 已确保 PNG（必要时借 ffmpeg 转码）；降级协议下无数据。 */
  png?: Buffer;
  widthPx: number;
  heightPx: number;
  /** 图下一行的说明文字，例如 `shot.png · 1440×757`。 */
  caption: string;
}

export type InlineImageBuild =
  | { ok: true; image: InlineImageDescription }
  | { ok: false; error: string };

/** JPEG/WEBP 等借 ffmpeg 转一份临时 PNG（kitty 的 f=100 只吃 PNG）。 */
function ensurePngForKitty(buffer: Buffer, filePath: string): Buffer | undefined {
  if (isPng(buffer)) return buffer;
  const temp = path.join(os.tmpdir(), `haji-inline-${process.pid}-${Date.now()}.png`);
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", filePath, "-frames:v", "1", temp], {
      stdio: "ignore",
      timeout: 20000,
    });
    return fs.existsSync(temp) ? fs.readFileSync(temp) : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * 为聊天流准备一张内联图：读盘 → 校验 → 探测协议 → kitty 场景确保 PNG。
 * 只做纯数据准备，不碰 TUI；cols/rows 折算在渲染时按当时 chatWidth 进行。
 */
export function buildInlineImage(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): InlineImageBuild {
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `图片不存在：${resolved}` };
  }
  if (!stat.isFile()) return { ok: false, error: `不是普通文件：${resolved}` };
  if (stat.size > MAX_INLINE_IMAGE_BYTES) {
    return {
      ok: false,
      error: `图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB，内联上限 8MB），可用 /view 整屏查看。`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `读取失败：${detail}` };
  }
  const dimensions = readImageDimensions(buffer);
  if (!dimensions.width || !dimensions.height) {
    return { ok: false, error: `只支持 PNG / JPEG 图片：${resolved}` };
  }

  const protocol = detectImageProtocol(env);
  const caption = `${path.basename(resolved)} · ${dimensions.width}×${dimensions.height}`;
  // iTerm2 的 1337 没有删除/移动指令，无法管理内联生命周期：降级为提示行。
  if (protocol !== "kitty") {
    return {
      ok: true,
      image: {
        protocol,
        tmux: Boolean(env.TMUX),
        widthPx: dimensions.width,
        heightPx: dimensions.height,
        caption,
      },
    };
  }

  const png = ensurePngForKitty(buffer, resolved);
  if (!png) {
    return {
      ok: false,
      error: "kitty 协议只能内联 PNG；系统里也没有 ffmpeg 可以转码（/view 整屏查看同样受限）。",
    };
  }
  return {
    ok: true,
    image: {
      protocol,
      tmux: Boolean(env.TMUX),
      png,
      widthPx: dimensions.width,
      heightPx: dimensions.height,
      caption,
    },
  };
}

/** placement 期望态：屏幕坐标 1 基，由帧渲染计算。 */
export interface InlinePlacementSpec {
  /** 屏幕行（1 基，图片矩形顶行）。 */
  row: number;
  /** 屏幕列（1 基，图片左缘）。 */
  col: number;
  cols: number;
  rows: number;
  /** 部分可见时的源矩形（0 基像素）；整图可见时省略。 */
  src?: { x: number; y: number; w: number; h: number };
}

export interface InlinePlacementPlan {
  /** 需要上传数据（首次出现，或屏幕整体重置后数据可能已被清）。 */
  upload: boolean;
  place: InlinePlacementSpec;
}

/**
 * 内联图同步 diff：比较「已在屏幕上的 placement」与「本帧期望」，给出每张图的动作。
 * 位置与尺寸都没变 → 无动作（流式输出期间的绝大多数帧零开销）。
 */
export function diffInlinePlacements(
  current: InlinePlacementSpec | undefined,
  desired: InlinePlacementSpec | undefined,
  uploaded: boolean,
): { action: "none" } | { action: "delete" } | { action: "place"; plan: InlinePlacementPlan } {
  if (!desired) return current ? { action: "delete" } : { action: "none" };
  if (current && samePlacement(current, desired) && uploaded) return { action: "none" };
  return { action: "place", plan: { upload: !uploaded, place: desired } };
}

function samePlacement(a: InlinePlacementSpec, b: InlinePlacementSpec): boolean {
  return (
    a.row === b.row &&
    a.col === b.col &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    sameSourceRect(a.src, b.src)
  );
}

function sameSourceRect(
  a: { x: number; y: number; w: number; h: number } | undefined,
  b: { x: number; y: number; w: number; h: number } | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * 视口裁剪：求图片占位行区间与可视行区间的交集。完全不可见 → undefined；
 * 部分可见 → 按行比例折算 0 基像素源矩形。整图按 fitted 均匀铺满，等比裁剪
 * 缩放到可见行列后与整图放置逐像素对齐，滚动时上下边缘不会跳变。
 */
export function clipInlinePlacement(
  image: { start: number; rows: number; widthPx: number; heightPx: number },
  viewport: { visibleStart: number; visibleEnd: number },
):
  | {
      clippedRows: number;
      visibleRows: number;
      src?: { x: number; y: number; w: number; h: number };
    }
  | undefined {
  const clippedRows = Math.max(0, viewport.visibleStart - image.start);
  const clipBottom = Math.max(0, image.start + image.rows - viewport.visibleEnd);
  const visibleRows = image.rows - clippedRows - clipBottom;
  if (visibleRows <= 0) return undefined;
  if (clippedRows === 0 && clipBottom === 0) return { clippedRows, visibleRows };
  const pxPerRow = image.heightPx / image.rows;
  const y = Math.min(Math.max(0, image.heightPx - 1), Math.round(clippedRows * pxPerRow));
  const yEnd = Math.max(
    y + 1,
    Math.min(image.heightPx, Math.round((clippedRows + visibleRows) * pxPerRow)),
  );
  return { clippedRows, visibleRows, src: { x: 0, y, w: image.widthPx, h: yEnd - y } };
}
