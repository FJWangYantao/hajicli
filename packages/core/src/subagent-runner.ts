import { randomUUID } from 'node:crypto';
import {
  BaseTool,
  ChatMessage,
  ModelProvider,
  ReasoningEffort,
  ToolCall,
  ToolExecutionContext
} from './types.js';

export type SubagentRole = 'research' | 'implement' | 'review';

export interface SubagentRequest {
  description: string;
  taskId?: string;
  role?: SubagentRole;
  agentId?: string;
  timeoutMs?: number;
}

export interface SubagentResult {
  agentId: string;
  status: 'completed' | 'failed' | 'aborted' | 'max_turns';
  summary: string;
  filesChanged: string[];
  verification: string[];
  unresolved: string[];
}

export type SubagentEvent =
  | { type: 'start'; agentId: string; role: SubagentRole; taskId?: string; description: string }
  | { type: 'tool'; agentId: string; role: SubagentRole; taskId?: string; toolName: string }
  | { type: 'usage'; agentId: string; role: SubagentRole; taskId?: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: 'done'; agentId: string; role: SubagentRole; taskId?: string; result: SubagentResult };

export interface SubagentRunnerOptions {
  cwd: string;
  getProvider: () => ModelProvider;
  getModel: () => string;
  getReasoningEffort: () => ReasoningEffort;
  getTools: (context: ToolExecutionContext) => BaseTool[];
  executeTool: (
    toolCall: ToolCall,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ) => Promise<string>;
  onEvent?: (event: SubagentEvent) => void;
  maxTurns?: number;
}

function abortError(): Error {
  const error = new Error('Subagent aborted');
  error.name = 'AbortError';
  return error;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function parseFinalResult(agentId: string, text: string): SubagentResult {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const value = JSON.parse(stripped) as Record<string, unknown>;
    return {
      agentId,
      status: 'completed',
      summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : text.trim(),
      filesChanged: stringArray(value.filesChanged),
      verification: stringArray(value.verification),
      unresolved: stringArray(value.unresolved)
    };
  } catch {
    return {
      agentId,
      status: 'completed',
      summary: text.trim() || '子代理已完成，但没有返回文字总结。',
      filesChanged: [],
      verification: [],
      unresolved: []
    };
  }
}

export function formatSubagentResult(result: SubagentResult): string {
  return `[SUBAGENT_RESULT - UNVERIFIED]\n${JSON.stringify(result, null, 2)}`;
}

/** Runs one isolated, non-recursive child agent and returns only its final result. */
export class SubagentRunner {
  constructor(private readonly options: SubagentRunnerOptions) {}

  async run(request: SubagentRequest, parentContext: ToolExecutionContext = {}): Promise<string> {
    return formatSubagentResult(await this.runResult(request, parentContext));
  }

  async runResult(request: SubagentRequest, parentContext: ToolExecutionContext = {}): Promise<SubagentResult> {
    if ((parentContext.depth || 0) > 0) {
      return {
        agentId: parentContext.agentId || 'unknown',
        status: 'failed',
        summary: '当前版本禁止子代理递归委派。请使用现有只读工具串行完成当前子任务，并把无法完成的部分写入 unresolved 交由父 Agent 处理。',
        filesChanged: [],
        verification: [],
        unresolved: ['recursive_subagent_denied']
      };
    }

    const description = request.description.trim();
    if (!description) throw new Error('subagent description 不能为空');
    if (parentContext.abortSignal?.aborted) throw abortError();

    const agentId = request.agentId || `sub-${randomUUID().slice(0, 8)}`;
    const role = request.role || 'research';
    const childContext: ToolExecutionContext = {
      ...parentContext,
      agentId,
      parentAgentId: parentContext.agentId || 'main',
      depth: 1,
      userIntent: description
    };
    const tools = this.options.getTools(childContext)
      .filter(tool => tool.name !== 'subagent' && !tool.name.toLowerCase().startsWith('task'));
    const systemPrompt = [
      '你是 Haji 的子代理。只完成收到的单一子任务，不要扩大范围，也不要再次委派。',
      `角色：${role}`,
      `工作目录：${this.options.cwd}`,
      '你拥有独立上下文，但和主代理共享工作目录。所有工具调用仍受主代理权限、快照和中断机制约束。',
      '不要操作任务列表；任务状态、最终验证和 taskfinish 由主代理负责。',
      '完成后只返回 JSON：{"summary":"结论","filesChanged":[],"verification":[],"unresolved":[]}。',
      'filesChanged 仅列出实际修改的相对路径；verification 仅列出实际执行的验证及结果；不得虚构。'
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: request.taskId ? `任务 ${request.taskId}：${description}` : description }
    ];
    const provider = this.options.getProvider();
    const model = this.options.getModel();
    const reasoningEffort = this.options.getReasoningEffort();

    this.options.onEvent?.({ type: 'start', agentId, role, taskId: request.taskId, description });
    try {
      for (let turn = 0; turn < (this.options.maxTurns || 20); turn += 1) {
        if (parentContext.abortSignal?.aborted) throw abortError();
        let toolCalls: ToolCall[] = [];
        let reasoning = '';
        const text = await provider.complete(messages, {
          model,
          reasoningEffort,
          thinking: true,
          maxTokens: 8000,
          tools: tools.map(tool => tool.definition),
          abortSignal: parentContext.abortSignal,
          onToolCall: calls => { toolCalls = calls; },
          onReasoning: content => { reasoning += content; },
          onUsage: usage => this.options.onEvent?.({ type: 'usage', agentId, role, taskId: request.taskId, usage })
        });
        const assistantMessage: ChatMessage = { role: 'assistant', content: text };
        if (reasoning) assistantMessage.reasoning_content = reasoning;
        if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
        messages.push(assistantMessage);

        if (toolCalls.length === 0) {
          const result = parseFinalResult(agentId, text);
          this.options.onEvent?.({ type: 'done', agentId, role, taskId: request.taskId, result });
          return result;
        }

        for (const toolCall of toolCalls) {
          if (parentContext.abortSignal?.aborted) throw abortError();
          this.options.onEvent?.({ type: 'tool', agentId, role, taskId: request.taskId, toolName: toolCall.function.name });
          let output: string;
          try {
            const args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
            output = await this.options.executeTool(toolCall, args, childContext);
          } catch (error) {
            output = `执行出错: ${error instanceof Error ? error.message : String(error)}`;
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
        }
      }

      const result: SubagentResult = {
        agentId,
        status: 'max_turns',
        summary: `子代理达到 ${(this.options.maxTurns || 20)} 轮安全上限。`,
        filesChanged: [],
        verification: [],
        unresolved: ['max_turns_reached']
      };
      this.options.onEvent?.({ type: 'done', agentId, role, taskId: request.taskId, result });
      return result;
    } catch (error) {
      const aborted = parentContext.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError');
      const abortReason = parentContext.abortSignal?.reason;
      const timedOut = aborted && abortReason instanceof Error && abortReason.name === 'TimeoutError';
      const result: SubagentResult = {
        agentId,
        status: aborted ? 'aborted' : 'failed',
        summary: timedOut
          ? abortReason.message
          : aborted
            ? '子代理已被用户中止。'
            : `子代理失败：${error instanceof Error ? error.message : String(error)}`,
        filesChanged: [],
        verification: [],
        unresolved: [timedOut ? 'timeout' : aborted ? 'aborted' : 'runtime_error']
      };
      this.options.onEvent?.({ type: 'done', agentId, role, taskId: request.taskId, result });
      return result;
    }
  }
}
