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
import { buildRemainingOutline, MAX_OUTLINE_CHARS } from "./read-outline.js";
import { ReadRangeTracker } from "./read-ranges.js";
import { findSimilarSymbols, findSymbolDefinition } from "./read-symbol.js";
import { parseIntegerOption } from "./search-filter.js";
import { formatWorkspaceError, resolveWorkspacePath } from "./workspace-path.js";

/** read 的输出预算档位（A/B: read_budget）。 */
export type ReadBudgetMode = "shared" | "per_file" | "batch_only";

interface ReadRequest {
  path: string;
  startLine?: number;
  endLine?: number;
  limit: number;
  aroundLine?: number;
  /** 按符号名读取定义块；与行范围参数互斥。 */
  symbol?: string;
  contextLines: number;
  lineNumbers: boolean;
}

const DEFAULT_LINE_LIMIT = 200;
/** per_file 档的默认行数上限：单文件 16k 字符通常能装下 400 行短行，行数上限不跟着放就白给了额度。 */
const PER_FILE_LINE_LIMIT = 400;
const MAX_LINE_LIMIT = 1_000;
const MAX_CONTEXT_LINES = 100;
const MAX_BATCH_FILES = 10;
/** 现状：单次调用总量 8k，按文件数平分（读得越多每个文件拿到的越少）。 */
const SHARED_OUTPUT_BUDGET = 8_000;
/** per_file 档：单文件额度与单次调用总量，不再按文件数平分到 8k。 */
const PER_FILE_OUTPUT_BUDGET = 16_000;
const TOTAL_OUTPUT_BUDGET = 32_000;
/** batch_only 档：只修「批量读多个文件时按文件数平分」，单文件读维持 shared 行为。 */
const BATCH_ONLY_PER_FILE_BUDGET = 8_000;
const BATCH_ONLY_TOTAL_BUDGET = 32_000;
/**
 * 单文件头部的固定余量：`[文件读取结果 - 路径]` 之外的统计行、nextStartLine、
 * 截断提示与叠读提示。路径长度另外按实计算（见 renderFile），否则深层路径会把
 * 单块撑过 perFileBudget，合并时整块被丢弃。
 */
const READ_HEADER_RESERVE = 300;
/** 单个文件至少保留的正文额度，避免超长路径把正文挤成 0。 */
const MIN_FILE_CONTENT_BUDGET = 200;
/** 批量结果合并时给外层头部与 `\n\n` 分隔符预留的字符数。 */
const MERGE_HEADER_RESERVE = 180;
/** 合并超限时，剩余空间小于该值就不再追加「截断的下一块」，直接提示拆分重试。 */
const MIN_PARTIAL_BLOCK_ROOM = 200;
const MAX_RENDERED_LINE_LENGTH = 1_000;
/** 剩余符号提纲的最小额度；低于这个值就不值得占头部空间。 */
const MIN_OUTLINE_CHARS = 80;

/**
 * 提纲能用的字符数：受单文件预算、头部余量和正文下限共同约束。
 * 预算越小（批量读多个文件）提纲越短，避免把正文挤没。
 */
function resolveOutlineBudget(outputBudget: number, pathLength: number): number {
  const room = outputBudget - READ_HEADER_RESERVE - pathLength - MIN_FILE_CONTENT_BUDGET;
  if (room < MIN_OUTLINE_CHARS) return 0;
  const proportional = Math.max(MIN_OUTLINE_CHARS, Math.floor(outputBudget * 0.15));
  return Math.min(MAX_OUTLINE_CHARS, room, proportional);
}
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

/** 关掉 symbol 能力时把参数从 schema 里摘掉（A/B: read_symbol 的 baseline 组）。 */
function withoutSymbolParameter(definition: ToolDefinition): ToolDefinition {
  const parameters = definition.function.parameters as {
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const { symbol: _removed, ...rest } = parameters.properties ?? {};
  return {
    ...definition,
    function: {
      ...definition.function,
      parameters: { ...parameters, properties: rest },
    },
  };
}

function parseReadRequest(value: Record<string, unknown>, defaultLimit: number): ReadRequest {
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
  const symbol =
    typeof value.symbol === "string" && value.symbol.trim()
      ? value.symbol.trim().slice(0, 200)
      : undefined;
  if (value.symbol !== undefined && !symbol) {
    throw new Error("symbol 必须是非空字符串。");
  }
  if (symbol && (startLine !== undefined || endLine !== undefined || aroundLine !== undefined)) {
    throw new Error("symbol 不能与 startLine/endLine/aroundLine 同时使用。");
  }
  return {
    path: value.path,
    startLine,
    endLine,
    limit: parseIntegerOption(value.limit, "limit", defaultLimit, 1, MAX_LINE_LIMIT),
    aroundLine,
    symbol,
    contextLines: parseIntegerOption(value.contextLines, "contextLines", 20, 0, MAX_CONTEXT_LINES),
    lineNumbers: value.lineNumbers !== false,
  };
}

function parseRequests(args: Record<string, unknown>, defaultLimit: number): ReadRequest[] {
  if (args.paths !== undefined) {
    if (args.path !== undefined) throw new Error("path 与 paths 不能同时使用。");
    if (args.symbol !== undefined) throw new Error("symbol 只能用于单文件读取（path）。");
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
      return parseReadRequest(item as Record<string, unknown>, defaultLimit);
    });
  }
  return [parseReadRequest(args, defaultLimit)];
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
      "（终端支持时此图会内联显示在工具结果下方；否则可用 /view <路径> 整屏查看）",
    ].join("\n"),
    images: [{ mimeType, base64: buffer.toString("base64"), path: request.path }],
  };
}

async function renderFile(
  request: ReadRequest,
  outputBudget: number,
  context?: ToolExecutionContext,
  tracker?: ReadRangeTracker,
  outlineEnabled = false,
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
  let symbolInfo: string | undefined;
  let symbolEndLine: number | undefined;
  if (request.symbol) {
    const definition = findSymbolDefinition(lines, request.symbol, request.path);
    if (!definition) {
      const similar = findSimilarSymbols(lines, request.symbol, request.path);
      return {
        output: [
          `[符号读取结果 - ${request.path}]`,
          `未找到符号 ${request.symbol} 的定义；总行数=${totalLines}；hash=${contentHash(buffer)}`,
          similar.length > 0
            ? `相近符号：${similar.map((entry) => `${entry.line} ${entry.label}`).join(" · ")}`
            : "该文件里没有名字相近的符号，可用 grep 在其他文件里定位。",
        ].join("\n"),
      };
    }
    firstLine = definition.startLine;
    requestedLastLine = Math.min(totalLines, definition.endLine, firstLine + request.limit - 1);
    symbolInfo = `符号=${request.symbol}；定义=${definition.startLine}-${definition.endLine}`;
    symbolEndLine = definition.endLine;
  } else if (request.aroundLine !== undefined) {
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

  const rangeKey = `${context?.agentId ?? "main"}:${resolvedPath}`;
  const overlapHint = tracker?.check(rangeKey, firstLine, requestedLastLine);

  const records: string[] = [];
  // 头部不受额度限制，但合并时要和正文一起占总量：先把「路径长度 + 固定余量」扣掉，
  // 保证单块输出不超过 outputBudget，n 个文件才装得进总量。
  const contentBudget = Math.max(
    MIN_FILE_CONTENT_BUDGET,
    outputBudget - READ_HEADER_RESERVE - request.path.length,
  );
  const perLineLimit = Math.min(MAX_RENDERED_LINE_LENGTH, Math.max(80, contentBudget - 60));
  for (let lineNumber = firstLine; lineNumber <= requestedLastLine; lineNumber += 1) {
    const text = truncateSingleLine(lines[lineNumber - 1], perLineLimit);
    records.push(request.lineNumbers ? `${lineNumber} | ${text}` : text);
  }
  const bounded = takeWholeRecords(records, contentBudget);
  const returned = bounded.count;
  const actualLastLine = returned > 0 ? firstLine + returned - 1 : firstLine - 1;
  const hasMore = actualLastLine < totalLines;
  // 符号读取只在「定义块本身还没读完」时给 nextStartLine，避免把文件后面的内容误标成续读。
  const hasMoreOfRequestedRange =
    symbolEndLine !== undefined ? actualLastLine < symbolEndLine : hasMore;

  // 剩余符号提纲（A/B: read_outline）：只在单文件读、且「本页之后还有内容」时给。
  // 批量读不走提纲：单块额度本来就小，提纲会挤占正文，合并时还容易把块撑过上限。
  // aroundLine 是模型明确指定的窗口、symbol 是明确的定义块，都不再附加剩余提纲。
  const outlineBudget =
    outlineEnabled && request.aroundLine === undefined && request.symbol === undefined
      ? resolveOutlineBudget(outputBudget, request.path.length)
      : 0;
  const outline =
    outlineBudget > 0 && hasMore && returned > 0
      ? buildRemainingOutline(lines, actualLastLine + 1, request.path, outlineBudget)
      : undefined;
  const header = [
    `[文件读取结果 - ${request.path}]`,
    symbolInfo ?? "",
    `总行数=${totalLines}；返回=${returned > 0 ? `${firstLine}-${actualLastLine}` : "0"}；hash=${contentHash(buffer)}；hasMore=${hasMore}`,
    hasMoreOfRequestedRange && returned > 0 ? `nextStartLine=${actualLastLine + 1}` : "",
    outline ?? "",
    bounded.truncated ? "提示：为保持完整行，当前页已按输出预算提前结束。" : "",
    overlapHint ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  if (returned > 0) tracker?.record(rangeKey, firstLine, actualLastLine);
  return {
    output: bounded.text ? `${header}\n${bounded.text}` : `${header}\n(当前页没有可输出内容)`,
  };
}

export class ReadFileTool implements BaseTool {
  public readonly name = "read";

  /** 叠读提示（A/B: scope_discipline）；关闭时不记账也不提示。 */
  private readonly tracker?: ReadRangeTracker;

  /** 输出预算档位（A/B: read_budget）。 */
  private readonly budgetMode: ReadBudgetMode;

  /** 未显式传 limit 时的默认行数上限。 */
  private readonly defaultLineLimit: number;

  /** 截断时是否附「剩余符号提纲」（A/B: read_outline）。 */
  private readonly outlineEnabled: boolean;

  /** 是否暴露 `symbol` 参数（A/B: read_symbol）。 */
  private readonly symbolEnabled: boolean;

  public constructor(
    options: {
      overlapHint?: boolean;
      readBudget?: ReadBudgetMode;
      outline?: boolean;
      symbol?: boolean;
    } = {},
  ) {
    if (options.overlapHint !== false) this.tracker = new ReadRangeTracker();
    this.outlineEnabled = options.outline === true;
    this.symbolEnabled = options.symbol !== false;
    this.budgetMode = options.readBudget ?? "shared";
    this.defaultLineLimit =
      this.budgetMode === "per_file" ? PER_FILE_LINE_LIMIT : DEFAULT_LINE_LIMIT;
    if (!this.symbolEnabled) this.definition = withoutSymbolParameter(this.definition);
    if (this.budgetMode === "per_file") {
      const properties = this.definition.function.parameters.properties as Record<
        string,
        { description?: string }
      >;
      if (properties.limit) {
        properties.limit.description = `最多读取行数，默认 ${PER_FILE_LINE_LIMIT}，最大 ${MAX_LINE_LIMIT}。`;
      }
    }
  }

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "read",
      description:
        "按完整行读取一个或多个文件（默认工作区；工作区外需授权）。支持行分页、目标行上下文，并返回内容 hash 和 nextStartLine。读取图片文件（png/jpg/jpeg/gif/webp/bmp，≤6MB）时返回图片本身，可直接查看。",
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
          symbol: {
            type: "string",
            description:
              "按符号名读取整个定义块（函数/类/接口/类型/方法），自动定位起止行；与 startLine/endLine/aroundLine 互斥。已知符号名时用它，比先 grep 再翻页省一次请求。",
          },
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
    if (!this.symbolEnabled && args.symbol !== undefined) {
      return "错误: 当前未启用 symbol 参数，请改用 startLine/endLine 或 aroundLine。";
    }
    let requests: ReadRequest[];
    try {
      requests = parseRequests(args, this.defaultLineLimit);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (context?.abortSignal?.aborted) return "[文件读取已中止]";

    // batch_only 只对「一次读多个文件」生效，单文件读保持 shared 的行为。
    const batchOnly = this.budgetMode === "batch_only" && requests.length > 1;
    const totalBudget =
      this.budgetMode === "per_file"
        ? TOTAL_OUTPUT_BUDGET
        : batchOnly
          ? BATCH_ONLY_TOTAL_BUDGET
          : SHARED_OUTPUT_BUDGET;
    // 合并上限要给外层头部与 n-1 个 "\n\n" 分隔符留位置，再平均到每个文件：
    // 否则 n × 单文件额度恰好等于总量时，路径稍长就会把最后一个文件整块挤掉。
    const mergeLimit = totalBudget - MERGE_HEADER_RESERVE;
    const availableForFiles = mergeLimit - 2 * (requests.length - 1);
    // shared：总量按文件数平分（现状）；其余两档每个文件有独立额度，只受总量封顶。
    const perFileBudget =
      this.budgetMode === "per_file"
        ? Math.min(PER_FILE_OUTPUT_BUDGET, Math.floor(availableForFiles / requests.length))
        : batchOnly
          ? Math.min(BATCH_ONLY_PER_FILE_BUDGET, Math.floor(availableForFiles / requests.length))
          : Math.max(700, Math.floor((SHARED_OUTPUT_BUDGET - 250) / requests.length));
    const blocks: string[] = [];
    const images: ToolImage[] = [];
    for (const request of requests) {
      try {
        throwIfAborted(context);
        const rendered = await renderFile(
          request,
          perFileBudget,
          context,
          this.tracker,
          this.outlineEnabled && requests.length === 1,
        );
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
    const bounded = takeWholeRecords(blocks, mergeLimit, "\n\n");
    let text = bounded.text;
    let count = bounded.count;
    // 兜底：额度被 200 下限顶住时（超长路径 + 多文件），整块丢弃会让那个文件一行都拿不到，
    // 模型只能再发一次请求。这里改为保留下一块的头（含 nextStartLine）+ 能放下的完整行。
    let partial = false;
    if (bounded.truncated) {
      const room = mergeLimit - text.length - (text ? 2 : 0);
      const piece = truncateBlockToRoom(blocks[bounded.count], room);
      if (piece) {
        text = text ? `${text}\n\n${piece}` : piece;
        count += 1;
        partial = true;
      }
    }
    const remaining = blocks.length - count;
    const header = bounded.truncated
      ? `[批量文件读取结果 - 共 ${blocks.length} 个请求，本次返回 ${count} 个${partial ? `（第 ${count} 个已截断，可用其 nextStartLine 续读）` : ""}；其余 ${remaining} 个请求请拆分重试]`
      : `[批量文件读取结果 - 共 ${blocks.length} 个请求]`;
    return withImages(`${header}\n${text}`);
  }
}

/** 把单块按行截到 room 字符内（保留开头头部行），放不下时返回空串。 */
function truncateBlockToRoom(block: string, room: number): string {
  if (room < MIN_PARTIAL_BLOCK_ROOM) return "";
  const marker = "\n…（本文件按总量预算截断，可用上方 nextStartLine 续读）";
  const budget = room - marker.length;
  if (budget <= 0) return "";
  const kept: string[] = [];
  let length = 0;
  for (const line of block.split("\n")) {
    const next = length + (kept.length > 0 ? 1 : 0) + line.length;
    if (next > budget) break;
    kept.push(line);
    length = next;
  }
  if (kept.length === 0) return "";
  return `${kept.join("\n")}${marker}`;
}
