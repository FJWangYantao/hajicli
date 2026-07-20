import fs from 'node:fs';
import path from 'node:path';
import { ChatMessage } from './types.js';
import {
  AGENT_VERIFICATION_CONTEXT_END,
  AGENT_VERIFICATION_CONTEXT_START
} from './agent-manager.js';

export interface CompactionResult {
  messages: ChatMessage[];
  originalChars: number;
  compactedChars: number;
  freedPercentage: number;
  layersApplied: string[];
  summaryMode: 'none' | 'model' | 'fallback';
}

/** 估算消息数组的总字符数（粗略 4 字符 ≈ 1 Token） */
export function estimateMessagesChars(messages: ChatMessage[]): number {
  let len = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
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
      if (code === 32 || code === 9 || code === 10 || code === 13 || (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) {
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

/**
 * 启发式估算消息数组的总 Token 数。
 * 默认不包含系统提示词 (role === 'system') 开销，以便新对话初始显示为 0。
 * 结合文本加权估算与 Message Header 固定开销 (每条消息约 4 Tokens)。
 */
export function estimateMessagesTokens(messages: ChatMessage[], includeSystem = false): number {
  let totalTokens = 0;
  for (const m of messages) {
    if (!includeSystem && m.role === 'system') {
      continue;
    }
    totalTokens += 4; // 消息 Protocol 额外开销
    if (typeof m.content === 'string') {
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
 * Removes protocol-invalid tool exchanges without inventing tool results.
 * A tool-calling assistant message is valid only when the immediately following
 * tool messages contain exactly one result for every declared tool call ID.
 */
export function repairToolCallPairs(messages: ChatMessage[]): ChatMessage[] {
  const repaired: ChatMessage[] = [];
  let changed = false;

  for (let i = 0; i < messages.length;) {
    const message = messages[i];
    const toolCalls = message.role === 'assistant' && Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];

    if (toolCalls.length > 0) {
      const expectedIds = toolCalls.map(call => call.id).filter(Boolean);
      const expected = new Set(expectedIds);
      const seen = new Set<string>();
      const validToolMessages: ChatMessage[] = [];
      let cursor = i + 1;

      while (cursor < messages.length && messages[cursor].role === 'tool') {
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

      const complete = expectedIds.length === toolCalls.length
        && expected.size === toolCalls.length
        && seen.size === expected.size;
      if (complete) {
        repaired.push(message, ...validToolMessages);
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

    if (message.role === 'tool') {
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
    stripped = [before, after].filter(Boolean).join('\n\n');
  }
}

function collectAgentVerificationContext(messages: ChatMessage[]): string {
  const fragments = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'system' || typeof message.content !== 'string') continue;
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

    const legacyAgentResult = /^(?:\[系统手动 Agent 结果\]|\[系统后台 Agent 通知\]|\[强制验证门禁\])/.test(message.content)
      && /(?:尚未|仍未).*验证/.test(message.content);
    if (legacyAgentResult) fragments.add(message.content.trim());
  }
  if (fragments.size === 0) return '';
  return [
    AGENT_VERIFICATION_CONTEXT_START,
    ...fragments,
    AGENT_VERIFICATION_CONTEXT_END
  ].join('\n\n');
}

/**
 * L1: tool_result_budget（大工具结果落盘 - 0 API）
 * 检查最后一条消息或近几条消息中超大 tool_result（如超 150KB），将文本落盘至 .haji/task_outputs/
 */
export function toolResultBudget(messages: ChatMessage[], maxBytes = 150_000): ChatMessage[] {
  const outputDir = path.join(process.cwd(), '.haji', 'task_outputs');
  let totalLen = 0;
  for (const m of messages) {
    if (m.role === 'tool' && typeof m.content === 'string') {
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
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 5000) {
      const toolCallId = m.tool_call_id || `tool_${Date.now()}_${i}`;
      const filePath = path.join(outputDir, `${toolCallId}.txt`);
      try {
        fs.writeFileSync(filePath, m.content, 'utf-8');
        const preview = m.content.slice(0, 1500);
        m.content = `<persisted-output path="${filePath}">\n${preview}\n... [超大输出 (${m.content.length} 字节) 已持久化落盘至 ${filePath}] ...\n</persisted-output>`;
        changed = true;
      } catch {}
    }
  }

  return changed ? result : messages;
}

/**
 * L2: snip_compact（裁切无关联中间旧对话 - 0 API）
 * 当消息条数超过阈值时，保留头部 3 条与尾部 20 条，切除中间旧消息。
 */
export function snipCompact(messages: ChatMessage[], maxMessages = 40): ChatMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }

  const result = [...messages];
  let headEnd = 3;
  let tailStart = messages.length - 20;

  if (tailStart <= headEnd) {
    return messages;
  }

  // 保护成对不拆散规则：不能在 tool 结果中间切开
  while (tailStart < messages.length && messages[tailStart].role === 'tool') {
    tailStart++;
  }

  const snippedCount = tailStart - headEnd;
  if (snippedCount <= 0) return messages;

  const placeholder: ChatMessage = {
    role: 'user',
    content: `[已裁切中间 ${snippedCount} 条历史对话]`
  };

  return repairToolCallPairs([...result.slice(0, headEnd), placeholder, ...result.slice(tailStart)]);
}

/**
 * L3: micro_compact（旧工具输出占位 - 0 API）
 * 仅保留最近 3 条 tool_result 的完整内容，更早的旧 tool_result 占位替换
 */
export function microCompact(messages: ChatMessage[], keepRecentCount = 3): ChatMessage[] {
  const toolIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
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
    if (typeof msg.content === 'string' && msg.content.length > 120) {
      msg.content = '[早期工具执行结果已自动占位，必要时可重新读取]';
      changed = true;
    }
  }

  return changed ? result : messages;
}

/**
 * L4: compact_history（全量结构化摘要 - 1 API 或本地备份）
 * 完整轨迹存盘至 .haji/transcripts/，并替换为 5 项结构化摘要
 */
export async function compactHistory(
  messages: ChatMessage[],
  summaryProvider?: (messages: ChatMessage[]) => Promise<string>,
  recentSource: ChatMessage[] = messages
): Promise<ChatMessage[]> {
  const transcriptDir = path.join(process.cwd(), '.haji', 'transcripts');
  let transcriptPath = '';
  try {
    fs.mkdirSync(transcriptDir, { recursive: true });
    transcriptPath = path.join(transcriptDir, `transcript_${Date.now()}.jsonl`);
    const jsonlContent = messages.map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(transcriptPath, jsonlContent, 'utf-8');
  } catch {}

  let summaryText = '';
  if (summaryProvider) {
    try {
      summaryText = await summaryProvider(messages);
      if (!summaryText.trim()) {
        throw new Error('摘要模型返回了空内容');
      }
    } catch {
      summaryText = generateFallbackSummary(messages);
    }
  } else {
    summaryText = generateFallbackSummary(messages);
  }

  const originalSystemMsg = messages.find(m => m.role === 'system') || {
    role: 'system',
    content: '你是一个高效的 AI 辅助编程助手。'
  };
  const agentVerificationContext = collectAgentVerificationContext(messages);
  const summaryMarker = '\n\n[Compacted Context Summary]';
  const cleanSystemContent = stripAgentVerificationContext(originalSystemMsg.content);
  const markerIndex = cleanSystemContent.indexOf(summaryMarker);
  const baseSystemContent = markerIndex >= 0
    ? cleanSystemContent.slice(0, markerIndex)
    : cleanSystemContent;
  const transcriptHint = transcriptPath ? `\n完整压缩前记录：${transcriptPath}` : '';
  const systemMsg: ChatMessage = {
    ...originalSystemMsg,
    content: `${baseSystemContent}${summaryMarker}\n\n${summaryText}${transcriptHint}${agentVerificationContext ? `\n\n${agentVerificationContext}` : ''}`
  };
  const recentMessages = selectRecentConversation(recentSource, 2);

  return repairToolCallPairs([systemMsg, ...recentMessages]);
}

function selectRecentConversation(messages: ChatMessage[], userTurns: number): ChatMessage[] {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndices.push(i);
  }
  if (userIndices.length === 0) return [];

  const start = userIndices[Math.max(0, userIndices.length - userTurns)];
  return JSON.parse(JSON.stringify(messages.slice(start).filter(m => m.role !== 'system'))) as ChatMessage[];
}

function generateFallbackSummary(messages: ChatMessage[]): string {
  const userMsgs = messages.filter(m => m.role === 'user' && typeof m.content === 'string');
  const toolMsgs = messages.filter(m => m.role === 'tool');

  return [
    '【当前核心目标】与用户协同完成代码开发任务',
    `【历史消息统计】共对话 ${messages.length} 轮，包含 ${userMsgs.length} 条用户指令与 ${toolMsgs.length} 次工具调用`,
    `【最近需求】${userMsgs.slice(-2).map(m => String(m.content)).join('; ')}`,
    '【已知约束与偏好】遵循 AGENTS.md 规范，最小化变动，代码清晰易读'
  ].join('\n\n');
}

/**
 * 运行四层渐进式上下文压缩管线 (Pipeline)。
 */
export async function runCompactionPipeline(
  messages: ChatMessage[],
  options: {
    forceL4?: boolean;
    maxCharsThreshold?: number;
    summaryProvider?: (msgs: ChatMessage[]) => Promise<string>;
  } = {}
): Promise<CompactionResult> {
  const originalChars = estimateMessagesChars(messages);
  const layersApplied: string[] = [];
  let currentMessages = messages;
  let summaryMode: CompactionResult['summaryMode'] = 'none';

  // L1: 大结果落盘
  const l1Messages = toolResultBudget(currentMessages);
  if (l1Messages !== currentMessages) {
    layersApplied.push('L1:大结果落盘');
    currentMessages = l1Messages;
  }

  // L2: 裁切中间旧对话
  const l2Messages = snipCompact(currentMessages);
  if (l2Messages !== currentMessages) {
    layersApplied.push('L2:中间对话裁剪');
    currentMessages = l2Messages;
  }

  // L3: 旧工具结果占位
  const l3Messages = microCompact(currentMessages);
  if (l3Messages !== currentMessages) {
    layersApplied.push('L3:旧工具输出占位');
    currentMessages = l3Messages;
  }

  const threshold = options.maxCharsThreshold ?? 60_000;
  const currentChars = estimateMessagesChars(currentMessages);

  // L4: 全量结构化摘要
  if (options.forceL4 || currentChars > threshold) {
    let modelSummaryCompleted = false;
    const summaryProvider = options.summaryProvider
      ? async (sourceMessages: ChatMessage[]) => {
          const summary = await options.summaryProvider!(sourceMessages);
          if (!summary.trim()) throw new Error('摘要模型返回了空内容');
          modelSummaryCompleted = true;
          return summary;
        }
      : undefined;
    currentMessages = await compactHistory(messages, summaryProvider, currentMessages);
    summaryMode = modelSummaryCompleted ? 'model' : 'fallback';
    layersApplied.push(modelSummaryCompleted ? 'L4:模型结构化摘要' : 'L4:本地降级摘要');
  }

  const pairedMessages = repairToolCallPairs(currentMessages);
  if (pairedMessages !== currentMessages) {
    layersApplied.push('协议:工具调用配对修复');
    currentMessages = pairedMessages;
  }
  const compactedChars = estimateMessagesChars(currentMessages);
  const freedPercentage = Math.max(0, Math.round(((originalChars - compactedChars) / Math.max(1, originalChars)) * 1000) / 10);

  return {
    messages: currentMessages,
    originalChars,
    compactedChars,
    freedPercentage,
    layersApplied,
    summaryMode
  };
}
