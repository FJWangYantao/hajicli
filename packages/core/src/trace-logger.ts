import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ChatMessage, ToolCall } from './types.js';
import { performanceMonitor } from './performance-monitor.js';

const TRACE_FLUSH_DELAY_MS = 40;
const TRACE_MESSAGE_LIMIT = 12;
const TRACE_TEXT_LIMIT = 12_000;
const TRACE_ARGUMENT_LIMIT = 8_000;

/** 大模型调用指标与轨迹接口。 */
export interface TraceLlmCall {
  id: string;
  timestamp: string;
  model: string;
  messages: ChatMessage[];
  messageCount?: number;
  omittedMessageCount?: number;
  ttft: number;
  duration: number;
  speed: number;
  reasoningContent?: string;
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface TraceToolExecution {
  timestamp: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  approved: boolean;
  output?: string;
  duration?: number;
}

export type TraceEvent =
  | { type: 'user_input'; timestamp: string; content: string }
  | { type: 'llm_call'; timestamp: string; data: TraceLlmCall }
  | { type: 'tool_execution'; timestamp: string; data: TraceToolExecution };

export interface TraceSession {
  id: string;
  startTime: string;
  endTime?: string;
  events: TraceEvent[];
}

interface TraceMeta {
  version: 2;
  id: string;
  startTime: string;
  endTime?: string;
  eventCount: number;
  modelUsed: string;
}

function truncateText(value: string | undefined, limit = TRACE_TEXT_LIMIT): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[Trace 已截断 ${value.length - limit} 字符，完整内容仍保存在会话记录中]`;
}

function compactToolCall(toolCall: ToolCall): ToolCall {
  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: truncateText(toolCall.function.arguments, TRACE_ARGUMENT_LIMIT) || '{}'
    }
  };
}

function compactMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: truncateText(message.content) || '',
    reasoning_content: truncateText(message.reasoning_content, 4_000),
    tool_calls: message.tool_calls?.map(compactToolCall)
  };
}

function compactMessages(messages: ChatMessage[]): {
  messages: ChatMessage[];
  omittedMessageCount: number;
} {
  if (messages.length <= TRACE_MESSAGE_LIMIT) {
    return { messages: messages.map(compactMessage), omittedMessageCount: 0 };
  }
  const firstSystem = messages.find(message => message.role === 'system');
  const tail = messages.slice(-(TRACE_MESSAGE_LIMIT - (firstSystem ? 1 : 0)));
  const selected = firstSystem && tail[0] !== firstSystem ? [firstSystem, ...tail] : tail;
  return {
    messages: selected.map(compactMessage),
    omittedMessageCount: Math.max(0, messages.length - selected.length)
  };
}

function compactArguments(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(args);
    if (serialized.length <= TRACE_ARGUMENT_LIMIT) return args;
    return {
      _traceTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, TRACE_ARGUMENT_LIMIT)
    };
  } catch {
    return { _traceTruncated: true, preview: '[无法序列化工具参数]' };
  }
}

function compactEvent(event: TraceEvent): TraceEvent {
  if (event.type === 'user_input') {
    return { ...event, content: truncateText(event.content) || '' };
  }
  if (event.type === 'tool_execution') {
    return {
      ...event,
      data: {
        ...event.data,
        arguments: compactArguments(event.data.arguments),
        output: truncateText(event.data.output)
      }
    };
  }
  const compacted = compactMessages(event.data.messages);
  return {
    ...event,
    data: {
      ...event.data,
      messages: compacted.messages,
      messageCount: event.data.messages.length,
      omittedMessageCount: compacted.omittedMessageCount || undefined,
      reasoningContent: truncateText(event.data.reasoningContent),
      content: truncateText(event.data.content) || '',
      toolCalls: event.data.toolCalls?.map(compactToolCall)
    }
  };
}

async function replaceFile(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch {
    await fs.copyFile(source, target);
    await fs.rm(source, { force: true });
  }
}

/** Append-only trace writer. New sessions use a small meta file plus JSONL events. */
export class SessionTracker {
  private readonly tracesDir: string;
  private readonly meta: TraceMeta;
  private readonly metaPath: string;
  private readonly eventsPath: string;
  private pendingLines: string[] = [];
  private writeChain: Promise<void>;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(tracesDir: string = path.join(process.cwd(), '.haji', 'traces')) {
    this.tracesDir = tracesDir;
    const id = crypto.randomUUID();
    this.meta = {
      version: 2,
      id,
      startTime: new Date().toISOString(),
      eventCount: 0,
      modelUsed: 'unknown'
    };
    this.metaPath = path.join(tracesDir, `session_${id}.meta.json`);
    this.eventsPath = path.join(tracesDir, `session_${id}.events.jsonl`);
    this.writeChain = this.initialize();
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.tracesDir, { recursive: true });
    await this.writeMeta();
  }

  private async writeMeta(): Promise<void> {
    const tempPath = `${this.metaPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.meta), 'utf8');
    await replaceFile(tempPath, this.metaPath);
  }

  private append(event: TraceEvent): void {
    const startedAt = performance.now();
    const compacted = compactEvent(event);
    this.pendingLines.push(`${JSON.stringify(compacted)}\n`);
    performanceMonitor.record('trace.serialize', performance.now() - startedAt);
    this.meta.eventCount += 1;
    if (compacted.type === 'llm_call' && this.meta.modelUsed === 'unknown') {
      this.meta.modelUsed = compacted.data.model;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, TRACE_FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const lines = this.pendingLines.splice(0);
    if (lines.length > 0) {
      this.writeChain = this.writeChain.then(async () => {
        const startedAt = performance.now();
        await fs.appendFile(this.eventsPath, lines.join(''), 'utf8');
        await this.writeMeta();
        performanceMonitor.record('trace.flush', performance.now() - startedAt);
      }).catch(() => {});
    }
    await this.writeChain;
    if (this.pendingLines.length > 0) await this.flush();
  }

  public getSessionId(): string {
    return this.meta.id;
  }

  public recordUserInput(content: string): void {
    this.append({ type: 'user_input', timestamp: new Date().toISOString(), content });
  }

  public recordLlmCall(data: TraceLlmCall): void {
    this.append({ type: 'llm_call', timestamp: data.timestamp, data });
  }

  public recordToolExecution(
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    approved: boolean,
    output?: string,
    duration?: number
  ): void {
    const timestamp = new Date().toISOString();
    this.append({
      type: 'tool_execution',
      timestamp,
      data: { timestamp, toolCallId, name, arguments: args, approved, output, duration }
    });
  }

  public async save(): Promise<string> {
    this.meta.endTime = new Date().toISOString();
    await this.flush();
    await this.writeMeta();
    return this.metaPath;
  }

  public static async readSession(
    id: string,
    tracesDir: string = path.join(process.cwd(), '.haji', 'traces')
  ): Promise<TraceSession | null> {
    const metaPath = path.join(tracesDir, `session_${id}.meta.json`);
    const eventsPath = path.join(tracesDir, `session_${id}.events.jsonl`);
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as TraceMeta;
      let events: TraceEvent[] = [];
      try {
        const raw = await fs.readFile(eventsPath, 'utf8');
        events = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as TraceEvent);
      } catch {}
      return { id: meta.id, startTime: meta.startTime, endTime: meta.endTime, events };
    } catch {}

    try {
      return JSON.parse(await fs.readFile(path.join(tracesDir, `session_${id}.json`), 'utf8')) as TraceSession;
    } catch {
      return null;
    }
  }

  public static async listSessions(
    tracesDir: string = path.join(process.cwd(), '.haji', 'traces')
  ): Promise<Array<{ id: string; startTime: string; endTime?: string; eventCount: number; modelUsed: string }>> {
    try {
      await fs.mkdir(tracesDir, { recursive: true });
      const files = await fs.readdir(tracesDir);
      const list = new Map<string, { id: string; startTime: string; endTime?: string; eventCount: number; modelUsed: string }>();

      for (const file of files.filter(name => /^session_[a-f0-9-]+\.meta\.json$/.test(name))) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(tracesDir, file), 'utf8')) as TraceMeta;
          list.set(meta.id, {
            id: meta.id,
            startTime: meta.startTime,
            endTime: meta.endTime,
            eventCount: meta.eventCount,
            modelUsed: meta.modelUsed
          });
        } catch {}
      }

      for (const file of files.filter(name => /^session_[a-f0-9-]+\.json$/.test(name))) {
        try {
          const data = JSON.parse(await fs.readFile(path.join(tracesDir, file), 'utf8')) as TraceSession;
          if (list.has(data.id)) continue;
          const firstCall = data.events.find(event => event.type === 'llm_call');
          list.set(data.id, {
            id: data.id,
            startTime: data.startTime,
            endTime: data.endTime,
            eventCount: data.events.length,
            modelUsed: firstCall?.type === 'llm_call' ? firstCall.data.model : 'unknown'
          });
        } catch {}
      }

      return [...list.values()].sort((left, right) => (
        new Date(right.startTime).getTime() - new Date(left.startTime).getTime()
      ));
    } catch {
      return [];
    }
  }
}
