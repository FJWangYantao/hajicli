import { ModelProvider, ChatMessage, CompletionOptions, ProviderError } from '@hajicli/core';

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
    this.defaultModel = config.defaultModel || 'deepseek-chat';
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    const response = await this.request(messages, { ...options, stream: false });
    const data = await response.json() as any;
    if (data.error) {
      throw new ProviderError(data.error.message || 'API error', 'deepseek', response.status);
    }
    return data.choices?.[0]?.message?.content || '';
  }

  async *completeStream(messages: ChatMessage[], options: CompletionOptions = {}): AsyncGenerator<string, void, unknown> {
    const response = await this.request(messages, { ...options, stream: true });
    
    if (!response.body) {
      throw new ProviderError('Response body is empty', 'deepseek', response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

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
            return;
          }
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            try {
              const data = JSON.parse(dataStr);
              const content = data.choices?.[0]?.delta?.content || '';
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
            const content = data.choices?.[0]?.delta?.content || '';
            if (content) {
              yield content;
            }
          } catch (e) {
            // 忽略错误
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async request(messages: ChatMessage[], options: CompletionOptions): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: options.model || this.defaultModel,
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: options.stream ?? false
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload)
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
      throw new ProviderError(error instanceof Error ? error.message : String(error), 'deepseek');
    }
  }
}
