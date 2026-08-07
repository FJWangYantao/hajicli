import { ModelProvider, ChatMessage, CompletionOptions, ProviderError, withExponentialBackoff, normalizeAbortError, findInvalidToolCall } from '@hajicli/core';
import { fetchWithNetworkPolicy, getModelTimeoutMs } from './network.js';
import { OpenAICompatibleResponseData, parseOpenAICompatibleStream } from './openai-stream.js';

export interface DeepSeekConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class DeepSeekProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(config: DeepSeekConfig = {}) {
    const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new ProviderError('DeepSeek API key is missing. Please set DEEPSEEK_API_KEY environment variable or pass it to constructor.', 'deepseek');
    }
    this.apiKey = apiKey;
    this.baseUrl = config.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    this.defaultModel = config.defaultModel || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    const response = await this.request(messages, { ...options, stream: false });
    const data = await response.json() as OpenAICompatibleResponseData;
    if (data.error) {
      throw new ProviderError(data.error.message || 'API error', 'deepseek', response.status);
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

  async *completeStream(messages: ChatMessage[], options: CompletionOptions = {}): AsyncGenerator<string, void, unknown> {
    const response = await this.request(messages, { ...options, stream: true });
    yield* parseOpenAICompatibleStream(response, {
      provider: 'deepseek',
      emptyBodyMessage: 'Response body is empty',
      completion: options
    });
  }

  private async request(messages: ChatMessage[], options: CompletionOptions): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const invalidToolCall = findInvalidToolCall(messages);
    if (invalidToolCall) {
      throw new ProviderError(
        `本地拒绝发送损坏的历史工具调用（消息 ${invalidToolCall.messageIndex + 1}）：${invalidToolCall.error}`,
        'deepseek'
      );
    }
    
    const requestMessages = messages.map(msg => {
      const payloadMsg: any = {
        role: msg.role,
        content: msg.content
      };
      if (msg.tool_calls) {
        payloadMsg.tool_calls = msg.tool_calls.map(tc => ({
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

    const payload: any = {
      model: options.model || this.defaultModel,
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
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(payload),
          signal: options.abortSignal
        }, { timeoutMs: getModelTimeoutMs() });

        if (!response.ok) {
          let errorMsg = `HTTP error! status: ${response.status}`;
          try {
            const errData = await response.json() as { error?: { message?: string } };
            if (errData.error?.message) {
              errorMsg = errData.error.message;
            }
          } catch {
            // 忽略解析错误
          }
          throw new ProviderError(errorMsg, 'deepseek', response.status);
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
        const msg = isTimeout ? '网络请求超时 (60s)，DeepSeek API 未在规定时间内响应。' : (error instanceof Error ? error.message : String(error));
        throw new ProviderError(msg, 'deepseek');
      }
    }, { maxRetries: 3, initialDelayMs: 1000, providerName: 'deepseek' });
  }
}
