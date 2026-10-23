import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { terminalWidth, truncateText } from "./terminal-text.js";
import { colors } from "./theme.js";

const DEFAULT_PREFERENCES_PATH = path.join(process.cwd(), ".haji", "preferences.json");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Preferences {
  model: string;
  reasoningEffort: string;
  /** 上次使用的 provider 名称（内置 deepseek/volcengine 或自定义名称）。 */
  provider?: string;
  permissionMode?: string;
  riskThreshold?: string;
}

export function loadPreference(preferencePath = DEFAULT_PREFERENCES_PATH): Preferences | null {
  try {
    return JSON.parse(fs.readFileSync(preferencePath, "utf8")) as Preferences;
  } catch {
    return null;
  }
}

export function savePreference(
  preference: Preferences,
  onWarning?: (message: string) => void,
  preferencePath = DEFAULT_PREFERENCES_PATH,
): boolean {
  try {
    fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
    fs.writeFileSync(preferencePath, JSON.stringify(preference, null, 2), "utf8");
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onWarning?.(`用户偏好保存失败：${detail}`);
    return false;
  }
}

export function formatToolArgs(args: Record<string, unknown>, maxLength = 45): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const formatted = keys
    .map((key) => {
      const value = typeof args[key] === "string" ? args[key] : JSON.stringify(args[key]);
      return `${key}: "${String(value).replace(/\r?\n/g, " ")}"`;
    })
    .join(", ");
  return formatted.length > maxLength ? `${formatted.slice(0, maxLength - 3)}...` : formatted;
}

/** 按终端显示宽度截断，超出时以省略号收尾。 */
export function fitText(value: string, width: number): string {
  if (width <= 0) return "";
  if (terminalWidth(value) <= width) return value;
  return `${truncateText(value, Math.max(0, width - 1))}…`;
}

/** 把任意参数值压成一行可安全显示的纯文本。 */
function oneLine(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function textArg(args: Record<string, unknown>, key: string): string {
  return oneLine(args[key]);
}

function joinParts(...parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

/**
 * 工具调用的一行主语：bash 显示命令本身，文件类工具显示路径，搜索类显示
 * 关键词与范围，其余工具回退到通用参数摘要。不截断，由调用方按宽度裁剪。
 */
export function summarizeToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const command = typeof args.command === "string" ? sanitizeTerminalText(args.command) : "";
      const lines = command.split(/\r?\n/).filter((line) => line.trim());
      if (lines.length <= 1) return oneLine(command);
      return `${oneLine(lines[0])} …(+${lines.length - 1} 行)`;
    }
    case "read": {
      const paths = Array.isArray(args.paths) ? args.paths.map(oneLine).filter(Boolean) : [];
      const target = textArg(args, "path") || paths.join(", ");
      const start = textArg(args, "startLine");
      const end = textArg(args, "endLine");
      const around = textArg(args, "aroundLine");
      const range = start ? `:${start}${end ? `-${end}` : ""}` : around ? `:~${around}` : "";
      return target ? `${target}${range}` : formatToolArgs(args, 160);
    }
    case "write":
    case "edit":
      return textArg(args, "path") || formatToolArgs(args, 160);
    case "grep": {
      const query = textArg(args, "query");
      return query ? joinParts(`"${query}"`, textArg(args, "path")) : formatToolArgs(args, 160);
    }
    case "global": {
      const pattern = textArg(args, "pattern");
      return pattern ? joinParts(pattern, textArg(args, "path")) : formatToolArgs(args, 160);
    }
    case "webfetch":
      return textArg(args, "url") || formatToolArgs(args, 160);
    case "websearch": {
      const query = textArg(args, "query");
      return query ? `"${query}"` : formatToolArgs(args, 160);
    }
    case "loadskill":
    case "listskillresources":
      return textArg(args, "name");
    case "readskillresource":
      return [textArg(args, "name"), textArg(args, "path")].filter(Boolean).join("/");
    case "subagent":
      return joinParts(textArg(args, "role"), textArg(args, "description"));
    case "verifyagent":
      return joinParts(textArg(args, "agentId"), textArg(args, "verdict"));
    case "taskcreate":
      return textArg(args, "title") || textArg(args, "content");
    case "updatetask":
      return joinParts(textArg(args, "taskId"), textArg(args, "status"));
    case "taskfinish":
      return textArg(args, "taskId");
    default:
      return formatToolArgs(args, 160);
  }
}

export type ToolCellStatus = "running" | "success" | "failed" | "rejected";

export interface ToolResultSummary {
  status: Exclude<ToolCellStatus, "running">;
  text: string;
}

const VERIFICATION_EVIDENCE_RE = /\n\[verification_evidence_id: [^\]]*\]\s*$/;
const BASH_HEADER_RE = /^\[命令执行结果 - 退出码 ([^；\]]+)；耗时 \d+ms\]/;
/** 一些工具不以“错误:”开头报告失败（如“编辑失败: …”），仅用于展示层判定。 */
const DISPLAY_FAILURE_RE = /^[^\n[]{0,16}失败[:：]/;

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ""
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function summarizeBashOutput(output: string): ToolResultSummary | undefined {
  const header = output.match(BASH_HEADER_RE);
  if (!header) return undefined;
  const exitCode = header[1].trim();
  const bodyLines = output
    .slice(header[0].length)
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() &&
        !line.startsWith("--- 标准输出") &&
        !line.startsWith("--- 标准错误") &&
        line !== "(命令执行完成，无控制台输出)",
    );
  const lastLine = oneLine(bodyLines.at(-1) || "");
  const failed = exitCode !== "0";
  const outputText = bodyLines.length
    ? `${bodyLines.length} 行输出${lastLine ? ` · ${lastLine}` : ""}`
    : "无输出";
  return {
    status: failed ? "failed" : "success",
    text: failed ? `退出码 ${exitCode} · ${outputText}` : outputText,
  };
}

/**
 * 把工具输出压缩成一行结果说明，并给出展示用的成败判定：
 * bash 非零退出码与“xx失败:”类输出在界面上同样标记为失败。
 */
export function summarizeToolResult(
  toolName: string,
  output: string,
  outcome: { blocked: boolean; rejected?: boolean },
): ToolResultSummary {
  const body = sanitizeTerminalText(output.replace(VERIFICATION_EVIDENCE_RE, ""));
  if (body.startsWith("[安全引擎拒绝拦截]")) {
    const reason = body.match(/拒绝原因: ([^。\n]+)/)?.[1];
    return { status: "rejected", text: `安全策略拦截${reason ? `：${oneLine(reason)}` : ""}` };
  }
  if (outcome.rejected) {
    return { status: "rejected", text: body.includes("用户拒绝") ? "已拒绝执行" : firstLine(body) };
  }
  if (/^\[[^\]]*已中止\]/.test(body)) return { status: "failed", text: "已中止" };
  if (outcome.blocked) {
    return {
      status: "failed",
      text: oneLine(firstLine(body).replace(/^(错误|执行出错)[:：]\s*/, "")),
    };
  }
  if (toolName === "bash") {
    const bash = summarizeBashOutput(body);
    if (bash) return bash;
  }
  const head = firstLine(body);
  if (DISPLAY_FAILURE_RE.test(head)) return { status: "failed", text: oneLine(head) };

  const readRange = body.match(/总行数=(\d+)；返回=([\d-]+)/);
  if (readRange) {
    const [, total, range] = readRange;
    return {
      status: "success",
      text: range === `1-${total}` ? `${total} 行` : `第 ${range} 行 · 共 ${total} 行`,
    };
  }
  const searchCount = body.match(/返回=(\d+)；hasMore=(true|false)/);
  if (searchCount) {
    const count = Number(searchCount[1]);
    return {
      status: "success",
      text:
        count === 0
          ? "无匹配"
          : `${count} 条结果${searchCount[2] === "true" ? "（还有更多）" : ""}`,
    };
  }
  const writtenBytes = body.match(/^大小: (\d+) 字节$/m);
  if (body.startsWith("[文件写入成功]") && writtenBytes) {
    return { status: "success", text: `已写入 ${formatBytes(Number(writtenBytes[1]))}` };
  }
  if (body.startsWith("[文件精准编辑成功]")) return { status: "success", text: "已替换 1 处" };

  const lineCount = body.split(/\r?\n/).filter((line) => line.trim()).length;
  const summary = oneLine(head.replace(/^\[(.*)\]$/, "$1"));
  return {
    status: "success",
    text: lineCount > 1 ? `${summary} · 共 ${lineCount} 行` : summary,
  };
}

/** 工具耗时：亚秒显示毫秒，一分钟内保留一位小数。 */
export function formatToolDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export interface ToolCellOptions {
  status: ToolCellStatus;
  toolName: string;
  summary: string;
  width: number;
  /** 运行中显示的动画帧；完成态使用固定符号。 */
  spinner?: string;
  /** 右侧的耗时文本（运行中为已用时间）。 */
  timing?: string;
  /** 子代理等来源标签，显示在工具名之前。 */
  sourceLabel?: string;
  /** 完成后的结果说明，显示在第二行。 */
  resultText?: string;
  /** 运行中滚动显示的最后几行输出。 */
  outputTail?: readonly string[];
}

const TOOL_CELL_INDENT = "  ";

/**
 * 渲染一个工具调用块（与对话正文统一的符号体系）：
 *   ✓ bash  npm test                      6.0s
 *     └ 12 行输出 · 全部通过
 * 运行中把符号换成动画帧，并在下方显示输出尾部。
 */
export function formatToolCell(options: ToolCellOptions): string[] {
  const width = Math.max(10, options.width);
  const mark =
    options.status === "running"
      ? colors.cyan(options.spinner || "●")
      : options.status === "success"
        ? colors.boldGreen("✓")
        : options.status === "rejected"
          ? colors.boldYellow("⊘")
          : colors.boldRed("✕");
  const source = options.sourceLabel ? `${options.sourceLabel} ` : "";
  const timing = options.timing || "";
  const fixedWidth =
    terminalWidth(TOOL_CELL_INDENT) +
    2 +
    terminalWidth(source) +
    terminalWidth(options.toolName) +
    (timing ? terminalWidth(timing) + 2 : 0);
  const summaryWidth = Math.max(0, width - fixedWidth - 2);
  const summary = fitText(options.summary, summaryWidth);
  const headerPlainWidth = fixedWidth + (summary ? terminalWidth(summary) + 2 : 0);
  const gap = timing ? " ".repeat(Math.max(2, width - headerPlainWidth + 2)) : "";
  const header = [
    TOOL_CELL_INDENT,
    mark,
    " ",
    source ? colors.gray(source) : "",
    colors.bold(options.toolName),
    summary ? `  ${summary}` : "",
    timing ? `${gap}${colors.gray(timing)}` : "",
  ].join("");
  const rows = [header];
  const bodyWidth = Math.max(1, width - terminalWidth(TOOL_CELL_INDENT) - 4);
  if (options.status === "running") {
    for (const line of options.outputTail || []) {
      rows.push(`${TOOL_CELL_INDENT}  ${colors.gray(`│ ${fitText(line, bodyWidth)}`)}`);
    }
  } else if (options.resultText) {
    const text = fitText(options.resultText, bodyWidth);
    const styled =
      options.status === "failed"
        ? colors.red(text)
        : options.status === "rejected"
          ? colors.yellow(text)
          : colors.gray(text);
    rows.push(`${TOOL_CELL_INDENT}  ${colors.gray("└")} ${styled}`);
  }
  return rows;
}

function displayPath(target: string, cwd: string): string {
  const home = os.homedir();
  if (target === home || target.startsWith(`${home}${path.sep}`)) {
    return `~${target.slice(home.length)}`;
  }
  return target || cwd;
}

function previewTextLines(text: string, prefix: string, maxLines: number): string[] {
  const lines = sanitizeTerminalText(text).replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const visible = lines.slice(0, maxLines).map((line) => `${prefix}${line.replace(/\t/g, "  ")}`);
  if (lines.length > maxLines) visible.push(`… 另有 ${lines.length - maxLines} 行`);
  return visible;
}

/**
 * 授权卡片的预览内容：bash 展示完整命令与工作目录，write/edit 展示将要写入
 * 或替换的文本，其余工具逐项列出参数。返回已着色的行，由界面按宽度裁剪。
 */
export function buildPermissionPreview(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string[] {
  if (toolName === "bash" && typeof args.command === "string") {
    return [
      ...previewTextLines(args.command, "", 12).map((line) =>
        line.startsWith("… 另有") ? colors.gray(line) : colors.cyan(line),
      ),
      colors.gray(`工作目录 ${displayPath(cwd, cwd)}`),
    ];
  }
  if (toolName === "write" && typeof args.path === "string") {
    let exists = false;
    try {
      exists = fs.existsSync(path.resolve(cwd, args.path));
    } catch {
      exists = false;
    }
    const content = typeof args.content === "string" ? args.content : "";
    const lineCount = content ? content.replace(/\n$/, "").split("\n").length : 0;
    return [
      `${colors.bold(oneLine(args.path))}  ${colors.gray(`${exists ? "覆盖已有文件" : "新建文件"} · ${lineCount} 行`)}`,
      ...previewTextLines(content, "+ ", 8).map((line) =>
        line.startsWith("… 另有") ? colors.gray(line) : colors.green(line),
      ),
    ];
  }
  if (toolName === "edit" && typeof args.path === "string") {
    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText = typeof args.newText === "string" ? args.newText : "";
    return [
      colors.bold(oneLine(args.path)),
      ...previewTextLines(oldText, "- ", 6).map((line) =>
        line.startsWith("… 另有") ? colors.gray(line) : colors.red(line),
      ),
      ...previewTextLines(newText, "+ ", 6).map((line) =>
        line.startsWith("… 另有") ? colors.gray(line) : colors.green(line),
      ),
    ];
  }
  const entries = Object.entries(args);
  if (entries.length === 0) return [colors.gray("（无参数）")];
  return entries
    .slice(0, 10)
    .map(([key, value]) => `${colors.gray(`${key}:`)} ${fitText(oneLine(value), 200)}`);
}

export function getCliVersion(): string {
  try {
    const packagePath = path.join(__dirname, "..", "package.json");
    const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string };
    return packageData.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}
