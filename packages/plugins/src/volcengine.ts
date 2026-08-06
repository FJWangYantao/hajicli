import { ModelProvider, ChatMessage, CompletionOptions, ProviderError, withExponentialBackoff, normalizeAbortError, findInvalidToolCall } from '@hajicli/core';
import { fetchWithNetworkPolicy } from './network.js';
import { OpenAICompatibleResponseData, parseOpenAICompatibleStream } from './openai-stream.js';

/**
 * 火山引擎方舟 (Volcengine Ark) 提供商配置接口。
 */
export interface VolcengineConfig {
  /**
   * 火山引擎 API 密钥（方舟 API Key）。
   * 若不传，则默认读取环境变量 VOLC_API_KEY 或 ARK_API_KEY。
   */
  apiKey?: string;

  /**
   * API 基础服务地址。
   * 默认为 https://ark.cn-beijing.volces.com/api/v3。
   */
  baseUrl?: string;

  /**
   * 默认推理接入点 ID（Endpoint ID），例如 ep-2025xxxxxx-xxxxx。
   */
  defaultModel?: string;
}

/**
 * 火山引擎方舟 (Volcengine Ark) 大模型提供商实现。
 */
export class VolcengineProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(config: VolcengineConfig = {}) {
    const apiKey = config.apiKey || process.env.VOLC_API_KEY || process.env.ARK_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        '火山引擎 API Key 缺失。请设置 VOLC_API_KEY 或 ARK_API_KEY 环境变量，或在构造函数中传入 apiKey。',
        'volcengine'
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = config.baseUrl || process.env.VOLC_BASE_URL || process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3';
    this.defaultModel = config.defaultModel || process.env.VOLC_MODEL || process.env.ARK_MODEL || 'glm-5.2';
  }

  /**
   * 针对给定的聊天历史生成非流式响应。
   * @param messages - 表示上下文的聊天消息数组。
   * @param options - 生成配置项。
   */
  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    const response = await this.request(messages, { ...options, stream: false });
    const data = (await response.json()) as OpenAICompatibleResponseData;

    if (data.error) {
      throw new ProviderError(data.error.message || '火山引擎 API 返回错误', 'volcengine', response.status);
    }

    const choice = data.choices?.[0];
    options.onFinish?.({ reason: choice?.finish_reason || undefined });
    if (choice?.message?.tool_calls && options.onToolCall) {
      options.onToolCall(choice.message.tool_calls);
    }

    // 捕获思考内容并分发
    if (choice?.message?.reasoning_content && options.onReasoning) {
      options.onReasoning(choice.message.reasoning_content);
    }

    // 捕获 Token 用量并分发
    if (data.usage && options.onUsage) {
      options.onUsage({
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens
      });
    }

    return choice?.message?.content || '';
  }

  /**
   * 针对给定的聊天历史生成流式响应。
   * @param messages - 表示上下文的聊天消息数组。
   * @param options - 生成配置项。
   */
  async *completeStream(
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    const response = await this.request(messages, { ...options, stream: true });
    yield* parseOpenAICompatibleStream(response, {
      provider: 'volcengine',
      emptyBodyMessage: '响应体为空',
      completion: options
    });
  }

  private async request(messages: ChatMessage[], options: CompletionOptions): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const modelToUse = options.model || this.defaultModel;

    if (!modelToUse) {
      throw new ProviderError(
        '未指定模型接入点 Endpoint ID。请设置 VOLC_MODEL 环境变量，或在调用 complete/completeStream 时传入 model 参数。',
        'volcengine'
      );
    }

    const invalidToolCall = findInvalidToolCall(messages);
    if (invalidToolCall) {
      throw new ProviderError(
        `本地拒绝发送损坏的历史工具调用（消息 ${invalidToolCall.messageIndex + 1}）：${invalidToolCall.error}`,
        'volcengine'
      );
    }

    interface RequestPayloadMessage {
      role: string;
      content: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
      tool_call_id?: string;
      reasoning_content?: string;
    }

    const requestMessages: RequestPayloadMessage[] = messages.map((msg) => {
      const payloadMsg: RequestPayloadMessage = {
        role: msg.role,
        content: msg.content
      };
      if (msg.tool_calls) {
        payloadMsg.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        }));
      }
      if (msg.tool_call_id) {
        payloadMsg.tool_call_id = msg.tool_call_id;
      }
      if (
        msg.reasoning_content !== undefined
        || (options.thinking === true && msg.role === 'assistant' && Boolean(msg.tool_calls?.length))
      ) {
        payloadMsg.reasoning_content = msg.reasoning_content ?? '';
      }
      return payloadMsg;
    });

    interface RequestPayload {
      model: string;
      messages: RequestPayloadMessage[];
      temperature?: number;
      max_tokens?: number;
      stream: boolean;
      stream_options?: { include_usage: boolean };
      tools?: unknown[];
      thinking?: { type: string };
      reasoning_effort?: string;
    }

    const payload: RequestPayload = {
      model: modelToUse,
      messages: requestMessages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: options.stream ?? false
    };

    if (payload.stream) {
      payload.stream_options = { include_usage: true };
    }

    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
    }
    if (options.thinking !== undefined) {
      payload.thinking = { type: options.thinking ? 'enabled' : 'disabled' };
    }
    if (options.reasoningEffort) {
      payload.reasoning_effort = options.reasoningEffort;
    }

    return withExponentialBackoff(async () => {
      try {
        const response = await fetchWithNetworkPolicy(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(payload),
          signal: options.abortSignal
        });

        if (!response.ok) {
          let errorMsg = `HTTP 错误！状态码: ${response.status}`;
          try {
            const errData = (await response.json()) as { error?: { message?: string } };
            if (errData.error?.message) {
              errorMsg = errData.error.message;
            }
          } catch {
            // 忽略 JSON 解析错误
          }
          throw new ProviderError(errorMsg, 'volcengine', response.status);
        }

        return response;
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error;
        }
        if (options.abortSignal?.aborted) {
          const reason = options.abortSignal.reason;
          throw reason instanceof Error && reason.name === 'TimeoutError'
            ? reason
            : normalizeAbortError(error);
        }
        const isTimeout = error instanceof Error && error.name === 'TimeoutError';
        const msg = isTimeout ? '网络请求超时 (60s)，大模型 API 未在规定时间内响应。' : (error instanceof Error ? error.message : String(error));
        throw new ProviderError(msg, 'volcengine');
      }
    }, { maxRetries: 3, initialDelayMs: 1000, providerName: 'volcengine' });
  }
}
