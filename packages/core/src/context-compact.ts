import fs from "node:fs";
import path from "node:path";
import {
  AGENT_VERIFICATION_CONTEXT_END,
  AGENT_VERIFICATION_CONTEXT_START,
} from "./agent-manager.js";
import { DEFAULT_COMPACTION_TOKEN_THRESHOLD } from "./context-policy.js";
import {
  formatSkillActivationContext,
  SKILL_CONTEXT_START,
  stripSkillActivationContext,
} from "./skill-context.js";
import { validateToolCall } from "./tool-call-validation.js";
import type { ChatMessage } from "./types.js";

export interface CompactionResult {
  messages: ChatMessage[];
  originalChars: number;
  compactedChars: number;
  originalTokens: number;
  compactedTokens: number;
  freedPercentage: number;
  layersApplied: string[];
  summaryMode: "none" | "model" | "fallback";
  /** 模型摘要失败的原因（仅 `summaryMode` 为 `fallback` 时存在）：用来回答「为什么降级」。 */
  summaryError?: string;
}

/**
 * 摘要失败原因的单行摘要：折叠空白并截断，供提示与落盘共用。
 * 上游错误常带多行堆栈或整段响应体，原样打印会冲掉对话区。
 */
export function describeSummaryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (!oneLine) return "未知错误";
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/** `compactHistory` 的结果：压缩后的消息与摘要失败原因分开给，调用方不必自己 catch。 */
export interface CompactHistoryResult {
  messages: ChatMessage[];
  /** 模型摘要失败的原因；摘要成功或未注入摘要模型时缺省。 */
  summaryError?: string;
}

/** 估算消息数组的总字符数（粗略 4 字符 ≈ 1 Token） */
export function estimateMessagesChars(messages: ChatMessage[]): number {
  let len = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      len += m.content.length;
    } else if (Array.isArray(m.content)) {
      len += JSON.stringify(m.content).length;
    }
  }
  return len;
}

/**
 * 启发式估算单个文本片段的 Token 数。
 * 针对 CJK(中日韩字符)、ASCII 英文/数字、代码标点/缩进分别加权估算。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let asciiCount = 0;
  let codeSymbolCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK 统一表意字符区间
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      cjkCount++;
    } else if (code <= 127) {
      // 常见代码标点、缩进、换行
      if (
        code === 32 ||
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 33 && code <= 47) ||
        (code >= 58 && code <= 64) ||
        (code >= 91 && code <= 96) ||
        (code >= 123 && code <= 126)
      ) {
        codeSymbolCount++;
      } else {
        asciiCount++;
      }
    } else {
      cjkCount++;
    }
  }

  // CJK 字符约 0.7 Token/字；ASCII 字母数字约 0.25 Token/字；代码标点与缩进约 0.5 Token/字
  return Math.ceil(cjkCount * 0.7 + asciiCount * 0.25 + codeSymbolCount * 0.5);
}

export interface EstimateMessagesTokensOptions {
  includeSystem?: boolean;
}

/**
 * 启发式估算消息数组的总 Token 数。
 * 默认不包含系统提示词 (role === 'system') 开销，以便新对话初始显示为 0。
 * 结合文本加权估算与 Message Header 固定开销 (每条消息约 4 Tokens)。
 */
export function estimateMessagesTokens(
  messages: ChatMessage[],
  options: EstimateMessagesTokensOptions | boolean = {},
): number {
  const includeSystem = typeof options === "boolean" ? options : (options.includeSystem ?? false);
  let totalTokens = 0;
  for (const m of messages) {
    if (!includeSystem && m.role === "system") {
      continue;
    }
    totalTokens += 4; // 消息 Protocol 额外开销
    if (typeof m.content === "string") {
      totalTokens += estimateTextTokens(m.content);
    } else if (Array.isArray(m.content)) {
      totalTokens += estimateTextTokens(JSON.stringify(m.content));
    }
    if (m.tool_calls) {
      totalTokens += estimateTextTokens(JSON.stringify(m.tool_calls));
    }
  }
  return totalTokens;
}

/**
 * 修复工具调用配对：默认删除不完整交换，供压缩裁剪使用。
 * 故障恢复可选择保留合法调用和已有结果，将缺失回执标记为状态未知。
 * 每条调用后必须恰好有一个对应结果；非法参数仍按默认规则移除。
 */
export function repairToolCallPairs(
  messages: ChatMessage[],
  options: { preserveIncomplete?: boolean } = {},
): ChatMessage[] {
  const repaired: ChatMessage[] = [];
  let changed = false;

  for (let i = 0; i < messages.length; ) {
    const message = messages[i];
    const toolCalls =
      message.role === "assistant" && Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (toolCalls.length > 0) {
      const callsAreValid = toolCalls.every((call) => validateToolCall(call).valid);
      const expectedIds = toolCalls.map((call) => call.id).filter(Boolean);
      const expected = new Set(expectedIds);
      const seen = new Set<string>();
      const validToolMessages: ChatMessage[] = [];
      let cursor = i + 1;

      while (cursor < messages.length && messages[cursor].role === "tool") {
        const toolMessage = messages[cursor];
        const toolCallId = toolMessage.tool_call_id;
        if (toolCallId && expected.has(toolCallId) && !seen.has(toolCallId)) {
          seen.add(toolCallId);
          validToolMessages.push(toolMessage);
        } else {
          changed = true;
        }
        cursor += 1;
      }

      const complete =
        callsAreValid &&
        expectedIds.length === toolCalls.length &&
        expected.size === toolCalls.length &&
        seen.size === expected.size;
      if (complete) {
        repaired.push(message, ...validToolMessages);
      } else if (
        options.preserveIncomplete &&
        callsAreValid &&
        expectedIds.length === toolCalls.length &&
        expected.size === toolCalls.length
      ) {
        // 故障恢复保留已完成结果；缺回执不代表没有执行，不能自动重放写操作。
        // 压缩裁剪仍采用默认删除语义，避免把主动裁剪误报成故障。
        changed = true;
        repaired.push(message, ...validToolMessages);
        for (const id of expectedIds) {
          if (!seen.has(id)) {
            repaired.push({
              role: "tool",
              tool_call_id: id,
              content:
                "[工具执行状态未知：上次会话中断，未保存此调用的结果。操作可能已执行；请先核实文件或外部状态，再决定是否重试，勿直接重复写入或外部操作。]",
            });
          }
        }
      } else {
        changed = true;
        if (message.content.trim() || message.reasoning_content) {
          const preservedMessage = { ...message };
          delete preservedMessage.tool_calls;
          repaired.push(preservedMessage);
        }
      }
      i = cursor;
      continue;
    }

    if (message.role === "tool") {
      changed = true;
      i += 1;
      continue;
    }

    repaired.push(message);
    i += 1;
  }

  return changed ? repaired : messages;
}

function stripAgentVerificationContext(content: string): string {
  let stripped = content;
  while (true) {
    const start = stripped.indexOf(AGENT_VERIFICATION_CONTEXT_START);
    if (start < 0) return stripped;
    const end = stripped.indexOf(AGENT_VERIFICATION_CONTEXT_END, start);
    if (end < 0) return stripped.slice(0, start).trimEnd();
    const before = stripped.slice(0, start).trimEnd();
    const after = stripped.slice(end + AGENT_VERIFICATION_CONTEXT_END.length).trimStart();
    stripped = [before, after].filter(Boolean).join("\n\n");
  }
}

function collectAgentVerificationContext(messages: ChatMessage[]): string {
  const fragments = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system" || typeof message.content !== "string") continue;
    let cursor = 0;
    while (true) {
      const start = message.content.indexOf(AGENT_VERIFICATION_CONTEXT_START, cursor);
      if (start < 0) break;
      const bodyStart = start + AGENT_VERIFICATION_CONTEXT_START.length;
      const end = message.content.indexOf(AGENT_VERIFICATION_CONTEXT_END, bodyStart);
      if (end < 0) break;
      const body = message.content.slice(bodyStart, end).trim();
      if (body) fragments.add(body);
      cursor = end + AGENT_VERIFICATION_CONTEXT_END.length;
    }

    const legacyAgentResult =
      /^(?:\[系统手动 Agent 结果\]|\[系统后台 Agent 通知\]|\[强制验证门禁\])/.test(
        message.content,
      ) && /(?:尚未|仍未).*验证/.test(message.content);
    if (legacyAgentResult) fragments.add(message.content.trim());
  }
  if (fragments.size === 0) return "";
  return [AGENT_VERIFICATION_CONTEXT_START, ...fragments, AGENT_VERIFICATION_CONTEXT_END].join(
    "\n\n",
  );
}

/**
 * L1: tool_result_budget（大工具结果落盘 - 0 API）
 * 检查最后一条消息或近几条消息中超大 tool_result（如超 150KB），将文本落盘至 .haji/task_outputs/
 */
export function toolResultBudget(messages: ChatMessage[], maxBytes = 150_000): ChatMessage[] {
  const outputDir = path.join(process.cwd(), ".haji", "task_outputs");
  let totalLen = 0;
  for (const m of messages) {
    if (m.role === "tool" && typeof m.content === "string") {
      totalLen += m.content.length;
    }
  }

  if (totalLen <= maxBytes) return messages;

  const result = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  let changed = false;

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch {}

  for (let i = result.length - 1; i >= 0; i--) {
    const m = result[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > 5000) {
      const toolCallId = m.tool_call_id || `tool_${Date.now()}_${i}`;
      const filePath = path.join(outputDir, `${toolCallId}.txt`);
      try {
        fs.writeFileSync(filePath, m.content, "utf-8");
        const preview = m.content.slice(0, 1500);
        m.content = `<persisted-output path="${filePath}">\n${preview}\n... [超大输出 (${m.content.length} 字节) 已持久化落盘至 ${filePath}] ...\n</persisted-output>`;
        changed = true;
      } catch {}
    }
  }

  return changed ? result : messages;
}

export interface SnipCompactOptions {
  /**
   * 保护最后一个用户回合：从最后一条 user 消息起的内容一律不裁。
   * 回合内压缩需要它——当前回合的 prompt 与工具交换还在进行中，被裁掉会让模型
   * 丢失「刚才在做什么」；用户提交时的压缩会先拆出 pendingTurn，无需这个保护。
   */
  protectLastUserTurn?: boolean;
}

/**
 * L2: snip_compact（裁切无关联中间旧对话 - 0 API）
 * 当消息条数超过阈值时，保留头部 3 条与尾部 20 条，切除中间旧消息。
 */
export function snipCompact(
  messages: ChatMessage[],
  maxMessages = 40,
  options: SnipCompactOptions = {},
): ChatMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }

  const result = [...messages];
  const headEnd = 3;
  let tailStart = messages.length - 20;

  if (options.protectLastUserTurn) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        tailStart = Math.min(tailStart, index);
        break;
      }
    }
  }

  if (tailStart <= headEnd) {
    return messages;
  }

  // 保护成对不拆散规则：不能在 tool 结果中间切开
  while (tailStart < messages.length && messages[tailStart].role === "tool") {
    tailStart++;
  }

  const snippedCount = tailStart - headEnd;
  if (snippedCount <= 0) return messages;

  const placeholder: ChatMessage = {
    role: "user",
    content: `[已裁切中间 ${snippedCount} 条历史对话]`,
  };

  return repairToolCallPairs([
    ...result.slice(0, headEnd),
    placeholder,
    ...result.slice(tailStart),
  ]);
}

/**
 * L3: micro_compact（旧工具输出占位 - 0 API）
 * 仅保留最近 3 条 tool_result 的完整内容，更早的旧 tool_result 占位替换
 */
export function microCompact(messages: ChatMessage[], keepRecentCount = 3): ChatMessage[] {
  const toolIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      toolIndices.push(i);
    }
  }

  if (toolIndices.length <= keepRecentCount) {
    return messages;
  }

  const result = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  let changed = false;
  const toCompactIndices = toolIndices.slice(0, toolIndices.length - keepRecentCount);
  for (const idx of toCompactIndices) {
    const msg = result[idx];
    if (typeof msg.content === "string" && msg.content.length > 120) {
      msg.content = "[早期工具执行结果已自动占位，必要时可重新读取]";
      changed = true;
    }
  }

  return changed ? result : messages;
}

/**
 * 压缩摘要写进系统提示词时使用的分节标记：刷新提示词、以及 /resume 回放
 * 压缩记录都靠它定位「摘要从哪里开始」。
 */
export const COMPACTED_SUMMARY_MARKER = "\n\n[Compacted Context Summary]";
/** 摘要后面紧跟的「压缩前完整轨迹」行前缀（compactHistory 写入）。 */
const TRANSCRIPT_HINT_PREFIX = "\n完整压缩前记录：";

export interface CompactedContextRecord {
  /** 系统提示词里的结构化摘要正文（已剔除技能/Agent 验证等附加分片）。 */
  summary: string;
  /** 压缩前完整轨迹文件；没有落盘时缺省。 */
  transcriptPath?: string;
}

/**
 * 从系统提示词尾部拆出压缩摘要与压缩前轨迹路径；没压缩过时返回 undefined。
 * 老会话没有压缩元数据时，/resume 与生成压缩记录都靠它兜底。
 */
export function readCompactedContext(systemContent: string): CompactedContextRecord | undefined {
  const markerIndex = systemContent.indexOf(COMPACTED_SUMMARY_MARKER);
  if (markerIndex < 0) return undefined;
  const suffix = systemContent.slice(markerIndex + COMPACTED_SUMMARY_MARKER.length);
  const hintIndex = suffix.indexOf(TRANSCRIPT_HINT_PREFIX);
  // 摘要正文止于第一个附加分片（轨迹提示 / 技能激活 / Agent 验证上下文）。
  const boundaries = [
    hintIndex,
    suffix.indexOf(SKILL_CONTEXT_START),
    suffix.indexOf(AGENT_VERIFICATION_CONTEXT_START),
  ].filter((index) => index >= 0);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : suffix.length;
  const summary = suffix.slice(0, end).trim();
  const transcriptPath =
    hintIndex >= 0
      ? suffix
          .slice(hintIndex + TRANSCRIPT_HINT_PREFIX.length)
          .split(/\r?\n/, 1)[0]
          ?.trim() || undefined
      : undefined;
  return { summary, ...(transcriptPath ? { transcriptPath } : {}) };
}

/**
 * 为模型摘要拼 JSONL 记录。
 *
 * 完整历史可能远超摘要模型的上下文：实测一次压缩的完整记录约 178 万 tokens，
 * 而模型上限 104 万，摘要调用直接失败、退化成「本地降级摘要」。这里按预算保留
 * 「最早的几条（当前目标与最初要求）+ 最近的若干条（最新进展）」，中间用一行
 * 省略标注代替；完整记录仍由 compactHistory 落盘，摘要丢掉细节可以回查轨迹。
 */
export function buildSummaryTranscript(
  messages: ChatMessage[],
  options: { budgetTokens?: number } = {},
): string {
  const budget = Math.max(2_000, Math.trunc(options.budgetTokens ?? 120_000));
  // 单条超过预算 1/4（巨型工具结果、整份文件）先截断正文，否则它会把整条记录挤爆。
  const maxEntryCost = Math.max(200, Math.floor(budget * 0.25));
  const keepChars = Math.min(4_000, Math.max(200, Math.floor(maxEntryCost / 0.8)));
  const entries = messages.map((message, index) => {
    let line = JSON.stringify({ index, ...message });
    let cost = estimateTextTokens(line) + 4;
    if (cost > maxEntryCost) {
      const content =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? "");
      line = JSON.stringify({
        index,
        role: message.role,
        content: `${content.slice(0, keepChars)}…（该条过长，正文已截断；完整内容见压缩前轨迹）`,
      });
      cost = estimateTextTokens(line) + 4;
    }
    return { line, cost };
  });
  const totalCost = entries.reduce((sum, entry) => sum + entry.cost, 0);
  if (totalCost <= budget) return entries.map((entry) => entry.line).join("\n");

  // 头部 25% 给「最初的任务与约束」，尾部 70% 给「最近的进展」，其余留给省略标注。
  const headBudget = Math.floor(budget * 0.25);
  const tailBudget = budget - headBudget - 64;
  const head: string[] = [];
  let headUsed = 0;
  let headCount = 0;
  for (const entry of entries) {
    if (headUsed + entry.cost > headBudget) break;
    head.push(entry.line);
    headUsed += entry.cost;
    headCount++;
  }

  const tail: string[] = [];
  let tailUsed = 0;
  let tailStart = entries.length;
  for (let i = entries.length - 1; i >= headCount; i--) {
    const entry = entries[i]!;
    if (tailUsed + entry.cost > tailBudget) break;
    tail.unshift(entry.line);
    tailUsed += entry.cost;
    tailStart = i;
  }

  const omitted = tailStart - headCount;
  const marker =
    omitted > 0
      ? JSON.stringify({
          index: -1,
          role: "system",
          content: `（中间省略 ${omitted} 条较早消息；完整记录已落盘，可用 history 工具按「压缩前」检索）`,
        })
      : "";
  return [...head, ...(marker ? [marker] : []), ...tail].join("\n");
}

/**
 * L4: compact_history（全量结构化摘要 - 1 API 或本地备份）
 * 完整轨迹存盘至 .haji/transcripts/，并替换为 5 项结构化摘要
 */
export async function compactHistory(
  messages: ChatMessage[],
  summaryProvider?: (messages: ChatMessage[]) => Promise<string>,
  recentSource: ChatMessage[] = messages,
): Promise<CompactHistoryResult> {
  const transcriptDir = path.join(process.cwd(), ".haji", "transcripts");
  let transcriptPath = "";
  try {
    fs.mkdirSync(transcriptDir, { recursive: true });
    transcriptPath = path.join(transcriptDir, `transcript_${Date.now()}.jsonl`);
    const jsonlContent = messages.map((m) => JSON.stringify(m)).join("\n");
    fs.writeFileSync(transcriptPath, jsonlContent, "utf-8");
  } catch {}

  let summaryText = "";
  let summaryError: string | undefined;
  if (summaryProvider) {
    try {
      summaryText = await summaryProvider(messages);
      if (!summaryText.trim()) {
        throw new Error("摘要模型返回了空内容");
      }
    } catch (error) {
      // 降级仍然继续，但原因必须带出去：否则用户只看到「本地降级摘要」，无从判断是额度、限流还是超长。
      summaryError = describeSummaryError(error);
      summaryText = generateFallbackSummary(messages);
    }
  } else {
    summaryText = generateFallbackSummary(messages);
  }

  const originalSystemMsg = messages.find((m) => m.role === "system") || {
    role: "system",
    content: "你是一个高效的 AI 辅助编程助手。",
  };
  const agentVerificationContext = collectAgentVerificationContext(messages);
  const summaryMarker = COMPACTED_SUMMARY_MARKER;
  const cleanSystemContent = stripSkillActivationContext(
    stripAgentVerificationContext(originalSystemMsg.content),
  );
  const markerIndex = cleanSystemContent.indexOf(summaryMarker);
  const baseSystemContent =
    markerIndex >= 0 ? cleanSystemContent.slice(0, markerIndex) : cleanSystemContent;
  const transcriptHint = transcriptPath ? `${TRANSCRIPT_HINT_PREFIX}${transcriptPath}` : "";
  const skillActivationContext = formatSkillActivationContext(messages);
  const systemMsg: ChatMessage = {
    ...originalSystemMsg,
    content: `${baseSystemContent}${summaryMarker}\n\n${summaryText}${transcriptHint}${skillActivationContext ? `\n\n${skillActivationContext}` : ""}${agentVerificationContext ? `\n\n${agentVerificationContext}` : ""}`,
  };
  const recentMessages = selectRecentConversation(recentSource, 2);

  return {
    messages: repairToolCallPairs([systemMsg, ...recentMessages]),
    ...(summaryError ? { summaryError } : {}),
  };
}

function selectRecentConversation(messages: ChatMessage[], userTurns: number): ChatMessage[] {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  if (userIndices.length === 0) return [];

  const start = userIndices[Math.max(0, userIndices.length - userTurns)];
  return JSON.parse(
    JSON.stringify(messages.slice(start).filter((m) => m.role !== "system")),
  ) as ChatMessage[];
}

function generateFallbackSummary(messages: ChatMessage[]): string {
  const userMsgs = messages.filter((m) => m.role === "user" && typeof m.content === "string");
  const toolMsgs = messages.filter((m) => m.role === "tool");

  return [
    "【当前核心目标】与用户协同完成代码开发任务",
    `【历史消息统计】共对话 ${messages.length} 轮，包含 ${userMsgs.length} 条用户指令与 ${toolMsgs.length} 次工具调用`,
    `【最近需求】${userMsgs
      .slice(-2)
      .map((m) => String(m.content))
      .join("; ")}`,
    "【已知约束与偏好】遵循 AGENTS.md 规范，最小化变动，代码清晰易读",
  ].join("\n\n");
}

/**
 * 运行四层渐进式上下文压缩管线 (Pipeline)。
 */
export async function runCompactionPipeline(
  messages: ChatMessage[],
  options: {
    forceL4?: boolean;
    maxTokensThreshold?: number;
    summaryProvider?: (msgs: ChatMessage[]) => Promise<string>;
    /**
     * 回合内压缩时置 true：L2 裁剪不切断最后一个用户回合，
     * 避免正在进行中的 prompt 与工具交换被当成「中间旧对话」裁掉。
     */
    protectLastUserTurn?: boolean;
  } = {},
): Promise<CompactionResult> {
  const originalChars = estimateMessagesChars(messages);
  const originalTokens = estimateMessagesTokens(messages, { includeSystem: true });
  const layersApplied: string[] = [];
  const fullMessages = repairToolCallPairs(messages);
  let currentMessages = fullMessages;
  let summaryMode: CompactionResult["summaryMode"] = "none";
  let summaryError: string | undefined;

  if (fullMessages !== messages) {
    layersApplied.push("协议:工具调用配对修复");
  }

  // L1: 大结果落盘
  const l1Messages = toolResultBudget(currentMessages);
  if (l1Messages !== currentMessages) {
    layersApplied.push("L1:大结果落盘");
    currentMessages = l1Messages;
  }

  const threshold = Math.max(
    1,
    Math.trunc(options.maxTokensThreshold ?? DEFAULT_COMPACTION_TOKEN_THRESHOLD),
  );
  const currentTokens = estimateMessagesTokens(currentMessages, { includeSystem: true });

  // L4: 全量结构化摘要
  if (options.forceL4 || currentTokens > threshold) {
    // L2/L3 只作为 L4 的“最近对话保留集”预处理。
    // 完整历史会先落盘并交给摘要模型，不再出现无摘要直接丢弃中间消息。
    let recentMessages = currentMessages;
    const l2Messages = snipCompact(recentMessages, 40, {
      protectLastUserTurn: options.protectLastUserTurn,
    });
    if (l2Messages !== recentMessages) {
      layersApplied.push("L2:中间对话裁剪");
      recentMessages = l2Messages;
    }
    const l3Messages = microCompact(recentMessages);
    if (l3Messages !== recentMessages) {
      layersApplied.push("L3:旧工具输出占位");
      recentMessages = l3Messages;
    }

    let modelSummaryCompleted = false;
    const summaryProvider = options.summaryProvider
      ? async (sourceMessages: ChatMessage[]) => {
          const summary = await options.summaryProvider!(sourceMessages);
          if (!summary.trim()) throw new Error("摘要模型返回了空内容");
          modelSummaryCompleted = true;
          return summary;
        }
      : undefined;
    const compacted = await compactHistory(fullMessages, summaryProvider, recentMessages);
    currentMessages = compacted.messages;
    summaryError = compacted.summaryError;
    summaryMode = modelSummaryCompleted ? "model" : "fallback";
    layersApplied.push(modelSummaryCompleted ? "L4:模型结构化摘要" : "L4:本地降级摘要");
  }

  const pairedMessages = repairToolCallPairs(currentMessages);
  if (pairedMessages !== currentMessages) {
    layersApplied.push("协议:工具调用配对修复");
    currentMessages = pairedMessages;
  }
  const compactedChars = estimateMessagesChars(currentMessages);
  const compactedTokens = estimateMessagesTokens(currentMessages, { includeSystem: true });
  const freedPercentage = Math.max(
    0,
    Math.round(((originalChars - compactedChars) / Math.max(1, originalChars)) * 1000) / 10,
  );

  return {
    messages: currentMessages,
    originalChars,
    compactedChars,
    originalTokens,
    compactedTokens,
    freedPercentage,
    layersApplied,
    summaryMode,
    ...(summaryError ? { summaryError } : {}),
  };
}
