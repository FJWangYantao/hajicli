/**
 * 表示工具调用详情的接口。
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 表示大模型工具定义的接口。
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 通用工具执行契约接口。
 */
export interface BaseTool {
  name: string;
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * 聊天消息发送者的角色。
 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 表示聊天历史记录中消息的接口。
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * 模型生成/补全的配置选项。
 */
export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  reasoningEffort?: ReasoningEffort;
  thinking?: boolean;
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
  onToolCall?: (toolCalls: ToolCall[]) => void;
  /**
   * 接收大模型流式或非流式输出中的思考过程（如推理内容）。
   */
  onReasoning?: (content: string) => void;
  /**
   * 接收大模型本次调用的 token 消耗统计。
   */
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
}

/**
 * 模型 API 提供商的抽象接口。
 */
export interface ModelProvider {
  /**
   * 针对给定的聊天历史生成非流式响应。
   * @param messages - 表示上下文的聊天消息数组。
   * @param options - 生成配置项。
   */
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;

  /**
   * 针对给定的聊天历史生成流式响应。
   * @param messages - 表示上下文的聊天消息数组。
   * @param options - 生成配置项。
   */
  completeStream(messages: ChatMessage[], options?: CompletionOptions): AsyncGenerator<string, void, unknown>;
}

/**
 * hajicli 的基础自定义错误类。
 */
export class HajiError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'HajiError';
  }
}

/**
 * 模型提供商抛出的特定错误。
 */
export class ProviderError extends HajiError {
  constructor(message: string, public readonly provider: string, public readonly status?: number) {
    super(message, 'PROVIDER_ERROR');
    this.name = 'ProviderError';
  }
}

/**
 * 控制系统提示词的任务分析与验证强度。
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/**
 * 判断输入是否为受支持的思考强度。
 */
export function isReasoningEffort(value: string | undefined): value is ReasoningEffort {
  return Boolean(value && REASONING_EFFORTS.includes(value as ReasoningEffort));
}

/**
 * 生成系统提示词的上下文。
 */
export interface PromptContext {
  cwd: string;
  os: string;
  tools?: string[];
  vars?: Record<string, string>;
  reasoningEffort?: ReasoningEffort;
}

/**
 * 单个系统提示词分片。
 */
export interface SystemPromptPart {
  id: string;
  priority: number;
  getContent(context: PromptContext): Promise<string> | string;
}
