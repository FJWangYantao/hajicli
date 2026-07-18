import { ModelProvider, ChatMessage, CompletionOptions, ProviderError, ToolCall, withExponentialBackoff } from '@hajicli/core';

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
    this.baseUrl = config.baseUrl || 'https://api.deepseek.com/v1';
    this.defaultModel = config.defaultModel || 'deepseek-v4-flash';
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    const response = await this.request(messages, { ...options, stream: false });
    const data = await response.json() as any;
    if (data.error) {
      throw new ProviderError(data.error.message || 'API error', 'deepseek', response.status);
    }
    
    const choice = data.choices?.[0];
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
    
    if (!response.body) {
      throw new ProviderError('Response body is empty', 'deepseek', response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const accumulatedToolCalls: any[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // 将最后一个不完整的行保留在缓冲区中
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === 'data: [DONE]') {
            break;
          }
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            try {
              const data = JSON.parse(dataStr);
              const choice = data.choices?.[0];
              
              // 收集流式工具调用
              const deltaToolCalls = choice?.delta?.tool_calls;
              if (deltaToolCalls) {
                for (const dtc of deltaToolCalls) {
                  const idx = dtc.index ?? 0;
                  if (!accumulatedToolCalls[idx]) {
                    accumulatedToolCalls[idx] = {
                      id: dtc.id || '',
                      type: dtc.type || 'function',
                      function: {
                        name: dtc.function?.name || '',
                        arguments: dtc.function?.arguments || ''
                      }
                    };
                  } else {
                    if (dtc.id) accumulatedToolCalls[idx].id = dtc.id;
                    if (dtc.function?.name) accumulatedToolCalls[idx].function.name = dtc.function.name;
                    if (dtc.function?.arguments) accumulatedToolCalls[idx].function.arguments += dtc.function.arguments;
                  }
                }
              }

              // 收集流式思考过程内容
              const reasoningContent = choice?.delta?.reasoning_content || '';
              if (reasoningContent && options.onReasoning) {
                options.onReasoning(reasoningContent);
              }

              // 收集流式 Token 用量
              if (data.usage && options.onUsage) {
                options.onUsage({
                  prompt_tokens: data.usage.prompt_tokens,
                  completion_tokens: data.usage.completion_tokens,
                  total_tokens: data.usage.total_tokens
                });
              }

              // 收集文本内容
              const content = choice?.delta?.content || '';
              if (content) {
                yield content;
              }
            } catch (e) {
              // 忽略不完整的行或 JSON 解析错误
            }
          }
        }
      }

      // 处理缓冲区中剩余的数据
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const choice = data.choices?.[0];
            const content = choice?.delta?.content || '';
            
            const deltaToolCalls = choice?.delta?.tool_calls;
            if (deltaToolCalls) {
              for (const dtc of deltaToolCalls) {
                const idx = dtc.index ?? 0;
                if (!accumulatedToolCalls[idx]) {
                  accumulatedToolCalls[idx] = {
                    id: dtc.id || '',
                    type: dtc.type || 'function',
                    function: {
                      name: dtc.function?.name || '',
                      arguments: dtc.function?.arguments || ''
                    }
                  };
                } else {
                  if (dtc.id) accumulatedToolCalls[idx].id = dtc.id;
                  if (dtc.function?.name) accumulatedToolCalls[idx].function.name = dtc.function.name;
                  if (dtc.function?.arguments) accumulatedToolCalls[idx].function.arguments += dtc.function.arguments;
                }
              }
            }
            
            // 收集流式思考过程内容
            const reasoningContent = choice?.delta?.reasoning_content || '';
            if (reasoningContent && options.onReasoning) {
              options.onReasoning(reasoningContent);
            }

            // 收集流式 Token 用量
            if (data.usage && options.onUsage) {
              options.onUsage({
                prompt_tokens: data.usage.prompt_tokens,
                completion_tokens: data.usage.completion_tokens,
                total_tokens: data.usage.total_tokens
              });
            }

            if (content) {
              yield content;
            }
          } catch (e) {
            // 忽略错误
          }
        }
      }

      // 如果收集到了工具调用，在结束前触发回调
      const finalToolCalls = accumulatedToolCalls.filter(Boolean);
      if (finalToolCalls.length > 0 && options.onToolCall) {
        options.onToolCall(finalToolCalls as ToolCall[]);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async request(messages: ChatMessage[], options: CompletionOptions): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    
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
      if (msg.reasoning_content) {
        payloadMsg.reasoning_content = msg.reasoning_content;
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
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60000)
        });

        if (!response.ok) {
          let errorMsg = `HTTP error! status: ${response.status}`;
          try {
            const errData = await response.json() as any;
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
        const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        const msg = isTimeout ? '网络请求超时 (60s)，DeepSeek API 未在规定时间内响应。' : (error instanceof Error ? error.message : String(error));
        throw new ProviderError(msg, 'deepseek');
      }
    }, { maxRetries: 3, initialDelayMs: 1000, providerName: 'deepseek' });
  }
}
