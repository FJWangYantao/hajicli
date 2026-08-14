import { CompletionOptions, ProviderError, ToolCall } from '@hajicli/core';

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAICompatibleStreamData {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: StreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAICompatibleResponseData {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
    };
  }>;
  error?: {
    message?: string;
  };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIStreamParserOptions {
  provider: string;
  emptyBodyMessage: string;
  completion: CompletionOptions;
}

function mergeToolCallDeltas(
  accumulated: Array<ToolCall | undefined>,
  deltas: StreamToolCallDelta[] | undefined
): void {
  if (!deltas) return;
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    const current = accumulated[index];
    if (!current) {
      accumulated[index] = {
        id: delta.id || '',
        type: 'function',
        function: {
          name: delta.function?.name || '',
          arguments: delta.function?.arguments || ''
        }
      };
      continue;
    }
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.function.name = delta.function.name;
    if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
  }
}

/**
 * Parses the OpenAI-compatible SSE envelope shared by DeepSeek and Volcengine.
 * Malformed individual events are ignored because providers may split or inject
 * non-JSON keepalive frames; request-level and stream-level failures still throw.
 */
export async function* parseOpenAICompatibleStream(
  response: Response,
  parserOptions: OpenAIStreamParserOptions
): AsyncGenerator<string, void, unknown> {
  const { completion, provider, emptyBodyMessage } = parserOptions;
  if (!response.body) {
    throw new ProviderError(emptyBodyMessage, provider, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const toolCalls: Array<ToolCall | undefined> = [];
  let buffer = '';
  let finishReason: string | undefined;
  let streamDone = false;

  const consumeLine = (line: string): { content?: string; done?: boolean } => {
    const trimmed = line.trim();
    if (!trimmed) return {};
    if (trimmed === 'data: [DONE]') return { done: true };
    if (!trimmed.startsWith('data: ')) return {};

    try {
      const data = JSON.parse(trimmed.slice(6)) as OpenAICompatibleStreamData;
      const choice = data.choices?.[0];
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
      mergeToolCallDeltas(toolCalls, choice?.delta?.tool_calls);

      const reasoning = choice?.delta?.reasoning_content || '';
      if (reasoning) completion.onReasoning?.(reasoning);
      if (data.usage) completion.onUsage?.(data.usage);

      const content = choice?.delta?.content || '';
      return content ? { content } : {};
    } catch {
      return {};
    }
  };

  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const event = consumeLine(line);
        if (event.done) {
          streamDone = true;
          break;
        }
        if (event.content) yield event.content;
      }
    }

    if (!streamDone && buffer.trim()) {
      const event = consumeLine(buffer);
      if (event.content) yield event.content;
    }

    completion.onFinish?.({ reason: finishReason });
    const completedToolCalls = toolCalls.filter((toolCall): toolCall is ToolCall => Boolean(toolCall));
    if (completedToolCalls.length > 0) completion.onToolCall?.(completedToolCalls);
  } finally {
    reader.releaseLock();
  }
}
