import {
  BaseTool,
  SubagentRequest,
  SubagentRole,
  ToolDefinition,
  ToolExecutionContext
} from '@hajicli/core';

export type SubagentHandler = (request: SubagentRequest, context?: ToolExecutionContext) => Promise<string>;
export type VerifyAgentHandler = (input: {
  agentId: string;
  verdict: 'verified' | 'rejected';
  evidence: string;
  evidenceToolCallIds: string[];
}) => Promise<string>;

/** Thin tool facade; the CLI injects the actual child-agent runtime. */
export class SubagentTool implements BaseTool {
  readonly name = 'subagent';
  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'subagent',
      description: '将一个边界清晰的复杂子任务委派给独立上下文的子代理，只返回最终结论。适合调研、实现或审查；不要用于简单的一步操作。',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '完整、可独立执行的子任务说明和验收标准' },
          taskId: { type: 'string', description: '可选：当前 Todo 中对应的任务 ID' },
          role: { type: 'string', enum: ['research', 'implement', 'review'], description: '子代理角色' },
          timeoutMs: {
            type: 'integer',
            minimum: 100,
            maximum: 3600000,
            description: '可选：运行超时毫秒数；默认 600000（10 分钟）'
          }
        },
        required: ['description']
      }
    }
  };

  constructor(private readonly handler: SubagentHandler) {}

  execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    if (!description) return Promise.resolve('错误: subagent 缺少 description 参数。');
    const role = ['research', 'implement', 'review'].includes(String(args.role || ''))
      ? String(args.role) as SubagentRole
      : 'research';
    const timeoutMs = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000)) {
      return Promise.resolve('错误: timeoutMs 必须是 100 到 3600000 之间的整数。');
    }
    return this.handler({
      description,
      taskId: typeof args.taskId === 'string' && args.taskId.trim() ? args.taskId.trim() : undefined,
      role,
      timeoutMs
    }, context);
  }
}

/** Parent-only gate for accepting a child result after independent evidence was collected. */
export class VerifyAgentTool implements BaseTool {
  readonly name = 'verifyagent';
  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'verifyagent',
      description: '父 Agent 在独立读取、搜索、构建或测试后，验证或拒绝一个已完成的子代理结果。不能直接采信子代理报告。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '等待验证的子代理 ID' },
          verdict: { type: 'string', enum: ['verified', 'rejected'] },
          evidence: { type: 'string', description: '父 Agent 实际执行的独立验证及结果' },
          evidenceToolCallIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: '本次验证引用的父 Agent 工具调用 ID；每个 ID 只能绑定一个子代理并使用一次'
          }
        },
        required: ['agentId', 'verdict', 'evidence', 'evidenceToolCallIds']
      }
    }
  };

  constructor(private readonly handler: VerifyAgentHandler) {}

  execute(args: Record<string, unknown>): Promise<string> {
    const agentId = String(args.agentId || '').trim();
    const verdict = String(args.verdict || '') as 'verified' | 'rejected';
    const evidence = String(args.evidence || '').trim();
    const evidenceToolCallIds = Array.isArray(args.evidenceToolCallIds)
      ? args.evidenceToolCallIds.map(value => String(value).trim()).filter(Boolean)
      : [];
    if (!agentId) return Promise.resolve('错误: verifyagent 缺少 agentId。');
    if (!['verified', 'rejected'].includes(verdict)) return Promise.resolve('错误: verdict 必须是 verified 或 rejected。');
    if (!evidence) return Promise.resolve('错误: verifyagent 必须提供独立验证证据。');
    if (evidenceToolCallIds.length === 0) return Promise.resolve('错误: verifyagent 必须提供 evidenceToolCallIds。');
    return this.handler({ agentId, verdict, evidence, evidenceToolCallIds });
  }
}
