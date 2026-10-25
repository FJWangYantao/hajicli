import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  BaseTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolImage,
  ToolOutput,
} from "@hajicli/core";
import { takeWholeRecords, truncateSingleLine } from "./bounded-output.js";
import { contentHash, fileVersions } from "./file-content.js";
import { parseIntegerOption } from "./search-filter.js";
import { formatWorkspaceError, resolveWorkspacePath } from "./workspace-path.js";

interface ReadRequest {
  path: string;
  startLine?: number;
  endLine?: number;
  limit: number;
  aroundLine?: number;
  contextLines: number;
  lineNumbers: boolean;
}

const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 1_000;
const MAX_CONTEXT_LINES = 100;
const MAX_BATCH_FILES = 10;
const MAX_OUTPUT_LENGTH = 8_000;
const MAX_RENDERED_LINE_LENGTH = 1_000;
/** 读取图片时的单张体积上限，与 /image 命令保持一致。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
});

function parseReadRequest(value: Record<string, unknown>): ReadRequest {
  if (typeof value.path !== "string" || !value.path.trim() || value.path.length > 1_024) {
    throw new Error("path 必须是长度为 1-1024 的非空字符串。");
  }
  if (value.lineNumbers !== undefined && typeof value.lineNumbers !== "boolean") {
    throw new Error("lineNumbers 必须是布尔值。");
  }
  const startLine =
    value.startLine === undefined
      ? undefined
      : parseIntegerOption(value.startLine, "startLine", 1, 1, 10_000_000);
  const endLine =
    value.endLine === undefined
      ? undefined
      : parseIntegerOption(value.endLine, "endLine", 1, 1, 10_000_000);
  const aroundLine =
    value.aroundLine === undefined
      ? undefined
      : parseIntegerOption(value.aroundLine, "aroundLine", 1, 1, 10_000_000);
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error(`起始行号 ${startLine} 大于结束行号 ${endLine}。`);
  }
  if (aroundLine !== undefined && (startLine !== undefined || endLine !== undefined)) {
    throw new Error("aroundLine 不能与 startLine/endLine 同时使用。");
  }
  return {
    path: value.path,
    startLine,
    endLine,
    limit: parseIntegerOption(value.limit, "limit", DEFAULT_LINE_LIMIT, 1, MAX_LINE_LIMIT),
    aroundLine,
    contextLines: parseIntegerOption(value.contextLines, "contextLines", 20, 0, MAX_CONTEXT_LINES),
    lineNumbers: value.lineNumbers !== false,
  };
}

function parseRequests(args: Record<string, unknown>): ReadRequest[] {
  if (args.paths !== undefined) {
    if (args.path !== undefined) throw new Error("path 与 paths 不能同时使用。");
    if (
      !Array.isArray(args.paths) ||
      args.paths.length < 1 ||
      args.paths.length > MAX_BATCH_FILES
    ) {
      throw new Error(`paths 必须包含 1-${MAX_BATCH_FILES} 个读取请求。`);
    }
    return args.paths.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error(`paths[${index}] 必须是对象。`);
      return parseReadRequest(item as Record<string, unknown>);
    });
  }
  return [parseReadRequest(args)];
}

function throwIfAborted(context?: ToolExecutionContext): void {
  if (!context?.abortSignal?.aborted) return;
  const error = new Error("文件读取已中止");
  error.name = "AbortError";
  throw error;
}

/** 图片文件按多模态内容返回，而不是当成二进制拒绝。 */
function renderImage(request: ReadRequest, buffer: Buffer, mimeType: string): ToolOutput {
  const header = `[图片读取结果 - ${request.path}]`;
  if (buffer.length > MAX_IMAGE_BYTES) {
    return {
      output: `${header}\n类型=${mimeType}；大小=${(buffer.length / 1024 / 1024).toFixed(1)}MB；hash=${contentHash(buffer)}\n(图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限，未随结果发送；请先压缩或用 bash 缩小尺寸)`,
    };
  }
  return {
    output: [
      header,
      `类型=${mimeType}；大小=${buffer.length}字节；hash=${contentHash(buffer)}`,
      "(图片内容已随本条结果一并发送，可直接查看，无需再次读取)",
    ].join("\n"),
    images: [{ mimeType, base64: buffer.toString("base64"), path: request.path }],
  };
}

async function renderFile(
  request: ReadRequest,
  outputBudget: number,
  context?: ToolExecutionContext,
): Promise<ToolOutput> {
  const resolvedPath = await resolveWorkspacePath(request.path);
  const buffer = await fs.readFile(resolvedPath, { signal: context?.abortSignal });
  throwIfAborted(context);
  // 读到的版本若不是版本链尾，说明期间有外部修改，write 不能再凭更早的 hash 放行。
  fileVersions.observe(context?.agentId, resolvedPath, contentHash(buffer));
  const imageMimeType = IMAGE_MIME_BY_EXTENSION[path.extname(resolvedPath).toLowerCase()];
  if (imageMimeType) {
    return renderImage(request, buffer, imageMimeType);
  }
  for (let index = 0; index < Math.min(buffer.length, 1_024); index += 1) {
    if (buffer[index] === 0) {
      return {
        output: `[文件读取结果 - ${request.path}]\n类型=二进制；大小=${buffer.length}字节；hash=${contentHash(buffer)}\n(未输出二进制内容)`,
      };
    }
  }

  const content = buffer.toString("utf8");
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  let firstLine: number;
  let requestedLastLine: number;
  if (request.aroundLine !== undefined) {
    firstLine = Math.max(1, request.aroundLine - request.contextLines);
    requestedLastLine = Math.min(totalLines, request.aroundLine + request.contextLines);
  } else {
    firstLine = request.startLine ?? 1;
    const rangeEnd = request.endLine ?? firstLine + request.limit - 1;
    requestedLastLine = Math.min(totalLines, rangeEnd, firstLine + request.limit - 1);
  }

  if (firstLine > totalLines) {
    return {
      output: `[文件读取结果 - ${request.path}]\n总行数=${totalLines}；hash=${contentHash(buffer)}\n(起始行 ${firstLine} 超过文件总行数)`,
    };
  }

  const records: string[] = [];
  const perLineLimit = Math.min(MAX_RENDERED_LINE_LENGTH, Math.max(80, outputBudget - 360));
  for (let lineNumber = firstLine; lineNumber <= requestedLastLine; lineNumber += 1) {
    const text = truncateSingleLine(lines[lineNumber - 1], perLineLimit);
    records.push(request.lineNumbers ? `${lineNumber} | ${text}` : text);
  }
  const bounded = takeWholeRecords(records, Math.max(200, outputBudget - 300));
  const returned = bounded.count;
  const actualLastLine = returned > 0 ? firstLine + returned - 1 : firstLine - 1;
  const hasMore = actualLastLine < totalLines;
  const header = [
    `[文件读取结果 - ${request.path}]`,
    `总行数=${totalLines}；返回=${returned > 0 ? `${firstLine}-${actualLastLine}` : "0"}；hash=${contentHash(buffer)}；hasMore=${hasMore}`,
    hasMore && returned > 0 ? `nextStartLine=${actualLastLine + 1}` : "",
    bounded.truncated ? "提示：为保持完整行，当前页已按输出预算提前结束。" : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    output: bounded.text ? `${header}\n${bounded.text}` : `${header}\n(当前页没有可输出内容)`,
  };
}

export class ReadFileTool implements BaseTool {
  public readonly name = "read";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "read",
      description:
        "按完整行读取一个或多个工作区文件。支持行分页、目标行上下文，并返回内容 hash 和 nextStartLine。读取图片文件（png/jpg/jpeg/gif/webp/bmp，≤6MB）时返回图片本身，可直接查看。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "单文件路径。" },
          paths: {
            type: "array",
            description: `批量读取请求，最多 ${MAX_BATCH_FILES} 个；不能与 path 同时使用。`,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
                limit: { type: "number" },
                aroundLine: { type: "number" },
                contextLines: { type: "number" },
                lineNumbers: { type: "boolean" },
              },
              required: ["path"],
            },
          },
          startLine: { type: "number", description: "起始行，从 1 开始。" },
          endLine: { type: "number", description: "结束行，包含在内。" },
          limit: {
            type: "number",
            description: `最多读取行数，默认 ${DEFAULT_LINE_LIMIT}，最大 ${MAX_LINE_LIMIT}。`,
          },
          aroundLine: {
            type: "number",
            description: "读取目标行及其上下文，不能与 startLine/endLine 同时使用。",
          },
          contextLines: {
            type: "number",
            description: `目标行前后上下文，默认 20，最大 ${MAX_CONTEXT_LINES}。`,
          },
          lineNumbers: { type: "boolean", description: "是否显示行号，默认 true。" },
        },
      },
    },
  };

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string | ToolOutput> {
    let requests: ReadRequest[];
    try {
      requests = parseRequests(args);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (context?.abortSignal?.aborted) return "[文件读取已中止]";

    const perFileBudget = Math.max(700, Math.floor((MAX_OUTPUT_LENGTH - 250) / requests.length));
    const blocks: string[] = [];
    const images: ToolImage[] = [];
    for (const request of requests) {
      try {
        throwIfAborted(context);
        const rendered = await renderFile(request, perFileBudget, context);
        blocks.push(rendered.output);
        if (rendered.images?.length) images.push(...rendered.images);
      } catch (error) {
        if (
          context?.abortSignal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return "[文件读取已中止]";
        }
        blocks.push(`读取文件失败 (${request.path}): ${formatWorkspaceError(error, request.path)}`);
      }
    }
    const withImages = <T extends string | ToolOutput>(result: T): string | ToolOutput =>
      images.length === 0
        ? result
        : { output: typeof result === "string" ? result : result.output, images };
    if (blocks.length === 1) return withImages(blocks[0]);
    const bounded = takeWholeRecords(blocks, MAX_OUTPUT_LENGTH - 180, "\n\n");
    const header = bounded.truncated
      ? `[批量文件读取结果 - 共 ${blocks.length} 个请求，本次返回 ${bounded.count} 个；其余请求请拆分重试]`
      : `[批量文件读取结果 - 共 ${blocks.length} 个请求]`;
    return withImages(`${header}\n${bounded.text}`);
  }
}
