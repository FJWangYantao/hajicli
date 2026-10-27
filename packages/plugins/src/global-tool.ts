import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";
import { takeWholeRecords } from "./bounded-output.js";
import { runRipgrepLines } from "./ripgrep.js";
import {
  type BatchParamOptions,
  comparePathsBytewise,
  createPathFilter,
  DEFAULT_EXCLUDED_DIRS,
  FILE_TYPE_GLOBS,
  parseFileTypes,
  parseIntegerOption,
  parsePatternArray,
} from "./search-filter.js";
import { formatWorkspaceError, resolveWorkspacePath } from "./workspace-path.js";

type FindMode = "literal" | "regex";

interface FindOptions {
  relativePath: string;
  pattern?: string;
  mode: FindMode;
  include: string[];
  exclude: string[];
  fileTypes: string[];
  caseSensitive: boolean;
  offset: number;
  limit: number;
}

interface FindResult {
  files: string[];
  truncated: boolean;
  engine: "ripgrep" | "node";
}

const MAX_OFFSET = 5_000;
const MAX_PAGE_SIZE = 200;
/** 一次调用最多合并几个名称模式。 */
const MAX_BATCH_PATTERNS = 5;
const MAX_RAW_FILES = 30_000;
const MAX_OUTPUT_LENGTH = 8_000;

function parseOptions(args: Record<string, unknown>): FindOptions {
  if (
    args.path !== undefined &&
    (typeof args.path !== "string" || !args.path.trim() || args.path.length > 1_024)
  ) {
    throw new Error("path 必须是长度为 1-1024 的非空字符串。");
  }
  if (
    args.pattern !== undefined &&
    (typeof args.pattern !== "string" || !args.pattern || args.pattern.length > 2_000)
  ) {
    throw new Error("pattern 必须是长度为 1-2000 的字符串。");
  }
  const mode = args.mode === undefined ? "literal" : args.mode;
  if (mode !== "literal" && mode !== "regex") throw new Error("mode 只能是 literal 或 regex。");
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== "boolean") {
    throw new Error("caseSensitive 必须是布尔值。");
  }
  if (mode === "regex" && typeof args.pattern === "string") {
    try {
      new RegExp(args.pattern);
    } catch (error) {
      throw new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    relativePath: typeof args.path === "string" ? args.path : ".",
    pattern: typeof args.pattern === "string" ? args.pattern : undefined,
    mode,
    include: parsePatternArray(args.include, "include"),
    exclude: parsePatternArray(args.exclude, "exclude"),
    fileTypes: parseFileTypes(args.fileTypes),
    caseSensitive: args.caseSensitive === true,
    offset: parseIntegerOption(args.offset, "offset", 0, 0, MAX_OFFSET),
    limit: parseIntegerOption(args.limit, "limit", 100, 1, MAX_PAGE_SIZE),
  };
}

/** 解析批量模式参数；缺省返回 undefined 表示走单模式路径。 */
function parsePatterns(args: Record<string, unknown>): { patterns?: string[]; error?: string } {
  if (args.patterns === undefined) return {};
  if (args.pattern !== undefined) return { error: "pattern 与 patterns 不能同时使用。" };
  if (
    !Array.isArray(args.patterns) ||
    args.patterns.length < 1 ||
    args.patterns.length > MAX_BATCH_PATTERNS
  ) {
    return { error: `patterns 必须包含 1-${MAX_BATCH_PATTERNS} 个名称模式字符串。` };
  }
  const patterns: string[] = [];
  for (const [index, item] of args.patterns.entries()) {
    if (typeof item !== "string" || !item) {
      return { error: `patterns[${index}] 必须是非空字符串。` };
    }
    patterns.push(item);
  }
  return { patterns };
}

function createNameFilter(options: FindOptions): (pathname: string) => boolean {
  if (!options.pattern) return () => true;
  if (options.mode === "regex") {
    const expression = new RegExp(options.pattern, options.caseSensitive ? "" : "i");
    return (pathname) => expression.test(pathname);
  }
  const needle = options.caseSensitive ? options.pattern : options.pattern.toLocaleLowerCase();
  return (pathname) =>
    (options.caseSensitive ? pathname : pathname.toLocaleLowerCase()).includes(needle);
}

function throwIfAborted(context?: ToolExecutionContext): void {
  if (!context?.abortSignal?.aborted) return;
  const error = new Error("文件查找已中止");
  error.name = "AbortError";
  throw error;
}

async function findWithRipgrep(
  startDir: string,
  rootDir: string,
  acceptsPath: (pathname: string) => boolean,
  requiredFiles: number,
  context?: ToolExecutionContext,
): Promise<FindResult | null> {
  const args = ["--files", "--hidden", "--sort", "path"];
  for (const directory of DEFAULT_EXCLUDED_DIRS) args.push("--glob", `!${directory}/**`);
  const result = await runRipgrepLines(args, startDir, MAX_RAW_FILES, context?.abortSignal);
  if (!result) return null;

  const files: string[] = [];
  let filteredEarly = false;
  for (const resultPath of result.lines) {
    throwIfAborted(context);
    const absolutePath = path.resolve(startDir, resultPath);
    const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
    if (!acceptsPath(relativePath)) continue;
    files.push(relativePath);
    if (files.length >= requiredFiles) {
      filteredEarly = true;
      break;
    }
  }
  files.sort(comparePathsBytewise);
  return { files, truncated: result.truncated || filteredEarly, engine: "ripgrep" };
}

async function findWithNode(
  startDir: string,
  rootDir: string,
  acceptsPath: (pathname: string) => boolean,
  requiredFiles: number,
  context?: ToolExecutionContext,
): Promise<FindResult> {
  const files: string[] = [];
  let truncated = false;
  const walk = async (currentDir: string) => {
    throwIfAborted(context);
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => comparePathsBytewise(left.name, right.name));
    for (const entry of entries) {
      if (truncated) return;
      throwIfAborted(context);
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.includes(entry.name)) await walk(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
        if (!acceptsPath(relativePath)) continue;
        files.push(relativePath);
        if (files.length >= requiredFiles) truncated = true;
      }
    }
  };
  await walk(startDir);
  files.sort(comparePathsBytewise);
  return { files, truncated, engine: "node" };
}

function formatConditions(options: FindOptions): string {
  const conditions = [`路径=${options.relativePath}`, `模式=${options.mode}`];
  if (options.pattern)
    conditions.push(
      `名称=${options.pattern.length > 120 ? `${options.pattern.slice(0, 120)}…` : options.pattern}`,
    );
  if (options.fileTypes.length > 0) conditions.push(`类型=${options.fileTypes.join(",")}`);
  return conditions.join("；");
}

export class GlobalFindFilesTool implements BaseTool {
  public readonly name = "global";

  private static readonly baseDefinition: ToolDefinition = {
    type: "function",
    function: {
      name: "global",
      description:
        "查找文件（默认工作区；工作区外需授权）。支持名称字面量或正则、glob、文件类型，以及通过 offset/limit 分页。要按多个名称模式定位文件时优先用 patterns 一次调用完成。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "查找起始目录，可选，默认工作区。" },
          pattern: { type: "string", description: "文件路径名称过滤文本或正则，可选。" },
          patterns: {
            type: "array",
            items: { type: "string" },
            description: `批量名称模式，最多 ${MAX_BATCH_PATTERNS} 个，每个模式独立分节返回；不能与 pattern 同时使用。`,
          },
          mode: {
            type: "string",
            enum: ["literal", "regex"],
            description: "名称过滤模式，默认 literal。",
          },
          include: {
            type: "array",
            items: { type: "string" },
            description: "包含的 glob，支持 *、** 和 ?。",
          },
          exclude: { type: "array", items: { type: "string" }, description: "排除的 glob。" },
          fileTypes: {
            type: "array",
            items: { type: "string", enum: Object.keys(FILE_TYPE_GLOBS) },
            description: "文件类型过滤。",
          },
          caseSensitive: { type: "boolean", description: "名称过滤是否区分大小写，默认 false。" },
          offset: { type: "number", description: `结果偏移量，默认 0，最大 ${MAX_OFFSET}。` },
          limit: {
            type: "number",
            description: `本页最大文件数，默认 100，最大 ${MAX_PAGE_SIZE}。`,
          },
        },
      },
    },
  };

  public readonly definition: ToolDefinition;
  private readonly batchParams: boolean;

  public constructor(options: BatchParamOptions = {}) {
    this.batchParams = options.batchParams !== false;
    const base = GlobalFindFilesTool.baseDefinition;
    const definition: ToolDefinition = {
      ...base,
      function: {
        ...base.function,
        parameters: {
          ...base.function.parameters,
          properties: {
            ...(base.function.parameters.properties as Record<string, unknown>),
          },
        },
      },
    };
    if (!this.batchParams) {
      delete (definition.function.parameters.properties as Record<string, unknown>).patterns;
      definition.function.description = definition.function.description.replace(
        "要按多个名称模式定位文件时优先用 patterns 一次调用完成。",
        "",
      );
    }
    this.definition = definition;
  }

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const batch = parsePatterns(args);
    if (!this.batchParams && args.patterns !== undefined) {
      return "错误: 当前未启用 patterns，请改用 pattern。";
    }
    if (batch.error) return `错误: ${batch.error}`;
    if (!this.batchParams || !batch.patterns) return this.runFind(args, context);
    if (batch.patterns.length === 1) {
      return this.runFind({ ...args, patterns: undefined, pattern: batch.patterns[0] }, context);
    }

    const blocks: string[] = [];
    for (const pattern of batch.patterns) {
      if (context?.abortSignal?.aborted) return "[文件查找已中止]";
      const output = await this.runFind({ ...args, patterns: undefined, pattern }, context);
      blocks.push(`## pattern: ${pattern}\n${output}`);
    }
    const bounded = takeWholeRecords(blocks, MAX_OUTPUT_LENGTH - 220, "\n\n");
    const header = bounded.truncated
      ? `[批量文件查找结果 - 共 ${blocks.length} 个模式，本次返回 ${bounded.count} 个；其余模式请拆分重试]`
      : `[批量文件查找结果 - 共 ${blocks.length} 个模式]`;
    return `${header}\n${bounded.text}`;
  }

  private async runFind(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    let options: FindOptions;
    try {
      options = parseOptions(args);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }

    const rootDir = process.cwd();
    try {
      throwIfAborted(context);
      const startDir = await resolveWorkspacePath(options.relativePath, { cwd: rootDir });
      const pathFilter = createPathFilter(options);
      const nameFilter = createNameFilter(options);
      const acceptsPath = (pathname: string) => pathFilter(pathname) && nameFilter(pathname);
      const requiredFiles = Math.min(
        MAX_OFFSET + MAX_PAGE_SIZE + 1,
        options.offset + options.limit + 1,
      );
      let result = await findWithRipgrep(startDir, rootDir, acceptsPath, requiredFiles, context);
      if (!result)
        result = await findWithNode(startDir, rootDir, acceptsPath, requiredFiles, context);

      const candidates = result.files.slice(options.offset, options.offset + options.limit);
      const bounded = takeWholeRecords(candidates, MAX_OUTPUT_LENGTH - 850);
      const returned = bounded.count;
      const hasMore =
        options.offset + returned < result.files.length || result.truncated || bounded.truncated;
      const nextOffset = hasMore && returned > 0 ? options.offset + returned : undefined;
      const header = [
        `[全局文件查找结果 - ${formatConditions(options)}]`,
        `引擎=${result.engine}；offset=${options.offset}；limit=${options.limit}；返回=${returned}；hasMore=${hasMore}`,
        nextOffset !== undefined ? `nextOffset=${nextOffset}` : "",
        result.truncated ? "提示：已取得足够分页结果或达到扫描上限；结果过多时请收窄条件。" : "",
      ]
        .filter(Boolean)
        .join("\n");
      return bounded.text ? `${header}\n${bounded.text}` : `${header}\n(没有找到匹配文件)`;
    } catch (error) {
      if (
        context?.abortSignal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return "[文件查找已中止]";
      }
      return `文件检索失败: ${formatWorkspaceError(error, options.relativePath)}`;
    }
  }
}
