/**
 * 对话区过程折叠的纯函数层：工具类别归类、段统计、摘要行与段文本渲染。
 *
 * 与 terminal-panels.ts 同一模式：不做 I/O、不持有 TerminalUI 状态，
 * 只把标量统计变成字符串，方便用固定宽度做单元测试。
 *
 * 分工：TerminalUI 负责“哪些行属于同一段、何时封口”，本模块只负责
 * “这一段该怎么写成一个摘要行”。摘要行按当前宽度现算，所以终端缩放后仍是单行。
 */
import { TOOL_CELL_INDENT } from "./cli-runtime.js";
import { terminalWidth, truncateText } from "./terminal-text.js";
import { colors } from "./theme.js";

/** 工具类别：摘要行按此顺序输出，计数为 0 的类别不出现。 */
export type FoldToolCategory =
  | "read"
  | "search"
  | "edit"
  | "command"
  | "web"
  | "agent"
  | "task"
  | "skill"
  | "mcp"
  | "other";

/** 摘要行里类别的固定顺序（与设计文档 2.2 的表一致）。 */
const CATEGORY_ORDER: readonly FoldToolCategory[] = [
  "read",
  "search",
  "edit",
  "command",
  "web",
  "agent",
  "task",
  "skill",
  "mcp",
  "other",
];

/** 工具名 → 类别。read / edit 之外的类别都按调用次数计。 */
const TOOL_CATEGORY_MAP: Readonly<Record<string, FoldToolCategory>> = {
  read: "read",
  grep: "search",
  global: "search",
  edit: "edit",
  write: "edit",
  bash: "command",
  webfetch: "web",
  websearch: "web",
  subagent: "agent",
  verifyagent: "agent",
  taskcreate: "task",
  tasklist: "task",
  updatetask: "task",
  taskfinish: "task",
  loadskill: "skill",
  listskillresources: "skill",
  readskillresource: "skill",
};

const CATEGORY_LABELS: Readonly<Record<FoldToolCategory, (count: number) => string>> = {
  read: (count) => `读取 ${count} 个文件`,
  search: (count) => `搜索 ${count} 次`,
  edit: (count) => `编辑 ${count} 个文件`,
  command: (count) => `运行 ${count} 条命令`,
  web: (count) => `联网 ${count} 次`,
  agent: (count) => `子代理 ${count} 次`,
  task: (count) => `更新任务 ${count} 次`,
  skill: (count) => `Skill ${count} 次`,
  mcp: (count) => `MCP 工具 ${count} 次`,
  other: (count) => `其他工具 ${count} 次`,
};

/** 段内统计（summary 行与展开/收起都只看这份快照）。 */
export interface FoldGroupStats {
  /** 各类别计数（read / edit 已按路径去重）。 */
  counts: Partial<Record<FoldToolCategory, number>>;
  /** 段内工具调用总次数（去重前，用于“N 次工具调用”降级文案）。 */
  calls: number;
  /** 失败的工具调用数（含未注册工具）。 */
  failed: number;
  /** 被拒绝的工具调用数。 */
  rejected: number;
  /** 段内 reasoningContent 非空的迭代数。 */
  thinking: number;
}

/** 工具名 → 类别；MCP 工具按前缀识别，未知工具落到 other。 */
export function categorizeFoldTool(toolName: string): FoldToolCategory {
  const name = toolName.trim().toLowerCase();
  if (name.startsWith("mcp_")) return "mcp";
  return TOOL_CATEGORY_MAP[name] ?? "other";
}

/**
 * 段统计收集器：turn-runner 的实时回合与 /resume 的历史重建共用。
 * read / edit 按 args.path 去重——重复读同一个文件不该在摘要里算两次。
 */
export class FoldStatsCollector {
  private counts: Partial<Record<FoldToolCategory, number>> = {};
  private readPaths = new Set<string>();
  private editPaths = new Set<string>();
  private calls = 0;
  private failed = 0;
  private rejected = 0;
  private thinking = 0;

  addTool(
    toolName: string,
    args: Record<string, unknown>,
    status: "success" | "failed" | "rejected",
  ): void {
    const category = categorizeFoldTool(toolName);
    this.calls += 1;
    if (category === "read" || category === "edit") {
      const path = typeof args.path === "string" ? args.path : "";
      if (path) {
        const seen = category === "read" ? this.readPaths : this.editPaths;
        if (!seen.has(path)) {
          seen.add(path);
          this.counts[category] = (this.counts[category] ?? 0) + 1;
        }
      } else {
        // 没有路径的调用无法去重，按调用计。
        this.counts[category] = (this.counts[category] ?? 0) + 1;
      }
    } else {
      this.counts[category] = (this.counts[category] ?? 0) + 1;
    }
    if (status === "failed") this.failed += 1;
    else if (status === "rejected") this.rejected += 1;
  }

  addThinking(): void {
    this.thinking += 1;
  }

  isEmpty(): boolean {
    return this.calls === 0 && this.thinking === 0;
  }

  snapshot(): FoldGroupStats {
    return {
      counts: { ...this.counts },
      calls: this.calls,
      failed: this.failed,
      rejected: this.rejected,
      thinking: this.thinking,
    };
  }
}

/** 摘要行的一个片段：文本 + 着色函数（着色不参与宽度计算）。 */
interface HeaderPart {
  text: string;
  paint: (value: string) => string;
}

const plainPaint = (value: string): string => value;

function measureParts(parts: readonly HeaderPart[]): number {
  return terminalWidth(parts.map((part) => part.text).join(""));
}

function renderParts(parts: readonly HeaderPart[]): string {
  return parts.map((part) => part.paint(part.text)).join("");
}

function orderedEntries(stats: FoldGroupStats): Array<{ text: string; count: number }> {
  const entries: Array<{ text: string; count: number }> = [];
  for (const category of CATEGORY_ORDER) {
    const count = stats.counts[category] ?? 0;
    if (count <= 0) continue;
    entries.push({ text: CATEGORY_LABELS[category](count), count });
  }
  return entries;
}

/**
 * 摘要行：`{缩进}● 读取 4 个文件，搜索 2 次 · 思考 3 次 · 1 次失败`。
 * 按宽度依次降级（丢类别 → “N 次工具调用” → 丢思考 → 截断），保证单行。
 */
export function buildFoldHeader(stats: FoldGroupStats, width: number): string {
  const maxWidth = Math.max(1, Math.floor(width));
  const entries = orderedEntries(stats);
  const thinking = stats.thinking;
  const callCount = Math.max(
    stats.calls,
    entries.reduce((sum, entry) => sum + entry.count, 0),
  );
  const bulletPaint = stats.failed > 0 ? colors.boldRed : colors.muted;

  const build = (
    categoryTexts: readonly string[],
    options: { thinking: boolean; tools: "categories" | "count" | "none" },
  ): HeaderPart[] => {
    const parts: HeaderPart[] = [
      { text: TOOL_CELL_INDENT, paint: plainPaint },
      { text: "●", paint: bulletPaint },
    ];
    const toolText =
      options.tools === "categories"
        ? categoryTexts.join("，")
        : options.tools === "count" && callCount > 0
          ? `${callCount} 次工具调用`
          : "";
    if (toolText) parts.push({ text: ` ${toolText}`, paint: colors.muted });
    if (options.thinking && thinking > 0) {
      parts.push({ text: " · ", paint: colors.muted });
      parts.push({ text: `思考 ${thinking} 次`, paint: colors.muted });
    }
    if (stats.failed > 0) {
      parts.push({ text: " · ", paint: colors.muted });
      parts.push({ text: `${stats.failed} 次失败`, paint: colors.red });
    }
    if (stats.rejected > 0) {
      parts.push({ text: " · ", paint: colors.muted });
      parts.push({ text: `${stats.rejected} 次被拒`, paint: colors.yellow });
    }
    return parts;
  };

  if (entries.length === 0 && thinking === 0) {
    return renderParts(build([], { thinking: false, tools: "none" }));
  }

  // 1. 完整格式
  const categoryTexts = entries.map((entry) => entry.text);
  let candidate = build(categoryTexts, { thinking: true, tools: "categories" });
  if (measureParts(candidate) <= maxWidth) return renderParts(candidate);

  // 2. 从末尾往前逐个丢弃类别，丢掉的合并成“等 N 类”
  let dropped = 0;
  while (categoryTexts.length > 1) {
    categoryTexts.pop();
    dropped += 1;
    candidate = build([...categoryTexts, `等 ${dropped} 类`], {
      thinking: true,
      tools: "categories",
    });
    if (measureParts(candidate) <= maxWidth) return renderParts(candidate);
  }

  // 3. 工具部分改成“N 次工具调用”
  candidate = build([], { thinking: true, tools: "count" });
  if (measureParts(candidate) <= maxWidth) return renderParts(candidate);

  // 4. 丢掉“思考 N 次”
  candidate = build([], { thinking: false, tools: "count" });
  if (measureParts(candidate) <= maxWidth) return renderParts(candidate);

  // 5. 最后手段：整行截断（保留 ● 的配色语义）
  const text = truncateText(measurePartsPlain(candidate), maxWidth);
  return stats.failed > 0 ? colors.boldRed(text) : colors.muted(text);
}

function measurePartsPlain(parts: readonly HeaderPart[]): string {
  return parts.map((part) => part.text).join("");
}

/** 去 ANSI 后判断是否空白行；splitBlankEdges 用。 */
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function isBlankLine(line: string): boolean {
  return line.replace(ANSI_PATTERN, "").trim() === "";
}

/**
 * 把一段原文拆成首部空行 / 正文 / 尾部空行。
 * “空行”指去掉 ANSI 后为空白的行，这样工具块前后的配色空行也能正确归位。
 */
export function splitBlankEdges(raw: string): {
  leading: string;
  body: string;
  trailing: string;
} {
  const lines: string[] = [];
  let index = 0;
  while (index < raw.length) {
    const newline = raw.indexOf("\n", index);
    const end = newline === -1 ? raw.length : newline + 1;
    lines.push(raw.slice(index, end));
    index = end;
  }
  let start = 0;
  while (start < lines.length && isBlankLine(lines[start])) start += 1;
  let end = lines.length;
  while (end > start && isBlankLine(lines[end - 1])) end -= 1;
  return {
    leading: lines.slice(0, start).join(""),
    body: lines.slice(start, end).join(""),
    trailing: lines.slice(end).join(""),
  };
}

export interface ChatSegmentView {
  kind: "plain" | "fold";
  raw: string;
  stats?: FoldGroupStats;
  expanded?: boolean;
}

export interface RenderedSegment {
  text: string;
  /** 摘要行在本段换行后的行号（= 首部空行数）；plain 段无。 */
  headerRow?: number;
}

/**
 * 段的可见文本：折叠时只留摘要行，展开时摘要行 + 原文正文。
 * 首尾空行按原文保留，只替换中间——折叠前后段与段的间距保持一致。
 */
export function renderSegmentText(
  segment: ChatSegmentView,
  width: number,
  foldEnabled: boolean,
): RenderedSegment {
  if (segment.kind !== "fold" || !segment.stats || !foldEnabled) {
    return { text: segment.raw };
  }
  const { leading, body, trailing } = splitBlankEdges(segment.raw);
  const header = buildFoldHeader(segment.stats, width);
  const headerRow = (leading.match(/\n/g) ?? []).length;
  const text = segment.expanded
    ? `${leading}${header}\n${body}${trailing}`
    : `${leading}${header}\n${trailing}`;
  return { text, headerRow };
}
