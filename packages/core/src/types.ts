/**
 * 聊天消息发送者的角色。
 */
export type ChatRole = 'system' | 'user' | 'assistant';

/**
 * 表示聊天历史记录中消息的接口。
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * 模型生成/补全的配置选项。
 */
export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
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
