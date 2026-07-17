import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ChatMessage, ToolCall } from './types.js';

/**
 * 大模型调用指标与轨迹接口。
 */
export interface TraceLlmCall {
  id: string;
  timestamp: string;
  model: string;
  messages: ChatMessage[];
  ttft: number; // 首字延迟时间（毫秒）
  duration: number; // 完整调用用时（毫秒）
  speed: number; // 输出 Token 或字符生成速度（字/秒）
  reasoningContent?: string; // 思考过程内容
  content: string; // 最终回答
  toolCalls?: ToolCall[]; // 触发的工具调用
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 工具执行指标与轨迹接口。
 */
export interface TraceToolExecution {
  timestamp: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  approved: boolean;
  output?: string;
  duration?: number; // 执行用时（毫秒）
}

/**
 * 单个 Trace 事件类型。
 */
export type TraceEvent =
  | { type: 'user_input'; timestamp: string; content: string }
  | { type: 'llm_call'; timestamp: string; data: TraceLlmCall }
  | { type: 'tool_execution'; timestamp: string; data: TraceToolExecution };

/**
 * 会话追踪结构体定义。
 */
export interface TraceSession {
  id: string;
  startTime: string;
  endTime?: string;
  events: TraceEvent[];
}

/**
 * 会话可观测性事件流追踪器。
 */
export class SessionTracker {
  private readonly session: TraceSession;
  private readonly tracesDir: string;

  constructor(tracesDir: string = path.join(process.cwd(), '.haji', 'traces')) {
    this.tracesDir = tracesDir;
    this.session = {
      id: crypto.randomUUID(),
      startTime: new Date().toISOString(),
      events: []
    };
    // 创建会话时立即存盘一次，方便 Web 界面秒级呈现活跃会话
    this.persist().catch(() => {});
  }

  /**
   * 将当前会话数据实时写盘，实现“实时更新能看”。
   */
  private async persist(): Promise<void> {
    try {
      await fs.mkdir(this.tracesDir, { recursive: true });
      const filePath = path.join(this.tracesDir, `session_${this.session.id}.json`);
      await fs.writeFile(filePath, JSON.stringify(this.session, null, 2), 'utf-8');
    } catch {
      // 静默捕获写入异常，防止写盘失败崩溃影响核心 Agent 流程
    }
  }

  /**
   * 获取当前 Session 的 ID。
   */
  public getSessionId(): string {
    return this.session.id;
  }

  /**
   * 记录用户输入事件。
   * @param content - 用户输入的文本内容。
   */
  public recordUserInput(content: string): void {
    this.session.events.push({
      type: 'user_input',
      timestamp: new Date().toISOString(),
      content
    });
    this.persist().catch(() => {});
  }

  /**
   * 记录大模型调用事件。
   * @param data - 大模型调用指标详情。
   */
  public recordLlmCall(data: TraceLlmCall): void {
    this.session.events.push({
      type: 'llm_call',
      timestamp: data.timestamp,
      data
    });
    this.persist().catch(() => {});
  }

  /**
   * 记录工具执行事件。
   * @param toolCallId - 触发该执行的工具调用 ID。
   * @param name - 工具名称。
   * @param args - 执行入参。
   * @param approved - 是否经过用户授权允许执行。
   * @param output - 工具的控制台返回结果。
   * @param duration - 执行消耗时长。
   */
  public recordToolExecution(
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    approved: boolean,
    output?: string,
    duration?: number
  ): void {
    this.session.events.push({
      type: 'tool_execution',
      timestamp: new Date().toISOString(),
      data: {
        timestamp: new Date().toISOString(),
        toolCallId,
        name,
        arguments: args,
        approved,
        output,
        duration
      }
    });
    this.persist().catch(() => {});
  }

  /**
   * 将当前追踪会话序列化写入到本地的 JSON 文件中（标记结束）。
   * @returns 写入的本地文件绝对路径。
   */
  public async save(): Promise<string> {
    this.session.endTime = new Date().toISOString();
    await this.persist();
    return path.join(this.tracesDir, `session_${this.session.id}.json`);
  }

  /**
   * 读取本地所有的 session 列表概要。
   * @param tracesDir - 可观测性数据存储目录。
   */
  public static async listSessions(tracesDir: string = path.join(process.cwd(), '.haji', 'traces')): Promise<Array<{ id: string; startTime: string; endTime?: string; eventCount: number; modelUsed: string }>> {
    try {
      await fs.mkdir(tracesDir, { recursive: true });
      const files = await fs.readdir(tracesDir);
      const jsonFiles = files.filter(f => f.startsWith('session_') && f.endsWith('.json'));
      
      const list: any[] = [];
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(tracesDir, file);
          const raw = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(raw) as TraceSession;
          
          let modelUsed = 'unknown';
          for (const ev of data.events) {
            if (ev.type === 'llm_call') {
              modelUsed = ev.data.model;
              break;
            }
          }

          list.push({
            id: data.id,
            startTime: data.startTime,
            endTime: data.endTime,
            eventCount: data.events.length,
            modelUsed
          });
        } catch (e) {
          // 忽略单个损坏文件
        }
      }

      return list.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    } catch {
      return [];
    }
  }
}
