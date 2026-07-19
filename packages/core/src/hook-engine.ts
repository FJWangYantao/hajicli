import { ChatMessage } from './types.js';

/** 生命周期 Hook 事件类型 */
export type HookEvent =
  | 'UserPromptSubmit'   // 用户发送消息后，发往 LLM 前
  | 'PreToolUse'          // 模型发起工具调用后，工具真实执行前
  | 'PostToolUse'         // 工具执行完成，返回模型前
  | 'Stop';               // 会话循环准备退出前

/** 生命周期 Hook 上下文信息 */
export interface HookContext {
  toolName?: string;
  args?: Record<string, unknown>;
  toolOutput?: string;
  toolCallId?: string;
  userIntent?: string;
  permissionMode?: string;
  riskThreshold?: string;
  messages?: ChatMessage[];
  agentId?: string;
  parentAgentId?: string;
  depth?: number;
}

/** Hook 处理器函数定义：返回 string 代表拦截或修改，返回 void/null/undefined 代表放行 */
export type HookHandler = (ctx: HookContext) => Promise<string | void | null> | string | void | null;

/**
 * 生命周期 Hook 引擎。
 * 提供切面挂载点，将权限校验、审计日志、自动追踪等功能与主逻辑解耦。
 */
export class HookEngine {
  private readonly hooks: Record<HookEvent, HookHandler[]> = {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: []
  };

  /**
   * 注册指定生命周期事件的 Hook 处理器。
   */
  register(event: HookEvent, handler: HookHandler): void {
    this.hooks[event].push(handler);
  }

  /**
   * 触发指定生命周期事件的所有已注册 Hook。
   * 如果某个 Hook 返回了非空字符串，立刻中断后续 Hook 链并返回该结果。
   */
  async trigger(event: HookEvent, ctx: HookContext): Promise<string | null> {
    for (const handler of this.hooks[event]) {
      const result = await handler(ctx);
      if (result) {
        return result;
      }
    }
    return null;
  }
}
