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
