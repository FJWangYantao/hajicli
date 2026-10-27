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
  DEFAULT_EXCLUDED_EXTENSIONS,
  FILE_TYPE_GLOBS,
  parseFileTypes,
  parseIntegerOption,
  parsePatternArray,
} from "./search-filter.js";
import { formatWorkspaceError, resolveWorkspacePath } from "./workspace-path.js";

type SearchMode = "literal" | "regex";

interface SearchOptions {
  query: string;
  relativePath: string;
  mode: SearchMode;
  include: string[];
  exclude: string[];
  fileTypes: string[];
  caseSensitive: boolean;
  beforeContext: number;
  afterContext: number;
  offset: number;
  limit: number;
}

interface SearchMatch {
  file: string;
  absolutePath: string;
  line: number;
  column: number;
  content: string;
}

interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  engine: "ripgrep" | "node";
}

const MAX_CONTEXT_LINES = 10;
const MAX_PAGE_SIZE = 50;
/** 一次调用最多合并几个查询（调用合并优先，减少往返）。 */
const MAX_BATCH_QUERIES = 5;
const MAX_OFFSET = 5_000;
const MAX_RAW_MATCHES = 20_000;
const MAX_OUTPUT_LENGTH = 8_000;
const MAX_RENDERED_LINE_LENGTH = 320;

function parseOptions(args: Record<string, unknown>): SearchOptions {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) throw new Error("缺少 query 参数。");
  if (query.length > 2_000) throw new Error("query 不能超过 2000 个字符。");

  const mode = args.mode === undefined ? "literal" : args.mode;
  if (mode !== "literal" && mode !== "regex") throw new Error("mode 只能是 literal 或 regex。");
  if (mode === "regex") {
    try {
      new RegExp(query);
    } catch (error) {
      throw new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const fileTypes = parseFileTypes(args.fileTypes);
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== "boolean") {
    throw new Error("caseSensitive 必须是布尔值。");
  }
  if (
    args.path !== undefined &&
    (typeof args.path !== "string" || !args.path.trim() || args.path.length > 1_024)
  ) {
    throw new Error("path 必须是长度为 1-1024 的非空字符串。");
  }

  return {
    query,
    relativePath: typeof args.path === "string" && args.path.trim() ? args.path : ".",
    mode,
    include: parsePatternArray(args.include, "include"),
    exclude: parsePatternArray(args.exclude, "exclude"),
    fileTypes,
    caseSensitive: args.caseSensitive === undefined ? true : args.caseSensitive,
    beforeContext: parseIntegerOption(args.beforeContext, "beforeContext", 0, 0, MAX_CONTEXT_LINES),
    afterContext: parseIntegerOption(args.afterContext, "afterContext", 0, 0, MAX_CONTEXT_LINES),
    offset: parseIntegerOption(args.offset, "offset", 0, 0, MAX_OFFSET),
    limit: parseIntegerOption(args.limit, "limit", 20, 1, MAX_PAGE_SIZE),
  };
}

function compareMatches(left: SearchMatch, right: SearchMatch): number {
  return (
    comparePathsBytewise(left.file, right.file) ||
    left.line - right.line ||
    left.column - right.column
  );
}

function throwIfAborted(context?: ToolExecutionContext): void {
  if (!context?.abortSignal?.aborted) return;
  const error = new Error("Grep 搜索已中止");
  error.name = "AbortError";
  throw error;
}

async function searchWithRipgrep(
  options: SearchOptions,
  startDir: string,
  rootDir: string,
  pathFilter: (pathname: string) => boolean,
  requiredMatches: number,
  context?: ToolExecutionContext,
): Promise<SearchResult | null> {
  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "--hidden",
    "--sort",
    "path",
  ];
  if (options.mode === "literal") args.push("--fixed-strings");
  if (!options.caseSensitive) args.push("--ignore-case");
  for (const directory of DEFAULT_EXCLUDED_DIRS) args.push("--glob", `!${directory}/**`);
  args.push("--regexp", options.query, ".");

  const result = await runRipgrepLines(args, startDir, MAX_RAW_MATCHES, context?.abortSignal);
  if (!result) return null;

  const matches: SearchMatch[] = [];
  let filteredEarly = false;
  for (const line of result.lines) {
    throwIfAborted(context);
    const parsed = line.match(/^(.*?):(\d+):(\d+):(.*)$/);
    if (!parsed) continue;
    const absolutePath = path.resolve(startDir, parsed[1]);
    const file = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
    if (!pathFilter(file)) continue;
    matches.push({
      file,
      absolutePath,
      line: Number(parsed[2]),
      column: Number(parsed[3]),
      content: parsed[4].trim(),
    });
    if (matches.length >= requiredMatches) {
      filteredEarly = true;
      break;
    }
  }
  matches.sort(compareMatches);
  return { matches, truncated: result.truncated || filteredEarly, engine: "ripgrep" };
}

async function searchWithNode(
  options: SearchOptions,
  startDir: string,
  rootDir: string,
  pathFilter: (pathname: string) => boolean,
  requiredMatches: number,
  context?: ToolExecutionContext,
): Promise<SearchResult> {
  const matches: SearchMatch[] = [];
  let truncated = false;
  const regex =
    options.mode === "regex"
      ? new RegExp(options.query, options.caseSensitive ? "" : "i")
      : undefined;
  const literalQuery = options.caseSensitive ? options.query : options.query.toLocaleLowerCase();

  const searchFile = async (absolutePath: string, file: string) => {
    try {
      throwIfAborted(context);
      const buffer = await fs.readFile(absolutePath, { signal: context?.abortSignal });
      for (let index = 0; index < Math.min(buffer.length, 1024); index += 1) {
        if (buffer[index] === 0) return;
      }
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        throwIfAborted(context);
        const line = lines[lineIndex];
        const columnIndex = regex
          ? (regex.exec(line)?.index ?? -1)
          : (options.caseSensitive ? line : line.toLocaleLowerCase()).indexOf(literalQuery);
        if (columnIndex < 0) continue;
        matches.push({
          file,
          absolutePath,
          line: lineIndex + 1,
          column: columnIndex + 1,
          content: line.trim(),
        });
        if (matches.length >= requiredMatches) {
          truncated = true;
          return;
        }
      }
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError"))
        throw error;
      // A single unreadable file must not abort the entire repository search.
    }
  };

  const walk = async (currentDir: string) => {
    throwIfAborted(context);
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => comparePathsBytewise(left.name, right.name));
    for (const entry of entries) {
      if (truncated) return;
      throwIfAborted(context);
      const absolutePath = path.join(currentDir, entry.name);
      const file = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.includes(entry.name)) await walk(absolutePath);
      } else if (entry.isFile()) {
        if (
          DEFAULT_EXCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ||
          !pathFilter(file)
        )
          continue;
        await searchFile(absolutePath, file);
      }
    }
  };

  await walk(startDir);
  matches.sort(compareMatches);
  return { matches, truncated, engine: "node" };
}

function truncateLine(line: string): string {
  if (line.length <= MAX_RENDERED_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_RENDERED_LINE_LENGTH)}…`;
}

async function renderMatch(
  match: SearchMatch,
  options: SearchOptions,
  fileCache: Map<string, string[]>,
  context?: ToolExecutionContext,
): Promise<string> {
  if (options.beforeContext === 0 && options.afterContext === 0) {
    return `${match.file}:${match.line}:${match.column}: ${truncateLine(match.content)}`;
  }

  let lines = fileCache.get(match.absolutePath);
  if (!lines) {
    try {
      throwIfAborted(context);
      lines = (
        await fs.readFile(match.absolutePath, { encoding: "utf8", signal: context?.abortSignal })
      ).split(/\r?\n/);
      fileCache.set(match.absolutePath, lines);
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError"))
        throw error;
      return `${match.file}:${match.line}:${match.column}: ${truncateLine(match.content)}`;
    }
  }

  const firstLine = Math.max(1, match.line - options.beforeContext);
  const lastLine = Math.min(lines.length, match.line + options.afterContext);
  const numberWidth = String(lastLine).length;
  const rendered = [`${match.file}:${match.line}:${match.column}`];
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    const marker = lineNumber === match.line ? ">" : " ";
    rendered.push(
      `${marker} ${String(lineNumber).padStart(numberWidth, " ")} | ${truncateLine(lines[lineNumber - 1])}`,
    );
  }
  return rendered.join("\n");
}

function formatConditions(options: SearchOptions): string {
  const summarize = (values: string[]) => {
    const joined = values.join(",");
    return joined.length > 180 ? `${joined.slice(0, 180)}…` : joined;
  };
  const conditions = [
    `模式=${options.mode}`,
    `路径=${options.relativePath.length > 180 ? `${options.relativePath.slice(0, 180)}…` : options.relativePath}`,
    options.fileTypes.length > 0 ? `类型=${summarize(options.fileTypes)}` : "",
    options.include.length > 0 ? `包含=${summarize(options.include)}` : "",
    options.exclude.length > 0 ? `排除=${summarize(options.exclude)}` : "",
  ].filter(Boolean);
  return conditions.join("；");
}

/** 解析批量查询参数；缺省返回 undefined 表示走单查询路径。 */
function parseQueries(args: Record<string, unknown>): { queries?: string[]; error?: string } {
  if (args.queries === undefined) return {};
  if (args.query !== undefined) return { error: "query 与 queries 不能同时使用。" };
  if (
    !Array.isArray(args.queries) ||
    args.queries.length < 1 ||
    args.queries.length > MAX_BATCH_QUERIES
  ) {
    return { error: `queries 必须包含 1-${MAX_BATCH_QUERIES} 个查询字符串。` };
  }
  const queries: string[] = [];
  for (const [index, item] of args.queries.entries()) {
    if (typeof item !== "string" || !item) {
      return { error: `queries[${index}] 必须是非空字符串。` };
    }
    queries.push(item);
  }
  return { queries };
}

/** Repository text search with regex, path filters, context and stateless pagination. */
export class GrepSearchTool implements BaseTool {
  public readonly name = "grep";

  private static readonly baseDefinition: ToolDefinition = {
    type: "function",
    function: {
      name: "grep",
      description:
        "在文本文件中搜索（默认工作区；工作区外需授权）。支持字面量或正则、glob、文件类型、上下文行，以及通过 offset/limit 分页。要搜索多个关键词/符号时优先用 queries 一次调用完成，不要拆成多次调用。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜索的文本或正则表达式。" },
          queries: {
            type: "array",
            items: { type: "string" },
            description: `批量查询，最多 ${MAX_BATCH_QUERIES} 个，一次调用即可搜索多个关键词/符号（每个查询独立分节返回）；不能与 query 同时使用。`,
          },
          path: { type: "string", description: "搜索起始目录，可选，默认当前工作区。" },
          mode: {
            type: "string",
            enum: ["literal", "regex"],
            description: "搜索模式，默认 literal。",
          },
          include: {
            type: "array",
            items: { type: "string" },
            description: '包含的 glob，例如 ["packages/**/*.ts"]。支持 *、** 和 ?。',
          },
          exclude: {
            type: "array",
            items: { type: "string" },
            description: '排除的 glob，例如 ["**/*.test.ts"]。',
          },
          fileTypes: {
            type: "array",
            items: { type: "string", enum: Object.keys(FILE_TYPE_GLOBS) },
            description: "文件类型过滤，可同时指定多个类型。",
          },
          caseSensitive: { type: "boolean", description: "是否区分大小写，默认 true。" },
          beforeContext: {
            type: "number",
            description: `匹配行之前的上下文行数，0-${MAX_CONTEXT_LINES}。`,
          },
          afterContext: {
            type: "number",
            description: `匹配行之后的上下文行数，0-${MAX_CONTEXT_LINES}。`,
          },
          offset: { type: "number", description: `结果偏移量，默认 0，最大 ${MAX_OFFSET}。` },
          limit: {
            type: "number",
            description: `本页最大结果数，默认 20，最大 ${MAX_PAGE_SIZE}。`,
          },
        },
      },
    },
  };

  public readonly definition: ToolDefinition;
  private readonly batchParams: boolean;

  public constructor(options: BatchParamOptions = {}) {
    this.batchParams = options.batchParams !== false;
    const base = GrepSearchTool.baseDefinition;
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
      delete (definition.function.parameters.properties as Record<string, unknown>).queries;
      definition.function.description = definition.function.description.replace(
        "要搜索多个关键词/符号时优先用 queries 一次调用完成，不要拆成多次调用。",
        "",
      );
    }
    this.definition = definition;
  }

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const batch = parseQueries(args);
    if (batch.error) return `错误: ${batch.error}`;
    if (!this.batchParams) {
      if (args.queries !== undefined) return "错误: 当前未启用 queries，请改用 query。";
      return this.runQuery(args, context);
    }
    if (!batch.queries) return this.runQuery(args, context);
    if (batch.queries.length === 1) {
      return this.runQuery({ ...args, queries: undefined, query: batch.queries[0] }, context);
    }

    const blocks: string[] = [];
    for (const query of batch.queries) {
      if (context?.abortSignal?.aborted) return "[Grep 搜索已中止]";
      const output = await this.runQuery({ ...args, queries: undefined, query }, context);
      blocks.push(`## query: ${query}\n${output}`);
    }
    const bounded = takeWholeRecords(blocks, MAX_OUTPUT_LENGTH - 220, "\n\n");
    const header = bounded.truncated
      ? `[批量 Grep 搜索结果 - 共 ${blocks.length} 个查询，本次返回 ${bounded.count} 个；其余查询请拆分重试]`
      : `[批量 Grep 搜索结果 - 共 ${blocks.length} 个查询]`;
    return `${header}\n${bounded.text}`;
  }

  private async runQuery(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    let options: SearchOptions;
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
      const requiredMatches = Math.min(
        MAX_OFFSET + MAX_PAGE_SIZE + 1,
        options.offset + options.limit + 1,
      );
      let result = await searchWithRipgrep(
        options,
        startDir,
        rootDir,
        pathFilter,
        requiredMatches,
        context,
      );
      if (!result) {
        result = await searchWithNode(
          options,
          startDir,
          rootDir,
          pathFilter,
          requiredMatches,
          context,
        );
      }

      const candidates = result.matches.slice(options.offset, options.offset + options.limit);
      const renderedMatches: string[] = [];
      const fileCache = new Map<string, string[]>();
      let bodyLength = 0;
      const bodyBudget = MAX_OUTPUT_LENGTH - 900;
      for (const match of candidates) {
        const rendered = await renderMatch(match, options, fileCache, context);
        const separatorLength = renderedMatches.length > 0 ? 2 : 0;
        if (
          renderedMatches.length > 0 &&
          bodyLength + separatorLength + rendered.length > bodyBudget
        )
          break;
        if (renderedMatches.length === 0 && rendered.length > bodyBudget) {
          renderedMatches.push(`${rendered.slice(0, bodyBudget - 24)}\n[单条结果已截断]`);
          bodyLength = bodyBudget;
          break;
        }
        renderedMatches.push(rendered);
        bodyLength += separatorLength + rendered.length;
      }

      const returned = renderedMatches.length;
      const hasMore = options.offset + returned < result.matches.length || result.truncated;
      const nextOffset = hasMore && returned > 0 ? options.offset + returned : undefined;
      const header = [
        `[Grep 搜索结果 - ${formatConditions(options)}]`,
        `引擎=${result.engine}；offset=${options.offset}；limit=${options.limit}；返回=${returned}；hasMore=${hasMore}`,
        nextOffset !== undefined ? `nextOffset=${nextOffset}` : "",
        result.truncated
          ? `提示：搜索达到扫描上限或已取得足够分页结果；需要更多结果时使用 nextOffset，结果过多时请收窄条件。`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      if (renderedMatches.length === 0) {
        if (hasMore) return `${header}\n当前 offset 没有可返回结果，请收窄搜索条件。`;
        return `${header}\n(未找到匹配结果)`;
      }
      return `${header}\n${renderedMatches.join("\n\n")}`;
    } catch (error) {
      if (
        context?.abortSignal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return "[Grep 搜索已中止]";
      }
      return `Grep 搜索失败: ${formatWorkspaceError(error, options.relativePath)}`;
    }
  }
}
