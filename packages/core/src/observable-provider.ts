import * as crypto from 'node:crypto';
import { ModelProvider, ChatMessage, CompletionOptions, ToolCall } from './types.js';
import { SessionTracker } from './trace-logger.js';

/**
 * 无侵入包装的模型提供商，用于拦截并记录调用轨迹和统计指标。
 */
export class ObservableModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly tracker: SessionTracker
  ) {}

  /**
   * 针对给定的聊天历史生成非流式响应。
   */
  public async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    const startTime = Date.now();
    const model = options.model || 'unknown';
    
    let capturedToolCalls: ToolCall[] | undefined;
    let capturedReasoning = '';
    let capturedUsage: any;

    const interceptedOptions: CompletionOptions = {
      ...options,
      onToolCall: (toolCalls) => {
        capturedToolCalls = toolCalls;
        if (options.onToolCall) {
          options.onToolCall(toolCalls);
        }
      },
      onReasoning: (content) => {
        capturedReasoning += content;
        if (options.onReasoning) {
          options.onReasoning(content);
        }
      },
      onUsage: (usage) => {
        capturedUsage = usage;
        if (options.onUsage) {
          options.onUsage(usage);
        }
      }
    };

    try {
      const response = await this.inner.complete(messages, interceptedOptions);
      const endTime = Date.now();
      const duration = endTime - startTime;

      // 估算 Token 生成速度（非流式使用字符数估算）
      const totalChars = response.length + capturedReasoning.length;
      const speed = duration > 0 ? (totalChars / (duration / 1000)) : 0;

      this.tracker.recordLlmCall({
        id: crypto.randomUUID(),
        timestamp: new Date(startTime).toISOString(),
        model,
        messages,
        ttft: duration, // 非流式 TTFT 与总耗时相同
        duration,
        speed,
        reasoningContent: capturedReasoning || undefined,
        content: response,
        toolCalls: capturedToolCalls,
        usage: capturedUsage
      });

      return response;
    } catch (error) {
      const endTime = Date.now();
      this.tracker.recordLlmCall({
        id: crypto.randomUUID(),
        timestamp: new Date(startTime).toISOString(),
        model,
        messages,
        ttft: 0,
        duration: endTime - startTime,
        speed: 0,
        content: `Error: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  /**
   * 针对给定的聊天历史生成流式响应。
   */
  public async *completeStream(messages: ChatMessage[], options: CompletionOptions = {}): AsyncGenerator<string, void, unknown> {
    const startTime = Date.now();
    const model = options.model || 'unknown';
    
    let firstTokenTime = 0;
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let capturedToolCalls: ToolCall[] | undefined;
    let capturedUsage: any;

    const setFirstTokenTime = () => {
      if (firstTokenTime === 0) {
        firstTokenTime = Date.now();
      }
    };

    const interceptedOptions: CompletionOptions = {
      ...options,
      onToolCall: (toolCalls) => {
        capturedToolCalls = toolCalls;
        if (options.onToolCall) {
          options.onToolCall(toolCalls);
        }
      },
      onReasoning: (content) => {
        setFirstTokenTime();
        accumulatedReasoning += content;
        if (options.onReasoning) {
          options.onReasoning(content);
        }
      },
      onUsage: (usage) => {
        capturedUsage = usage;
        if (options.onUsage) {
          options.onUsage(usage);
        }
      }
    };

    const stream = this.inner.completeStream(messages, interceptedOptions);

    try {
      for await (const chunk of stream) {
        setFirstTokenTime();
        accumulatedContent += chunk;
        yield chunk;
      }
    } catch (error) {
      const endTime = Date.now();
      this.tracker.recordLlmCall({
        id: crypto.randomUUID(),
        timestamp: new Date(startTime).toISOString(),
        model,
        messages,
        ttft: firstTokenTime > 0 ? (firstTokenTime - startTime) : (endTime - startTime),
        duration: endTime - startTime,
        speed: 0,
        content: `Stream Error: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }

    const endTime = Date.now();
    const duration = endTime - startTime;
    const ttft = firstTokenTime > 0 ? (firstTokenTime - startTime) : duration;

    // 计算生成速度：如果有 usage 里的 token，用 token/s，否则用 字符/s
    let speed = 0;
    const generateDurationSec = (endTime - (firstTokenTime || startTime)) / 1000;
    if (generateDurationSec > 0) {
      if (capturedUsage && capturedUsage.completion_tokens) {
        speed = capturedUsage.completion_tokens / generateDurationSec;
      } else {
        const totalChars = accumulatedContent.length + accumulatedReasoning.length;
        speed = totalChars / generateDurationSec;
      }
    }

    this.tracker.recordLlmCall({
      id: crypto.randomUUID(),
      timestamp: new Date(startTime).toISOString(),
      model,
      messages,
      ttft,
      duration,
      speed,
      reasoningContent: accumulatedReasoning || undefined,
      content: accumulatedContent,
      toolCalls: capturedToolCalls,
      usage: capturedUsage
    });
  }
}
