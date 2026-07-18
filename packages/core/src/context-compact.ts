import fs from 'node:fs';
import path from 'node:path';
import { ChatMessage } from './types.js';

export interface CompactionResult {
  messages: ChatMessage[];
  originalChars: number;
  compactedChars: number;
  freedPercentage: number;
  layersApplied: string[];
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
 * L1: tool_result_budget（大工具结果落盘 - 0 API）
 * 检查最后一条消息或近几条消息中超大 tool_result（如超 150KB），将文本落盘至 .haji/task_outputs/
 */
export function toolResultBudget(messages: ChatMessage[], maxBytes = 150_000): ChatMessage[] {
  const result = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  const lastMsg = result[result.length - 1];
  if (!lastMsg || lastMsg.role !== 'tool') return result;

  const outputDir = path.join(process.cwd(), '.haji', 'task_outputs');
  let totalLen = 0;
  for (const m of result) {
    if (m.role === 'tool' && typeof m.content === 'string') {
      totalLen += m.content.length;
    }
  }

  if (totalLen <= maxBytes) return result;

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
      } catch {}
    }
  }

  return result;
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

  return [...result.slice(0, headEnd), placeholder, ...result.slice(tailStart)];
}

/**
 * L3: micro_compact（旧工具输出占位 - 0 API）
 * 仅保留最近 3 条 tool_result 的完整内容，更早的旧 tool_result 占位替换
 */
export function microCompact(messages: ChatMessage[], keepRecentCount = 3): ChatMessage[] {
  const result = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  const toolIndices: number[] = [];

  for (let i = 0; i < result.length; i++) {
    if (result[i].role === 'tool') {
      toolIndices.push(i);
    }
  }

  if (toolIndices.length <= keepRecentCount) {
    return result;
  }

  const toCompactIndices = toolIndices.slice(0, toolIndices.length - keepRecentCount);
  for (const idx of toCompactIndices) {
    const msg = result[idx];
    if (typeof msg.content === 'string' && msg.content.length > 120) {
      msg.content = '[早期工具执行结果已自动占位，必要时可重新读取]';
    }
  }

  return result;
}

/**
 * L4: compact_history（全量结构化摘要 - 1 API 或本地备份）
 * 完整轨迹存盘至 .haji/transcripts/，并替换为 5 项结构化摘要
 */
export async function compactHistory(
  messages: ChatMessage[],
  summaryProvider?: (messages: ChatMessage[]) => Promise<string>
): Promise<ChatMessage[]> {
  const transcriptDir = path.join(process.cwd(), '.haji', 'transcripts');
  try {
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, `transcript_${Date.now()}.jsonl`);
    const jsonlContent = messages.map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(transcriptPath, jsonlContent, 'utf-8');
  } catch {}

  let summaryText = '';
  if (summaryProvider) {
    try {
      summaryText = await summaryProvider(messages);
    } catch {
      summaryText = generateFallbackSummary(messages);
    }
  } else {
    summaryText = generateFallbackSummary(messages);
  }

  const systemMsg = messages.find(m => m.role === 'system') || {
    role: 'system',
    content: '你是一个高效的 AI 辅助编程助手。'
  };

  const compactedUserMsg: ChatMessage = {
    role: 'user',
    content: `[Compacted Context Summary]\n\n${summaryText}`
  };

  return [systemMsg, compactedUserMsg];
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
    currentMessages = await compactHistory(currentMessages, options.summaryProvider);
    layersApplied.push('L4:全量结构化摘要');
  }

  const compactedChars = estimateMessagesChars(currentMessages);
  const freedPercentage = Math.max(0, Math.round(((originalChars - compactedChars) / Math.max(1, originalChars)) * 1000) / 10);

  return {
    messages: currentMessages,
    originalChars,
    compactedChars,
    freedPercentage,
    layersApplied
  };
}
