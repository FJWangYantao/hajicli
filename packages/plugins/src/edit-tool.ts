import * as fs from "node:fs/promises";
import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";
import { contentHash, FileConflictError, writeUtf8Atomically } from "./file-content.js";
import { formatWorkspaceError, resolveWorkspacePath } from "./workspace-path.js";

function parseExpectedHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/i.test(value)) {
    throw new Error("expectedHash 必须是 read 返回的16位十六进制 hash。");
  }
  return value.toLowerCase();
}

/** 诊断片段的最大行数与单行最大长度，避免失败信息本身撑爆上下文。 */
const HINT_MAX_LINES = 12;
const HINT_MAX_LINE_LENGTH = 200;
/** read 默认输出的「行号 | 」前缀。 */
const LINE_NUMBER_PREFIX_RE = /^\s*\d+ \| /;

/**
 * 在 content 中定位 oldText；精确匹配失败且文件是 CRLF 而 oldText 只含 LF 时，
 * 按 CRLF 再匹配一次（read 输出会去掉 \r，模型看不到行尾差异）。
 */
function locateOldText(
  content: string,
  oldText: string,
  newText: string,
): { index: number; oldText: string; newText: string; count: number } {
  const count = (needle: string): { index: number; count: number } => {
    const index = content.indexOf(needle);
    if (index === -1) return { index, count: 0 };
    return { index, count: content.indexOf(needle, index + needle.length) === -1 ? 1 : 2 };
  };
  const exact = count(oldText);
  if (exact.count > 0 || !content.includes("\r\n") || !oldText.includes("\n")) {
    return { ...exact, oldText, newText };
  }
  const toCrlf = (value: string) => value.replace(/\r?\n/g, "\r\n");
  const crlfOld = toCrlf(oldText);
  return { ...count(crlfOld), oldText: crlfOld, newText: toCrlf(newText) };
}

/**
 * oldText 未命中时给出可据以修正的线索：常见的复制错误，或文件中最接近位置的实际内容（带行号）。
 * 让模型一步改对，而不是凭记忆反复猜原文。
 */
export function describeOldTextMiss(content: string, oldText: string): string {
  const fileLines = content.split(/\r?\n/);
  const oldLines = oldText.split(/\r?\n/);
  if (oldLines.some((line) => LINE_NUMBER_PREFIX_RE.test(line))) {
    return "oldText 带有 read 输出的「行号 | 」前缀，请去掉前缀后只保留文件原文。";
  }
  if (oldText.includes("…") && !content.includes("…")) {
    return "oldText 含有 read 截断超长行时加的「…」，请改用该行中未被截断的部分作为上下文。";
  }

  // 用 oldText 中最长的一行做锚点，忽略缩进与行尾空白，在文件里找它的实际位置。
  const anchor = oldLines.reduce((best, line) =>
    line.trim().length > best.trim().length ? line : best,
  );
  const anchorText = anchor.trim();
  const anchorOffset = oldLines.indexOf(anchor);
  const hits: number[] = [];
  if (anchorText) {
    fileLines.forEach((line, index) => {
      if (line.trim() === anchorText) hits.push(index);
    });
  }
  if (hits.length === 0) {
    return `oldText 中最具特征的一行在文件里不存在（${anchorText.slice(0, 80) || "空白"}）。文件可能已被之前的编辑改动，请先用 read 重新读取相关区域，不要凭记忆重试。`;
  }

  const start = Math.max(0, hits[0] - anchorOffset - 1);
  const end = Math.min(fileLines.length, start + Math.min(oldLines.length + 2, HINT_MAX_LINES));
  const snippet = fileLines
    .slice(start, end)
    .map((line, offset) => {
      const text =
        line.length > HINT_MAX_LINE_LENGTH ? `${line.slice(0, HINT_MAX_LINE_LENGTH - 1)}…` : line;
      return `${start + offset + 1} | ${text}`;
    })
    .join("\n");
  const where = hits.length > 1 ? `（该行共出现 ${hits.length} 处，以下为第 1 处）` : "";
  return `文件中最接近的位置${where}实际内容如下，请对照缩进、空白和字符逐字修正 oldText（不要带行号前缀）：\n${snippet}`;
}

export class EditFileTool implements BaseTool {
  public readonly name = "edit";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "edit",
      description:
        "在文件中唯一匹配 oldText 并原子替换为 newText。可传入 read 返回的 expectedHash 防止覆盖外部修改。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文件路径。" },
          oldText: { type: "string", description: "必须在文件中唯一匹配的原文。" },
          newText: { type: "string", description: "替换后的文本。" },
          expectedHash: {
            type: "string",
            description: "可选，read 返回的16位内容 hash。文件已变化时拒绝编辑。",
          },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  };

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    if (typeof args.path !== "string" || !args.path) return "错误: 缺少 path 参数。";
    if (typeof args.oldText !== "string") return "错误: oldText 必须是字符串。";
    if (typeof args.newText !== "string") return "错误: newText 必须是字符串。";
    let expectedHash: string | undefined;
    try {
      expectedHash = parseExpectedHash(args.expectedHash);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (context?.abortSignal?.aborted) return "[文件编辑已中止]";

    const filePath = args.path;
    try {
      const resolvedPath = await resolveWorkspacePath(filePath);
      // 按原始字节计算 hash，与 read 工具返回的 hash 口径一致（UTF-8 解码有损的文件也能正确比对）。
      const buffer = await fs.readFile(resolvedPath, { signal: context?.abortSignal });
      if (context?.abortSignal?.aborted) return "[文件编辑已中止]";
      const content = buffer.toString("utf8");
      const originalHash = contentHash(buffer);
      if (expectedHash !== undefined && expectedHash !== originalHash) {
        return `编辑失败: 文件已被修改，期望 hash=${expectedHash}，当前 hash=${originalHash}。请重新读取后再编辑。`;
      }

      const match = locateOldText(content, args.oldText, args.newText);
      if (match.count === 0) {
        return `编辑失败: 在文件中找不到指定的 oldText 原文。\n${describeOldTextMiss(content, args.oldText)}`;
      }
      if (match.count > 1) {
        return "编辑失败: oldText 匹配到多处，为安全起见已拒绝修改。请增加上下文确保唯一。";
      }

      const newContent =
        content.slice(0, match.index) +
        match.newText +
        content.slice(match.index + match.oldText.length);
      const newHash = contentHash(newContent);
      await writeUtf8Atomically(resolvedPath, newContent, context?.abortSignal, originalHash);
      return `[文件精准编辑成功]\n路径: ${filePath}\noldHash=${originalHash}\nnewHash=${newHash}\n替换次数=1`;
    } catch (error) {
      if (
        context?.abortSignal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return "[文件编辑已中止]";
      }
      if (error instanceof FileConflictError) {
        return `编辑失败: ${error.message}。请重新读取后再编辑。`;
      }
      return `精准编辑文件失败: ${formatWorkspaceError(error, filePath)}`;
    }
  }
}
