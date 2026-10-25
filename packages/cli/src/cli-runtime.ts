import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "@hajicli/plugins";
import { buildEditDiff, buildWriteDiff, formatDiffHeader } from "./diff-preview.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { fitText, terminalWidth, wrapAnsi } from "./terminal-text.js";
import { colors } from "./theme.js";

/** 用户级偏好（跨项目默认值）：~/.haji/preferences.json。 */
function userPreferencesPath(): string {
  return path.join(os.homedir(), ".haji", "preferences.json");
}

/**
 * 项目级偏好：<cwd>/.haji/preferences.json。
 *
 * 读取顺序是「项目级覆盖用户级」：用户级存的是全局默认（模型 / 思考强度 / provider），
 * 每个项目第一次改模型时才写自己的那份，之后按项目记忆。
 */
function projectPreferencesPath(): string {
  return path.join(process.cwd(), ".haji", "preferences.json");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Preferences {
  model: string;
  reasoningEffort: string;
  /** 上次使用的 provider 名称（内置 deepseek/volcengine 或自定义名称）。 */
  provider?: string;
  permissionMode?: string;
  riskThreshold?: string;
  /** 杂活模型（压缩摘要/会话标题/经验提炼）；缺省按单价自动挑最便宜的。 */
  utilityModel?: string;
  /** 完成 / 待授权提醒：off | bell | desktop，默认 bell。 */
  notify?: "off" | "bell" | "desktop";
  /** 会话预算（元）：累计费用超过后在回合小结给出提示。 */
  budget?: number;
  /** 右侧会话信息栏开关；缺省视为开启（true），宽度不足时自动隐藏。 */
  sidebar?: boolean;
  /** 对话区过程折叠；缺省视为开启（true）。关闭后工具调用与思考逐行显示。 */
  foldProcess?: boolean;
  /** Auto 模式的信任边界（自然语言，拼进安全分类器系统提示词）；缺省为工作目录及其 git remote。 */
  autoEnvironment?: string;
  /**
   * 已经问过「要不要交给后台 agent 查定价」的模型名。
   * 提醒只发生一次：之后统一走侧栏「费用」或 /cost config。
   */
  pricingPromptedModels?: string[];
}

function readPreferences(filePath: string): Preferences | null {
  try {
    // 去掉可能存在的 UTF-8 BOM：记事本 / PowerShell 5.1 写出来的 JSON 常带它，
    // 而 JSON.parse 会把 BOM 当成语法错误，导致偏好被静默忽略。
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Preferences;
  } catch {
    return null;
  }
}

/**
 * 读取偏好：显式传入路径时只读那一份（测试用）；否则先读用户级再叠项目级，
 * 字段逐个覆盖，所以项目里只改了模型也不会把用户级的 provider 丢成 undefined。
 */
export function loadPreference(preferencePath?: string): Preferences | null {
  if (preferencePath) return readPreferences(preferencePath);
  const user = readPreferences(userPreferencesPath());
  const project = readPreferences(projectPreferencesPath());
  const merged: Record<string, unknown> = { ...user, ...project };
  // 空字符串视作「没设置」，避免项目级写了个空值把用户级默认抹掉
  for (const [key, value] of Object.entries(merged)) {
    if (value === "") delete merged[key];
  }
  return Object.keys(merged).length > 0 ? (merged as unknown as Preferences) : null;
}

/**
 * 保存偏好。不传路径时写项目级（历史行为），并在用户级还不存在时补一份，
 * 让第一次使用的人也有全局默认可回退。
 */
export function savePreference(
  preference: Preferences,
  onWarning?: (message: string) => void,
  preferencePath?: string,
): boolean {
  const write = (filePath: string): boolean => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(preference, null, 2), "utf8");
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onWarning?.(`用户偏好保存失败：${detail}`);
      return false;
    }
  };
  if (preferencePath) return write(preferencePath);
  if (!fs.existsSync(userPreferencesPath())) write(userPreferencesPath());
  return write(projectPreferencesPath());
}

/** 写入用户级偏好（跨项目默认）。供「设为默认」这类显式操作使用。 */
export function saveUserPreference(
  preference: Preferences,
  onWarning?: (message: string) => void,
): boolean {
  try {
    fs.mkdirSync(path.dirname(userPreferencesPath()), { recursive: true });
    fs.writeFileSync(userPreferencesPath(), JSON.stringify(preference, null, 2), "utf8");
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

/** 首个词之后还要带上子命令才有区分度的命令行工具（如 `npm test` 与 `npm publish`）。 */
const SUBCOMMAND_CLIS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bun",
  "deno",
  "cargo",
  "go",
  "dotnet",
  "docker",
  "kubectl",
  "pip",
  "uv",
]);

export interface PermissionGrant {
  /** 会话授权表中的键：bash 为命令前缀，其余为工具名。 */
  key: string;
  /** 授权范围的描述（如“npm test 开头的命令”），用于卡片选项与确认提示。 */
  scope: string;
}

/**
 * 计算“本会话内总是允许”的授权范围：bash 按命令前缀授权（`npm test`、`ls` 等），
 * 不再一次放行全部 shell 命令；含组合/重定向/替换的命令无法按前缀安全匹配，返回 undefined
 * （只能单次允许）。其余工具按工具名授权。
 */
export function getPermissionGrant(
  toolName: string,
  args: Record<string, unknown>,
): PermissionGrant | undefined {
  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command || /[;&|<>`$\r\n]/.test(command)) return undefined;
    const tokens = command.split(/\s+/);
    const withSubcommand =
      SUBCOMMAND_CLIS.has(tokens[0].toLowerCase()) && tokens[1] && !tokens[1].startsWith("-");
    const prefix = sanitizeTerminalText(
      withSubcommand ? `${tokens[0]} ${tokens[1]}` : tokens[0],
    ).toLowerCase();
    return { key: `bash:${prefix}`, scope: `${prefix} 开头的命令` };
  }
  if (toolName === "write" || toolName === "edit") {
    return { key: toolName, scope: toolName === "write" ? "写入文件" : "编辑文件" };
  }
  return { key: toolName, scope: toolName };
}

export interface PermissionCardItem {
  value: string;
  label: string;
  hotkey: string;
}

/**
 * 构造授权卡片的选项列表：允许本次 / 本会话内总是允许（有明确授权范围时）/
 * 永久允许（本项目 ⇄ 全局，作用域经 secondary 轴切换）/ 拒绝 / 拒绝并说明。
 * 永久允许跨会话写入 permissions.json；「拒绝并说明」把理由回传给模型。
 *
 * `options.persistent === false` 用于受保护目标：只给「本次 / 拒绝」，
 * 因为「永久允许修改授权配置」会让这层保护本身失效。
 */
export function buildPermissionCardItems(
  grant: PermissionGrant | undefined,
  options: { persistent?: boolean } = {},
): PermissionCardItem[] {
  const persistent = options.persistent !== false;
  return [
    { value: "once", label: "允许本次", hotkey: "y" },
    ...(grant && persistent
      ? [{ value: "session", label: `本会话内总是允许 ${grant.scope}`, hotkey: "a" }]
      : []),
    ...(grant && persistent
      ? [{ value: "always", label: `永久允许 ${grant.scope}`, hotkey: "p" }]
      : []),
    { value: "deny", label: "拒绝", hotkey: "n" },
    { value: "deny-reason", label: "拒绝并说明…", hotkey: "e" },
  ];
}

export type ToolCellStatus = "judging" | "running" | "success" | "failed" | "rejected";

export interface ToolResultSummary {
  status: Exclude<ToolCellStatus, "running" | "judging">;
  text: string;
  /** 结果说明下面的几行输出预览（已清洗，未按宽度截断）；没有可看的就不给。 */
  preview?: string[];
}

/** 工具块结果说明下方最多预览几行输出（加上说明行一共四行）。 */
export const TOOL_PREVIEW_LINES = 3;

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

/** 文本行数（末尾换行不计为新的一行）。 */
function countTextLines(text: string): number {
  return text ? text.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
}

/** 预览用的一行：Tab 展开、去掉行尾空白，保留行首缩进。 */
function previewLine(line: string): string {
  return line.replace(/\t/g, "  ").trimEnd();
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
        !/^\[中间省略 \d+ 个字符\]$/.test(line) &&
        line !== "(命令执行完成，无控制台输出)",
    );
  const failed = exitCode !== "0";
  const status = failed ? "failed" : "success";
  const prefix = failed ? `退出码 ${exitCode} · ` : "";
  if (bodyLines.length === 0) return { status, text: `${prefix}无输出` };
  // 失败时首个报错行通常比最后一行（多为日志路径等收尾信息）更有信息量。
  const errorIndex = failed
    ? bodyLines.findIndex((line) =>
        /\b(?:error|failed|fatal|exception)\b|\berr!|错误|失败/i.test(line),
      )
    : -1;
  if (bodyLines.length === 1) {
    return { status, text: `${prefix}1 行输出 · ${oneLine(bodyLines[0])}` };
  }
  // 结果和汇总多在末尾（测试统计、dir 的可用空间）；失败时从首个报错行往下看。
  const start = errorIndex >= 0 ? errorIndex : Math.max(0, bodyLines.length - TOOL_PREVIEW_LINES);
  return {
    status,
    text: `${prefix}${bodyLines.length} 行输出`,
    preview: bodyLines.slice(start, start + TOOL_PREVIEW_LINES).map(previewLine),
  };
}

/** 搜索类结果正文里，元信息行之后的条目。 */
function searchBodyLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() &&
        !/^\[.*\]$/.test(line) &&
        !/^(?:引擎=|nextOffset=|提示：)/.test(line) &&
        !/^\((?:未找到匹配结果|没有找到匹配文件)\)$/.test(line),
    );
}

/**
 * grep 每条命中占一段（段间空行），首行是 `文件:行:列[: 内容]`，带上下文时下面是
 * `> 行号 | 内容`；预览成 `文件:行  内容`。
 */
function grepPreview(body: string): string[] {
  const records = body.split(/\r?\n\r?\n/);
  const preview: string[] = [];
  for (const record of records) {
    const lines = record.split(/\r?\n/);
    const index = lines.findIndex((line) => /^.+:\d+:\d+(?:: |$)/.test(line));
    if (index < 0) continue;
    const head = lines[index].match(/^(.+):(\d+):\d+(?:: (.*))?$/);
    if (!head) continue;
    const hit = lines.slice(index + 1).find((line) => line.startsWith(">"));
    const content = head[3] ?? hit?.replace(/^>\s*\d+\s*\|\s?/, "") ?? "";
    preview.push(previewLine(`${head[1]}:${head[2]}${content ? `  ${content.trim()}` : ""}`));
    if (preview.length >= TOOL_PREVIEW_LINES) break;
  }
  return preview;
}

/**
 * 编辑成功后文件已经是「改动后」的状态。把 newText 换回 oldText 即可重建
 * 「改动前」的全文，让工具块完成后的预览与授权卡片渲染同一份 patch
 * （真实行号 + 上下文，而不是块内相对行号的片段）。
 * 用工具输出里的 oldHash 校验重建结果：校验不上就返回 undefined，退回片段对比。
 */
function rebuildPreEditContent(
  after: string,
  oldText: string,
  newText: string,
  beforeHash?: string,
  regionStartLine?: number,
): string | undefined {
  if (!newText) return undefined;
  const attempt = (needle: string, replacement: string): string | undefined => {
    const hits: number[] = [];
    for (
      let at = after.indexOf(needle);
      at !== -1;
      at = after.indexOf(needle, at + needle.length)
    ) {
      hits.push(at);
    }
    if (hits.length === 0) return undefined;
    // newText 在同一文件里出现多次时，优先用工具回显的「改后片段（第 N 行起）」定位。
    const lineOf = (at: number) => after.slice(0, at).split("\n").length;
    const ordered =
      hits.length > 1 && regionStartLine !== undefined
        ? [
            ...hits.filter((at) => lineOf(at) === regionStartLine),
            ...hits.filter((at) => lineOf(at) !== regionStartLine),
          ]
        : hits;
    for (const at of ordered) {
      const rebuilt = `${after.slice(0, at)}${replacement}${after.slice(at + needle.length)}`;
      if (beforeHash === undefined || contentHash(rebuilt) === beforeHash) return rebuilt;
    }
    return undefined;
  };
  const exact = attempt(newText, oldText);
  if (exact !== undefined) return exact;
  // 文件是 CRLF 而工具入参只有 LF（read 会去掉 \r）：按 CRLF 再试一次。
  if (after.includes("\r\n") && !newText.includes("\r")) {
    const toCrlf = (value: string) => value.replace(/\r?\n/g, "\r\n");
    return attempt(toCrlf(newText), toCrlf(oldText));
  }
  return undefined;
}

/** 从 edit 的入参与输出还原「改动前」全文；读不到文件或缺信息时返回 undefined。 */
function preEditContentForEdit(
  args: Record<string, unknown>,
  output: string,
  cwd: string,
): string | undefined {
  if (typeof args.path !== "string" || typeof args.newText !== "string") return undefined;
  const oldText = typeof args.oldText === "string" ? args.oldText : undefined;
  if (oldText === undefined) return undefined;
  const regionLine = output.match(/改后片段（第 (\d+) 行起）/)?.[1];
  const beforeHash = output.match(/oldHash=([0-9a-f]{16})/i)?.[1]?.toLowerCase();
  try {
    const after = fs.readFileSync(path.resolve(cwd, args.path), "utf8");
    return rebuildPreEditContent(
      after,
      oldText,
      args.newText,
      beforeHash,
      regionLine === undefined ? undefined : Number(regionLine),
    );
  } catch {
    return undefined;
  }
}

/**
 * 把工具输出压缩成一行结果说明，并给出展示用的成败判定：
 * bash 非零退出码与“xx失败:”类输出在界面上同样标记为失败。
 */
export function summarizeToolResult(
  toolName: string,
  output: string,
  outcome: { blocked: boolean; rejected?: boolean },
  args: Record<string, unknown> = {},
  /** edit 完成块重建「改动前」全文用；回放历史时不传，避免拿当前磁盘内容冒充旧状态。 */
  cwd?: string,
): ToolResultSummary {
  const body = sanitizeTerminalText(output.replace(VERIFICATION_EVIDENCE_RE, ""));
  const policyLabel = body.startsWith("[计划模式拦截]")
    ? "计划模式阻止"
    : body.startsWith("[自动模式拦截]") || body.startsWith("[安全引擎拒绝拦截]")
      ? "安全策略拦截"
      : undefined;
  if (policyLabel) {
    const reason = body.match(/(?:拒绝原因|原因)[:：]\s*([^。\n]+)/)?.[1];
    // 自动模式的原因可能以 [Data Exfiltration] 这类标签开头，保留原文便于定位。
    return { status: "rejected", text: `${policyLabel}${reason ? `：${oneLine(reason)}` : ""}` };
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
    if (count === 0) return { status: "success", text: "无匹配" };
    const preview =
      toolName === "grep"
        ? grepPreview(body)
        : toolName === "global"
          ? searchBodyLines(body).slice(0, TOOL_PREVIEW_LINES).map(previewLine)
          : [];
    return {
      status: "success",
      text: `${count} 条结果${searchCount[2] === "true" ? "（还有更多）" : ""}`,
      ...(preview.length ? { preview } : {}),
    };
  }
  const writtenBytes = body.match(/^大小: (\d+) 字节$/m);
  if (body.startsWith("[文件写入成功]") && writtenBytes) {
    const lines = typeof args.content === "string" ? countTextLines(args.content) : 0;
    return {
      status: "success",
      text: `已写入 ${formatBytes(Number(writtenBytes[1]))}${lines > 0 ? ` · ${lines} 行` : ""}`,
    };
  }
  if (body.startsWith("[文件无需修改]")) {
    return { status: "success", text: "目标内容已存在 · 无需修改" };
  }
  if (body.startsWith("[文件精准编辑成功]")) {
    if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
      return { status: "success", text: "已替换 1 处" };
    }
    // 与授权卡片共用同一份 patch：先还原「改动前」全文，行号与上下文才和授权阶段一致。
    // 回放历史（不传 cwd）或还原不出来时退回 oldText/newText 片段对比。
    const original = cwd === undefined ? undefined : preEditContentForEdit(args, body, cwd);
    const diff = buildEditDiff(original ?? "", args.oldText, args.newText, 240, TOOL_PREVIEW_LINES);
    return {
      status: "success",
      text: `已替换 1 处 · +${diff.stats.added} −${diff.stats.removed} 行`,
      ...(diff.lines.length > 0 ? { preview: diff.lines } : {}),
    };
  }

  const lineCount = body.split(/\r?\n/).filter((line) => line.trim()).length;
  const summary = oneLine(head.replace(/^\[(.*)\]$/, "$1"));
  return {
    status: "success",
    text: lineCount > 1 ? `${summary} · 共 ${lineCount} 行` : summary,
  };
}

/**
 * Ctrl+O 展开的完整工具输出：标题行（工具名 + 调用主语）+ 灰色正文，超长时截断并注明行数。
 * 返回已着色的行，由调用方写入对话区。
 */
export function formatExpandedToolOutput(
  toolName: string,
  summary: string,
  output: string,
  width: number,
  maxLines = 300,
): string[] {
  const body = sanitizeTerminalText(output.replace(VERIFICATION_EVIDENCE_RE, ""))
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\n+$/, "");
  const lines = body ? body.split("\n") : ["（无输出）"];
  const shown = lines.slice(0, Math.max(1, maxLines));
  const rows = [
    `${TOOL_CELL_INDENT}${colors.bold(toolName)}  ${fitText(summary, Math.max(1, width - terminalWidth(toolName) - 6))}`,
    ...shown.map((line) => `${TOOL_CELL_INDENT}${colors.gray(`│ ${line}`)}`),
  ];
  if (lines.length > shown.length) {
    rows.push(
      `${TOOL_CELL_INDENT}${colors.gray(`… 另有 ${lines.length - shown.length} 行未显示（完整记录见 /viewer）`)}`,
    );
  }
  return rows;
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
  /** 右侧的耗时文本（运行中为已用时间）。 */
  timing?: string;
  /** 子代理等来源标签，显示在工具名之前。 */
  sourceLabel?: string;
  /** 自动模式判定结论（AI 放行 / AI 拦截 · 1.2s）：只用于实时区域，不进对话正文。 */
  verdict?: string;
  /** 完成后的结果说明，显示在第二行。 */
  resultText?: string;
  /** 结果说明下面的输出预览（最多 TOOL_PREVIEW_LINES 行）。 */
  preview?: readonly string[];
  /** 运行中滚动显示的最后几行输出。 */
  outputTail?: readonly string[];
}

/** 工具块左缩进；过程折叠的摘要行复用它，保证与工具块左对齐。 */
export const TOOL_CELL_INDENT = "  ";

/**
 * 渲染一个工具调用块（与对话正文统一的符号体系）：
 *   ✓ bash  npm test                      6.0s
 *     └ 12 行输出
 *       # pass 12
 *       # fail 0
 * 运行中用静止的 ●（动画只在活动行），下方显示输出尾部；完成后结果说明下面带几行预览。
 */
export function formatToolCell(options: ToolCellOptions): string[] {
  const width = Math.max(10, options.width);
  const mark =
    options.status === "judging"
      ? colors.accent("◈")
      : options.status === "running"
        ? colors.accent("●")
        : options.status === "success"
          ? colors.boldGreen("✓")
          : options.status === "rejected"
            ? colors.boldYellow("⊘")
            : colors.boldRed("✕");
  const source = options.sourceLabel ? `${options.sourceLabel} ` : "";
  const timing = options.timing || "";
  const verdict = options.verdict || "";
  const fixedWidth =
    terminalWidth(TOOL_CELL_INDENT) +
    2 +
    terminalWidth(source) +
    terminalWidth(options.toolName) +
    (timing ? terminalWidth(timing) + 2 : 0) +
    (verdict ? terminalWidth(verdict) + 2 : 0);
  const summaryWidth = Math.max(0, width - fixedWidth - 2);
  const summary = fitText(options.summary, summaryWidth);
  // 耗时紧跟在参数后面，不贴右边：工具块写进对话时宽度就定了，
  // 之后窗口拉宽，贴右的耗时会停在半路，和别的整行元素对不齐。
  const header = [
    TOOL_CELL_INDENT,
    mark,
    " ",
    source ? colors.faint(source) : "",
    options.toolName,
    summary ? `  ${summary}` : "",
    timing ? `  ${colors.faint(timing)}` : "",
    verdict ? `  ${colors.faint(verdict)}` : "",
  ].join("");
  const rows = [header];
  const bodyWidth = Math.max(1, width - terminalWidth(TOOL_CELL_INDENT) - 4);
  if (options.status === "running") {
    for (const line of options.outputTail || []) {
      rows.push(
        `${TOOL_CELL_INDENT}  ${colors.faint("│")} ${colors.muted(fitText(line, bodyWidth))}`,
      );
    }
  } else if (options.resultText) {
    // 成败只靠前面的 ✓ / ✕ / ⊘ 着色；失败的说明用正文色，比成功的灰字醒目一档。
    const text = fitText(options.resultText, bodyWidth);
    const styled = options.status === "failed" ? text : colors.muted(text);
    rows.push(`${TOOL_CELL_INDENT}  ${colors.faint("└")} ${styled}`);
    // 预览和结果说明的文字对齐（└ 加一个空格占两格）。
    const previewWidth = Math.max(1, bodyWidth - 2);
    for (const line of (options.preview || []).slice(0, TOOL_PREVIEW_LINES)) {
      rows.push(`${TOOL_CELL_INDENT}    ${colors.muted(fitText(line, previewWidth))}`);
    }
  }
  return rows;
}

/**
 * 查找工作区所属 git 仓库的 HEAD 文件（向上逐级查找 .git；兼容 worktree/submodule
 * 的 `gitdir:` 文件）。找不到时返回 undefined。
 */
export function findGitHeadPath(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  while (true) {
    const dotGit = path.join(dir, ".git");
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return path.join(dotGit, "HEAD");
      if (stat.isFile()) {
        const gitDir = fs
          .readFileSync(dotGit, "utf8")
          .match(/^gitdir:\s*(.+)$/m)?.[1]
          ?.trim();
        if (gitDir) return path.join(path.resolve(dir, gitDir), "HEAD");
      }
    } catch {
      // 当前层没有 .git，继续向上查找。
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** 读取当前分支名；分离 HEAD 时返回 7 位提交号，读取失败返回 undefined。 */
export function readGitBranch(headPath: string | undefined): string | undefined {
  if (!headPath) return undefined;
  try {
    const head = fs.readFileSync(headPath, "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
    if (ref) return sanitizeTerminalText(ref);
    return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}

/** 状态栏展示的工作区：家目录缩写为 ~，并附上当前 git 分支。 */
export function formatWorkspaceLabel(cwd: string, branch?: string): string {
  const home = os.homedir();
  const shown =
    cwd === home || cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
  return branch ? `${shown} (${branch})` : shown;
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
 * 授权卡片的预览内容：bash 展示完整命令与工作目录，write/edit 用带行号与
 * 行内高亮的 diff 预览，其余工具逐项列出参数。返回已着色的行，由界面按宽度裁剪。
 */
export function buildPermissionPreview(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string[] {
  if (toolName === "bash" && typeof args.command === "string") {
    return [
      ...previewTextLines(args.command, "", 12).map((line) =>
        line.startsWith("… 另有") ? colors.gray(line) : line,
      ),
      colors.gray(`工作目录 ${displayPath(cwd, cwd)}`),
    ];
  }
  if (toolName === "write" && typeof args.path === "string") {
    const targetPath = path.resolve(cwd, args.path);
    let exists = false;
    let original: string | undefined;
    try {
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        exists = true;
        original = fs.readFileSync(targetPath, "utf8");
      }
    } catch {
      exists = false;
      original = undefined;
    }
    const content = typeof args.content === "string" ? args.content : "";
    const diff = buildWriteDiff(original, content, 240, 12);
    if (diff.lines.length === 0) {
      return [formatDiffHeader(oneLine(args.path), diff.stats, "内容为空")];
    }
    return [
      formatDiffHeader(oneLine(args.path), diff.stats, exists ? "覆盖已有文件" : "新建文件"),
      ...diff.lines,
    ];
  }
  if (toolName === "edit" && typeof args.path === "string") {
    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText = typeof args.newText === "string" ? args.newText : "";
    let original = "";
    try {
      original = fs.readFileSync(path.resolve(cwd, args.path), "utf8");
    } catch {
      original = "";
    }
    const diff = buildEditDiff(original, oldText, newText, 240, 14);
    return [formatDiffHeader(oneLine(args.path), diff.stats), ...diff.lines];
  }
  const entries = Object.entries(args);
  if (entries.length === 0) return [colors.gray("（无参数）")];
  return entries
    .slice(0, 10)
    .map(([key, value]) => `${colors.gray(`${key}:`)} ${fitText(oneLine(value), 200)}`);
}

/**
 * 思考过程预览：取推理文本末尾按宽度折行后的最后几行，灰色显示在对话区底部。
 * 返回实时区域文本（以换行结尾）；没有可显示内容时返回空串。
 */
export function formatReasoningPreview(reasoning: string, width: number, maxRows = 3): string {
  const tail = sanitizeTerminalText(reasoning.slice(-800)).replace(/\s+/g, " ").trim();
  if (!tail) return "";
  // 输入是纯文本，去掉 wrapAnsi 在每行末尾补的复位序列，无色模式下也不残留转义。
  const rows = wrapAnsi(tail, Math.max(8, width - 6))
    .slice(-maxRows)
    .map((row) => row.replace(/\x1b\[0m$/, ""));
  return `${rows.map((row) => `  ${colors.gray(`┊ ${row}`)}`).join("\n")}\n`;
}

export interface ModelErrorDescription {
  /** 一句话的错误类别（含 HTTP 状态码时附在后面）。 */
  title: string;
  /** 上游返回的原始说明。 */
  detail: string;
  /** 针对该类错误的下一步操作。 */
  hint: string;
}

/**
 * 按 HTTP 状态码与错误文本把模型调用失败归类，给出对应的下一步提示，
 * 而不是对所有错误都建议“检查 API Key”。
 */
export function describeModelError(error: unknown): ModelErrorDescription {
  const detail = sanitizeTerminalText(
    error instanceof Error ? error.message : String(error),
  ).trim();
  const rawStatus =
    error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const text = detail.toLowerCase();
  const label = (title: string) => (status ? `${title}（${status}）` : title);
  const describe = (title: string, hint: string): ModelErrorDescription => ({
    title: label(title),
    detail,
    hint,
  });

  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|authenticat|invalid api key|incorrect api key|api key is missing/.test(text)
  ) {
    return describe("认证失败", "API Key 无效、已过期或缺失：运行 /provider 重新配置后重试。");
  }
  if (status === 402 || /insufficient (balance|quota)|quota exceeded|billing|余额不足/.test(text)) {
    return describe("账户额度不足", "到模型平台检查余额或套餐后重新发送。");
  }
  if (status === 429 || /rate limit|too many requests|限流/.test(text)) {
    return describe("请求过于频繁", "已触发上游限流：稍等片刻再重新发送，或用 /model 换一个模型。");
  }
  if (
    /maximum context|context (length|window)|too many tokens|token limit|上下文.{0,6}(超出|过长)/.test(
      text,
    )
  ) {
    return describe(
      "上下文超出模型窗口",
      "运行 /compact 压缩上下文后重新发送，或换用窗口更大的模型。",
    );
  }
  if (
    status === 404 ||
    /model.{0,40}(not found|does not exist|not exist|unavailable)|模型不存在/.test(text)
  ) {
    return describe(
      "模型不可用",
      "当前提供商没有这个模型：用 /model 切换，或用 /provider 检查配置的模型名。",
    );
  }
  if (
    (error instanceof Error && error.name === "ConnectionError") ||
    /econn|enotfound|etimedout|eai_again|socket hang up|fetch failed|network|timed? ?out|超时|无法连接|无法解析/.test(
      text,
    )
  ) {
    return describe("网络连接失败", "检查网络与代理（HAJI_PROXY / HTTPS_PROXY）后重新发送。");
  }
  if (
    (status !== undefined && status >= 500) ||
    /overloaded|service unavailable|bad gateway|internal server error/.test(text)
  ) {
    return describe("模型服务暂时不可用", "上游服务异常，稍后重新发送即可。");
  }
  return describe("模型调用出错", "检查模型名称与 API Key，或用 /config 切换模型与提供商。");
}

/**
 * 重试提示用的错误摘要：已知类别给「类别：原始说明（截断）」，
 * 未知错误保留原文截断。纯函数，供 onRetry 每次重试时调用。
 */
export function summarizeModelErrorShort(error: unknown, maxLength = 60): string {
  const described = describeModelError(error);
  const raw = sanitizeTerminalText(described.detail).replace(/\s+/g, " ").trim();
  if (described.title !== "模型调用出错" || !raw) {
    const detail = raw.slice(0, 40);
    return detail ? `${described.title}：${detail}` : described.title;
  }
  return Array.from(raw).slice(0, maxLength).join("");
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
