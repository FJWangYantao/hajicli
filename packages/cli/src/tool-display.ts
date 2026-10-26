/**
 * 工具展示的统一入口：把「工具名 + 入参 + 执行结果」收敛成一份结构化 `ToolDisplay`。
 *
 * 分工与 process-fold.ts 相同：本模块只做纯函数转换，不持有界面状态。
 * 实时工具块（ToolRunView）、回合正文、子代理回调与 /resume 回放都从这里取
 * `title`，因此同一份历史在不同入口渲染出的摘要一致。
 *
 * 三条约定（对应 design/opencode-tool-result-display.md 第 10 节规则 1/2/12）：
 * - 默认一行：标题永远是单行文本，宽度由渲染层裁剪；
 * - 计数来自结构化结果：`detail` 只取 `summarizeToolResult` 的结论，不去解析输出正文；
 * - 未知工具必须有兜底：`name [k=v, k=v]`，参数只取标量。
 */
import {
  formatToolCell,
  summarizeToolCall,
  type ToolCellStatus,
  type ToolResultSummary,
} from "./cli-runtime.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { fitText, terminalWidth } from "./terminal-text.js";

/** 展示状态：运行中 / 成功 / 失败 / 被拒（权限或策略拦截）。 */
export type ToolDisplayStatus = "running" | "ok" | "error" | "denied";

/** inline 只占一行；block 表示结果有“内容体积”（命令输出、diff、全文）。 */
export type ToolDisplayKind = "inline" | "block";

export interface ToolDisplay {
  kind: ToolDisplayKind;
  /** 归一化后的工具名（保留原始大小写之外的写法，仅用于展示）。 */
  toolName: string;
  /** 单行主语：`make all`、`src/a.ts:1-20`、`"TODO" · packages`、`custom [path=a.ts]`。 */
  title: string;
  /** 结果说明（`3 条结果`、`退出码 2 · 5 行输出`），运行中没有。 */
  detail?: string;
  status: ToolDisplayStatus;
  /** 展开后是否有额外内容可看（预览行或完整输出）。 */
  expandable: boolean;
}

/** 结果本身就是“内容体积”的工具，完成后按块渲染。 */
const BLOCK_TOOLS: ReadonlySet<string> = new Set(["bash", "write", "edit", "apply_patch"]);

/** `summarizeToolCall` 里有专属主语规则的工具；其余走通用兜底。 */
const TITLED_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "global",
  "webfetch",
  "websearch",
  "loadskill",
  "listskillresources",
  "readskillresource",
  "subagent",
  "verifyagent",
  "taskcreate",
  "updatetask",
  "taskfinish",
]);

/**
 * 通用参数摘要：只取 `string | number | boolean`，拼成 `k=v, k=v`。
 * 对象/数组/undefined 一律跳过——它们既读不懂又占宽度。
 */
export function formatGenericToolArgs(args: Record<string, unknown>, maxLength = 80): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim();
      parts.push(`${key}=${text}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    }
  }
  const joined = parts.join(", ");
  if (!joined) return "";
  // 按字符截断只是为了不把一行撑爆，真正的宽度裁剪在渲染层。
  return joined.length > maxLength ? `${joined.slice(0, Math.max(0, maxLength - 1))}…` : joined;
}

/** 结果 → 展示状态；没有结果就是还在运行。 */
export function toolDisplayStatus(result?: Pick<ToolResultSummary, "status">): ToolDisplayStatus {
  if (!result) return "running";
  if (result.status === "success") return "ok";
  if (result.status === "rejected") return "denied";
  return "error";
}

/** 展示状态 → 工具块符号所需的状态（judging 只在授权判定阶段单独设置）。 */
export function toolCellStatus(display: ToolDisplay): ToolCellStatus {
  switch (display.status) {
    case "ok":
      return "success";
    case "error":
      return "failed";
    case "denied":
      return "rejected";
    default:
      return "running";
  }
}

export interface BuildToolDisplayOptions {
  toolName: string;
  args?: Record<string, unknown>;
  /** 执行结果摘要；工具还在运行时省略。 */
  result?: ToolResultSummary;
  /** 完整输出，仅用于判断“有没有东西可展开”。 */
  output?: string;
}

/**
 * 构造展示信息。未知工具（MCP、插件自定义、未来新增工具）拿不到专属规则时，
 * 退回 `name [k=v]` —— 先保证任何工具都有一行能读懂的摘要。
 */
export function buildToolDisplay(options: BuildToolDisplayOptions): ToolDisplay {
  const { toolName, result, output } = options;
  const args = options.args ?? {};
  const generic = formatGenericToolArgs(args);
  const titled = TITLED_TOOLS.has(toolName) ? summarizeToolCall(toolName, args) : "";
  const title = titled || [toolName, generic ? `[${generic}]` : ""].filter(Boolean).join(" ");
  return {
    kind: BLOCK_TOOLS.has(toolName) ? "block" : "inline",
    toolName,
    title: title || toolName,
    detail: result?.text,
    status: toolDisplayStatus(result),
    expandable: Boolean(result?.preview?.length) || Boolean(output?.trim()),
  };
}

/** 参数分片里值得先展示的键：挑能让人一眼看出「在做什么」的那几个。 */
const DRAFT_ARG_KEYS: readonly string[] = [
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "glob",
  "prompt",
  "name",
];

/**
 * 从尚未闭合的参数文本里捞「值的前缀」。
 * JSON.parse 在半截 JSON 上必然失败，这里按常见键做一次宽松匹配，
 * 于是 `{"path": "packages/cli/src/ind` 也能显示成 `read packages/cli/src/ind`。
 */
function salvageDraftArgs(argumentsText: string): Record<string, unknown> {
  const salvaged: Record<string, unknown> = {};
  for (const key of DRAFT_ARG_KEYS) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"?`);
    const match = pattern.exec(argumentsText);
    if (!match) continue;
    const value = match[1].replace(/\\n/g, " ").replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim();
    if (value) salvaged[key] = value;
  }
  return salvaged;
}

export interface ToolCallDraft {
  /** 工具名；参数分片先到时可能还没有。 */
  name?: string;
  /** 该调用目前累积到的参数文本（可能不是合法 JSON）。 */
  argumentsText: string;
}

/**
 * 工具调用生成中的一行草稿：`read src/a.ts · 24 字`。
 * 参数还在生成时用宽松匹配读出前缀，随分片变长而变长，因此这一行本身就是进度。
 */
export function formatToolCallDraft(draft: ToolCallDraft, maxLength = 96): string {
  const toolName = draft.name?.trim() || "工具调用";
  let title = "";
  try {
    const parsed = JSON.parse(draft.argumentsText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      title = buildToolDisplay({ toolName, args: parsed as Record<string, unknown> }).title;
    }
  } catch {
    title = buildToolDisplay({ toolName, args: salvageDraftArgs(draft.argumentsText) }).title;
  }
  const chars = draft.argumentsText.length;
  const text = `${title || toolName}${chars > 0 ? ` · ${chars} 字` : ""}`;
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

/** 按终端显示宽度切一段纯文本，返回 [首段, 余下]。 */
function takeByWidth(text: string, width: number): [string, string] {
  if (width <= 0) return ["", text];
  if (terminalWidth(text) <= width) return [text, ""];
  let take = Math.min(text.length, width);
  while (take > 1 && terminalWidth(text.slice(0, take)) > width) take -= 1;
  return [text.slice(0, take), text.slice(take)];
}

/**
 * 生成中的参数正文：去掉 JSON 外壳，只留「正在写进去的值」。
 * `{"command": "git sta` → `git sta`，`{"path": "packages/cli` → `packages/cli`；
 * 认不出结构时退回原文，宁可露出原始分片也不丢信息。
 */
function draftBodyText(draft: ToolCallDraft): string {
  const raw = draft.argumentsText;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>)
        .filter((value) => typeof value === "string" || typeof value === "number")
        .map((value) => String(value));
      if (values.length > 0) return values.join(" ");
    }
  } catch {
    const salvaged = Object.values(salvageDraftArgs(raw)).map((value) => String(value));
    if (salvaged.length > 0) return salvaged.join(" ");
  }
  return raw;
}

/** 参数正文折成若干行（压缩连续空白），超出部分用 `…` 收尾。 */
function wrapArgumentLines(text: string, width: number, maxLines: number): string[] {
  const body = sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
  if (!body || maxLines <= 0) return [];
  const lines: string[] = [];
  let rest = body;
  while (rest && lines.length < maxLines) {
    const [head, tail] = takeByWidth(rest, width);
    lines.push(head);
    rest = tail;
  }
  if (rest && lines.length > 0) {
    lines[lines.length - 1] = fitText(`${lines[lines.length - 1]} …`, width);
  }
  return lines;
}

/**
 * 参数还在生成中的工具块：`● bash  git status · 128 字` + 参数原文若干行。
 *
 * 它写在对话区底部的实时区域，随分片增长；工具真正开始执行时，
 * ToolRunView 的实时块在原地接管同一个位置，于是「拼装指令 → 执行」是连续的，
 * 而不是等参数全部到齐才一次性出现整块。
 */
export function formatToolCallDraftCell(draft: ToolCallDraft, width = 100, maxLines = 4): string[] {
  const toolName = draft.name?.trim() || "工具调用";
  const chars = draft.argumentsText.length;
  return formatToolCell({
    status: "running",
    toolName,
    // 标题只报进度（`12 字`），具体指令由下面几行原文体现——否则两处重复同一段文字。
    summary: chars > 0 ? `${chars} 字` : "",
    width,
    outputTail: wrapArgumentLines(draftBodyText(draft), Math.max(12, width - 10), maxLines),
  });
}
