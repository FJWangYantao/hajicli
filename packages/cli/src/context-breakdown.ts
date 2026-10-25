/**
 * 上下文占用按类别拆分：给右侧栏的分类堆叠条与 hover 明细提供数据。
 *
 * 估算口径必须与 core 的 estimateMessagesTokens 完全一致（每条消息 4 tokens
 * 协议开销 + 正文/工具调用 JSON 的文本估算），否则分项之和会和侧栏显示的
 * 总量对不上，用户看到的条和环就会互相矛盾。
 *
 * 分类是启发式的：工具消息只有 tool_call_id，需要回溯前一条 assistant 的
 * tool_calls 拿到工具名，再按工具名归到「文件/记忆/结果」。测试读不到工具
 * 结果的实际内容类型，所以 bash cat 一个文件仍然记在「结果」里。
 */
import { type ChatMessage, estimateTextTokens, type ToolDefinition } from "@hajicli/core";

/** 上下文分类：与侧栏图例、hover 明细一一对应。 */
export type ContextCategory =
  | "system"
  | "tools"
  | "memory"
  | "file"
  | "toolResult"
  | "conversation";

/** 各类别占用的估算 tokens；顺序即图例与堆叠条的绘制顺序。 */
export interface ContextBreakdown extends Record<ContextCategory, number> {}

/** 绘制顺序固定，避免同一份数据在两次渲染里换色。 */
export const CONTEXT_CATEGORIES: readonly ContextCategory[] = [
  "system",
  "tools",
  "memory",
  "file",
  "toolResult",
  "conversation",
];

/** 侧栏宽度有限，标签保持 2 个汉字。 */
export const CONTEXT_CATEGORY_LABELS: Readonly<Record<ContextCategory, string>> = {
  system: "系统",
  tools: "工具",
  memory: "记忆",
  file: "文件",
  toolResult: "结果",
  conversation: "对话",
};

/** 读取文件内容类工具：结果计入「文件」。 */
const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "global", "projectinfo"]);

/** 技能/记忆注入类工具：结果计入「记忆」。 */
const MEMORY_TOOLS: ReadonlySet<string> = new Set([
  "loadskill",
  "listskillresources",
  "readskillresource",
]);

/** 每条消息的协议固定开销，与 estimateMessagesTokens 保持一致。 */
const MESSAGE_PROTOCOL_TOKENS = 4;

function categoryOfTool(toolName: string): ContextCategory {
  if (FILE_TOOLS.has(toolName)) return "file";
  if (MEMORY_TOOLS.has(toolName)) return "memory";
  return "toolResult";
}

/** 单条消息的 token 估算，逐分支对齐 estimateMessagesTokens。 */
function messageTokens(message: ChatMessage): number {
  let total = MESSAGE_PROTOCOL_TOKENS;
  if (typeof message.content === "string") {
    total += estimateTextTokens(message.content);
  } else if (Array.isArray(message.content)) {
    total += estimateTextTokens(JSON.stringify(message.content));
  }
  if (message.tool_calls) {
    total += estimateTextTokens(JSON.stringify(message.tool_calls));
  }
  return total;
}

/**
 * 工具定义的 tokens：整个 schema 序列化后估算。
 *
 * 只在工具名集合变化时重算——updateStatusUI 每轮/每次工具迭代都会调用，
 * 21 个 schema 反复 stringify 是笔白花的开销。工具定义在运行期是静态的，
 * 只有 MCP server 接入/移除会改变集合。
 */
let toolDefinitionCache: { key: string; tokens: number } | undefined;

export function estimateToolDefinitionsTokens(definitions: readonly ToolDefinition[]): number {
  if (definitions.length === 0) return 0;
  const key = definitions.map((definition) => definition.function?.name ?? "").join(",");
  if (toolDefinitionCache?.key === key) return toolDefinitionCache.tokens;
  const tokens = estimateTextTokens(JSON.stringify(definitions));
  toolDefinitionCache = { key, tokens };
  return tokens;
}

/**
 * 按类别统计上下文占用。
 *
 * 返回值之和 === estimateMessagesTokens(messages, { includeSystem: true })
 * + estimateToolDefinitionsTokens(definitions)。
 */
export function buildContextBreakdown(
  messages: readonly ChatMessage[],
  definitions: readonly ToolDefinition[] = [],
): ContextBreakdown {
  const totals: ContextBreakdown = {
    system: 0,
    tools: estimateToolDefinitionsTokens(definitions),
    memory: 0,
    file: 0,
    toolResult: 0,
    conversation: 0,
  };
  /** tool_call_id → 工具名：工具消息本身不带名字，只能靠前面的调用回溯。 */
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function?.name ?? "");
    }
    const tokens = messageTokens(message);
    if (message.role === "system") {
      totals.system += tokens;
    } else if (message.role === "tool") {
      totals[categoryOfTool(toolNames.get(message.tool_call_id ?? "") ?? "")] += tokens;
    } else {
      totals.conversation += tokens;
    }
  }
  return totals;
}

/** 分项合计：调用方据此与总量对齐、给剩余空间留位。 */
export function totalBreakdownTokens(breakdown: ContextBreakdown): number {
  return CONTEXT_CATEGORIES.reduce((sum, category) => sum + breakdown[category], 0);
}

/** 详情页里的一条注入项：一行标题 + 可滚动的原文。 */
export interface ContextItem {
  /** 展示用标题，如 `read AGENTS.md`、`工具定义 bash`。 */
  label: string;
  /** 该条占用的估算 tokens。 */
  tokens: number;
  /** 详情原文：工具入参与结果，或消息正文。 */
  detail: string;
  /** 在 messages 里的下标；页面据此跳回对话区。 */
  messageIndex?: number;
}

/** 一个分类下的全部条目；tokens 与 breakdown 分项严格相等。 */
export interface ContextItemGroup {
  category: ContextCategory;
  label: string;
  tokens: number;
  items: ContextItem[];
}

/** 参数里的关键字段：标题只取第一个有意义的字符串，避免整段 JSON 撑爆列表。 */
const ARG_HINT_KEYS = ["path", "command", "query", "pattern", "url", "name"] as const;
const ARG_HINT_MAX = 28;

/** 从工具入参 JSON 里抽一个短摘要（路径 / 命令 / 查询……），失败就返回空串。 */
function argumentHint(raw: string | undefined): string {
  if (!raw) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const record = parsed as Record<string, unknown>;
  for (const key of ARG_HINT_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const single = value.replace(/\s+/g, " ").trim();
    return single.length > ARG_HINT_MAX ? `${single.slice(0, ARG_HINT_MAX - 1)}…` : single;
  }
  return "";
}

/** 工具入参原文：能格式化就格式化，解析失败退回原始字符串。 */
function readableArguments(raw: string | undefined): string {
  if (!raw) return "(无参数)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * 让条目 tokens 之和等于分类分项：逐条估算与整体估算的差（JSON 分隔符、缓存口径等）
 * 按比例摊到各条，余数落在最后一条——页面上两个数字必须能对上，否则就是新的困惑来源。
 */
function reconcileTokens(tokens: readonly number[], target: number): number[] {
  if (tokens.length === 0) return [];
  if (target <= 0) return tokens.map(() => 0);
  const sum = tokens.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) {
    const out = tokens.map(() => 0);
    out[0] = target;
    return out;
  }
  const scaled = tokens.map((value) => Math.round((value * target) / sum));
  const settle = (): void => {
    const diff = target - scaled.reduce((acc, value) => acc + value, 0);
    if (diff === 0) return;
    for (let index = scaled.length - 1; index >= 0; index -= 1) {
      if (scaled[index] + diff >= 0) {
        scaled[index] += diff;
        return;
      }
    }
    scaled[0] = Math.max(0, scaled[0] + diff);
  };
  settle();
  return scaled;
}

/**
 * 把上下文拆成「分类 → 条目」，供详情页（点击侧栏圆环进入）使用。
 *
 * 与 buildContextBreakdown 共用同一套遍历与估算：分类 tokens 直接取分项，
 * 条目 tokens 按比例对齐到分项，因此页面上的合计永远等于侧栏圆环。
 */
export function buildContextItemGroups(
  messages: readonly ChatMessage[],
  definitions: readonly ToolDefinition[] = [],
): ContextItemGroup[] {
  const totals = buildContextBreakdown(messages, definitions);
  /** tool_call_id → 工具名与入参：工具消息本身不带这两样，只能回溯前面的调用。 */
  const calls = new Map<string, { name: string; args: string }>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      calls.set(call.id, {
        name: call.function?.name ?? "",
        args: call.function?.arguments ?? "",
      });
    }
  }

  const groups: Record<ContextCategory, ContextItem[]> = {
    system: [],
    tools: [],
    memory: [],
    file: [],
    toolResult: [],
    conversation: [],
  };
  /** 同角色条目的序号：列表里出现五个「助手回复」没法分辨是哪一条。 */
  const ordinals = { system: 0, user: 0, assistant: 0 };

  for (const definition of definitions) {
    const name = definition.function?.name ?? "(未命名工具)";
    groups.tools.push({
      label: `工具定义 ${name}`,
      tokens: estimateTextTokens(JSON.stringify([definition])),
      detail: JSON.stringify(definition, null, 2),
    });
  }

  messages.forEach((message, index) => {
    const tokens = messageTokens(message);
    if (message.role === "system") {
      ordinals.system += 1;
      groups.system.push({
        label: ordinals.system === 1 ? "系统提示词" : `系统提示词 #${ordinals.system}`,
        tokens,
        detail: message.content,
        messageIndex: index,
      });
      return;
    }
    if (message.role === "tool") {
      const call = calls.get(message.tool_call_id ?? "");
      const name = call?.name ?? "(未知工具)";
      const hint = argumentHint(call?.args);
      groups[categoryOfTool(call?.name ?? "")].push({
        label: hint ? `${name} ${hint}` : name,
        tokens,
        detail: `调用 ${name}\n${readableArguments(call?.args)}\n\n结果\n${message.content}`,
        messageIndex: index,
      });
      return;
    }
    const isUser = message.role === "user";
    if (isUser) ordinals.user += 1;
    else ordinals.assistant += 1;
    const label = isUser ? `用户 #${ordinals.user}` : `助手 #${ordinals.assistant}`;
    const attachments = message.attachments?.length
      ? `\n（附件 ${message.attachments.length} 个）`
      : "";
    groups.conversation.push({
      label,
      tokens,
      detail: `${message.content}${attachments}`,
      messageIndex: index,
    });
  });

  return CONTEXT_CATEGORIES.map((category) => {
    const items = groups[category];
    const scaled = reconcileTokens(
      items.map((item) => item.tokens),
      totals[category],
    );
    items.forEach((item, index) => {
      item.tokens = scaled[index] ?? 0;
    });
    if (items.length === 0 && totals[category] > 0) {
      items.push({
        label: "（无明细）",
        tokens: totals[category],
        detail: "这一类占用无法拆分到具体条目。",
      });
    }
    return {
      category,
      label: CONTEXT_CATEGORY_LABELS[category],
      tokens: totals[category],
      items,
    };
  });
}
