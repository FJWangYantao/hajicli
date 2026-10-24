import fs from "node:fs";
import path from "node:path";

/** 支持的图片格式（扩展名 → MIME）。 */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
});

/** 单张图片的体积上限（base64 前的原始字节；过大大多是无意义截图）。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export interface ImageCommandParse {
  imagePath: string;
  prompt: string;
}

/** 解析 `/image <图片路径> [提示词...]`；缺路径返回 undefined（调用方给用法提示）。 */
export function parseImageCommand(parts: string[]): ImageCommandParse | undefined {
  if (!parts[1]?.trim()) return undefined;
  return {
    imagePath: parts[1],
    prompt: parts.slice(2).join(" ").trim() || "请分析这张图片。",
  };
}

export type ImageAttachment =
  | { ok: true; mimeType: string; base64: string }
  | { ok: false; error: string };

/**
 * 读取图片文件为多模态附件。/image 是用户显式动作，允许工作区外的路径
 * （截图常在系统目录），但仍限制格式与体积。
 */
export function loadImageAttachment(filePath: string): ImageAttachment {
  const resolved = path.resolve(filePath);
  const extension = path.extname(resolved).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
  if (!mimeType) {
    return {
      ok: false,
      error: `不支持的图片格式 ${extension || "（无扩展名）"}，支持：${Object.keys(IMAGE_MIME_BY_EXTENSION).join(" / ")}`,
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `图片不存在：${resolved}` };
  }
  if (!stat.isFile()) return { ok: false, error: `不是普通文件：${resolved}` };
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB，上限 6MB），请先压缩。`,
    };
  }
  try {
    return { ok: true, mimeType, base64: fs.readFileSync(resolved).toString("base64") };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `读取失败：${detail}` };
  }
}
