/**
 * `/view <图片>` 的纯逻辑层：校验文件 → 探测协议 → 折算单元格 → 编码成终端序列。
 *
 * 与 `/image` 的区别：/image 把图片塞给模型（需要视觉模型），/view 只画给用户看。
 * 这里不碰 TUI 状态，返回一段可直接交给 TerminalUI.viewImage 的描述。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectImageProtocol,
  encodeIterm2Image,
  encodeKittyImage,
  fitImageCells,
  type ImageProtocol,
  isPng,
  readImageDimensions,
} from "./terminal-image.js";

/** 查看上限比 read 的 6MB 宽松些：这只是本地显示，不进上下文。 */
const MAX_VIEW_BYTES = 20 * 1024 * 1024;

export interface ImageViewDescription {
  protocol: ImageProtocol;
  /** 已编码的终端图片序列（含 tmux passthrough）。 */
  sequence: string;
  cols: number;
  rows: number;
  caption: string;
  tmux: boolean;
}

export type ImageViewResult =
  | { ok: true; view: ImageViewDescription }
  | { ok: false; error: string };

export interface ImageViewTerminal {
  columns: number;
  rows: number;
}

/** kitty 的 f=100 只吃 PNG：JPEG/WEBP 等先借 ffmpeg 转一份临时 PNG。 */
function toPng(buffer: Buffer, filePath: string): Buffer | undefined {
  if (isPng(buffer)) return buffer;
  const temp = path.join(os.tmpdir(), `haji-view-${process.pid}-${Date.now()}.png`);
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
 * 生成一次 `/view` 需要的全部信息。失败时返回可读原因，调用方直接展示。
 * `env` 可注入，便于测试协议探测。
 */
export function buildImageView(
  filePath: string,
  terminal: ImageViewTerminal,
  env: NodeJS.ProcessEnv = process.env,
): ImageViewResult {
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `图片不存在：${resolved}` };
  }
  if (!stat.isFile()) return { ok: false, error: `不是普通文件：${resolved}` };
  if (stat.size > MAX_VIEW_BYTES) {
    return {
      ok: false,
      error: `图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB，上限 20MB），请先压缩。`,
    };
  }

  const buffer = fs.readFileSync(resolved);
  const dimensions = readImageDimensions(buffer);
  if (!dimensions.width || !dimensions.height) {
    return { ok: false, error: `只支持 PNG / JPEG 图片：${resolved}` };
  }

  const protocol = detectImageProtocol(env);
  if (protocol === "none") {
    return {
      ok: false,
      error:
        "当前终端未启用图片协议；支持 kitty / iTerm2 的终端，或用 HAJI_IMAGE_PROTOCOL=kitty 指定。",
    };
  }

  const tmux = Boolean(env.TMUX);
  const { cols, rows } = fitImageCells(
    dimensions.width,
    dimensions.height,
    Math.max(10, (terminal.columns || 80) - 2),
    Math.max(5, (terminal.rows || 24) - 4),
  );

  let sequence: string;
  if (protocol === "kitty") {
    const png = toPng(buffer, resolved);
    if (!png) {
      return { ok: false, error: "kitty 协议只能用 PNG；系统里也没有 ffmpeg 可以转码。" };
    }
    sequence = encodeKittyImage(png, { cols, rows, tmux });
  } else {
    sequence = encodeIterm2Image(buffer, { cols, name: path.basename(resolved), tmux });
  }

  return {
    ok: true,
    view: {
      protocol,
      sequence,
      cols,
      rows,
      tmux,
      caption: `${path.basename(resolved)} · ${dimensions.width}×${dimensions.height}`,
    },
  };
}
