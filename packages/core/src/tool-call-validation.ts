import { ChatMessage, ToolCall } from './types.js';

export interface ToolCallValidationResult {
  valid: boolean;
  error?: string;
  arguments?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the protocol fields and JSON object expected for a function call. */
export function validateToolCall(toolCall: ToolCall): ToolCallValidationResult {
  if (!toolCall || typeof toolCall !== 'object') {
    return { valid: false, error: '工具调用不是对象' };
  }
  if (typeof toolCall.id !== 'string' || !toolCall.id.trim()) {
    return { valid: false, error: '工具调用缺少 id' };
  }
  if (toolCall.type !== 'function') {
    return { valid: false, error: `工具调用类型无效: ${String(toolCall.type)}` };
  }
  if (!toolCall.function || typeof toolCall.function.name !== 'string' || !toolCall.function.name.trim()) {
    return { valid: false, error: '工具调用缺少函数名' };
  }
  if (typeof toolCall.function.arguments !== 'string') {
    return { valid: false, error: '工具参数不是 JSON 字符串' };
  }

  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    if (!isRecord(parsed)) {
      return { valid: false, error: '工具参数必须是 JSON 对象' };
    }
    return { valid: true, arguments: parsed };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `工具参数 JSON 不完整或无效: ${detail}` };
  }
}

export function findInvalidToolCall(messages: ChatMessage[]): {
  messageIndex: number;
  toolCallIndex: number;
  toolCall: ToolCall;
  error: string;
} | null {
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const toolCalls = messages[messageIndex].tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
      const result = validateToolCall(toolCalls[toolCallIndex]);
      if (!result.valid) {
        return {
          messageIndex,
          toolCallIndex,
          toolCall: toolCalls[toolCallIndex],
          error: result.error || '未知工具调用错误'
        };
      }
    }
  }
  return null;
}
