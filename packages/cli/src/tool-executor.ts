import path from 'node:path';
import {
  BaseTool,
  HookEngine,
  PermissionEngine,
  PermissionMode,
  RiskLevel,
  SnapshotEngine,
  TaskItem,
  TaskStore,
  ToolExecutionContext
} from '@hajicli/core';

export interface ToolExecutionResult {
  output: string;
  duration: number;
  blocked: boolean;
}

export interface SharedToolExecutorOptions {
  cwd: string;
  tools: Map<string, BaseTool>;
  hookEngine: HookEngine;
  permissionEngine: PermissionEngine;
  snapshotEngine: SnapshotEngine;
  taskStore: TaskStore;
  setStatus?: (status?: string) => void;
  onTaskPlanChanged?: (recentlyCompleted?: TaskItem) => void;
  onToolExecuted?: (event: {
    toolName: string;
    toolCallId?: string;
    context: ToolExecutionContext;
    output: string;
    blocked: boolean;
    finishedAt: number;
  }) => void;
}

/** Centralizes permissions, snapshots, hooks and abort propagation for every agent. */
export class SharedToolExecutor {
  constructor(private readonly options: SharedToolExecutorOptions) {}

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const targetTool = this.options.tools.get(toolName);
    if (!targetTool) {
      return { output: `错误: 工具 "${toolName}" 未注册。`, duration: 0, blocked: true };
    }
    if (context.abortSignal?.aborted) {
      return { output: '[工具执行已中止]', duration: 0, blocked: true };
    }

    const preHookResult = await this.options.hookEngine.trigger('PreToolUse', {
      toolName,
      args,
      userIntent: context.userIntent || '',
      permissionMode: context.permissionMode,
      riskThreshold: context.riskThreshold,
      agentId: context.agentId,
      parentAgentId: context.parentAgentId,
      depth: context.depth
    });
    if (preHookResult) {
      await this.post(toolName, args, preHookResult, context);
      return { output: preHookResult, duration: Date.now() - startedAt, blocked: true };
    }
    if (context.abortSignal?.aborted) {
      return { output: '[工具执行已中止]', duration: Date.now() - startedAt, blocked: true };
    }

    const isOrchestrationTool = ['subagent', 'verifyagent'].includes(toolName) || toolName.toLowerCase().startsWith('task');
    const shouldTrackMutation = Boolean(
      context.anchorSnapshotId
      && !this.options.permissionEngine.isReadOnlyTool(toolName)
      && !isOrchestrationTool
    );
    let mutationPaths: string[] | undefined;
    if (this.options.permissionEngine.isEditTool(toolName) && typeof args.path === 'string') {
      const absoluteTarget = path.resolve(this.options.cwd, args.path);
      const relativeTarget = path.relative(this.options.cwd, absoluteTarget);
      if (relativeTarget && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget)) {
        mutationPaths = [relativeTarget];
      }
    }
    const checkpoint = shouldTrackMutation && context.anchorSnapshotId
      ? this.options.snapshotEngine.beginMutation(context.anchorSnapshotId, mutationPaths)
      : null;
    const finishingTask = toolName === 'taskfinish'
      ? this.options.taskStore.getPlan()?.tasks.find(task => task.id === String(args.taskId || ''))
      : undefined;

    const agentPrefix = context.agentId ? `[${context.agentId}] ` : '';
    if (!context.agentId) this.options.setStatus?.(`${agentPrefix}正在执行 ${toolName}...`);
    let output: string;
    let mutationWarning: string | undefined;
    try {
      output = await targetTool.execute(args, { ...context, toolCallId: context.toolCallId });
    } catch (error) {
      output = `执行出错: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (checkpoint) {
        const mutationResult = this.options.snapshotEngine.completeMutation(checkpoint);
        mutationWarning = mutationResult?.warning;
      }
      if (!context.agentId) this.options.setStatus?.();
    }
    if (mutationWarning) output = `${output}\n${mutationWarning}`;

    if (toolName.toLowerCase().startsWith('task') && !output.startsWith('错误:')) {
      this.options.onTaskPlanChanged?.(finishingTask);
    }
    const failed = output.startsWith('错误:')
      || output.startsWith('执行出错:')
      || /^\[[^\]]*已中止\]/.test(output)
      || output.startsWith('[安全引擎拒绝拦截]')
      || (output.startsWith('[SUBAGENT_RESULT') && /"status":\s*"(?:failed|aborted|max_turns)"/.test(output));
    if (!context.agentId && !failed && !isOrchestrationTool && context.toolCallId) {
      output = `${output}\n[verification_evidence_id: ${context.toolCallId}]`;
    }
    await this.post(toolName, args, output, context);
    this.options.onToolExecuted?.({
      toolName,
      toolCallId: context.toolCallId,
      context,
      output,
      blocked: failed,
      finishedAt: Date.now()
    });
    return {
      output,
      duration: Date.now() - startedAt,
      blocked: failed
    };
  }

  private async post(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    context: ToolExecutionContext
  ): Promise<void> {
    await this.options.hookEngine.trigger('PostToolUse', {
      toolCallId: context.toolCallId,
      toolName,
      args,
      toolOutput: output,
      agentId: context.agentId,
      parentAgentId: context.parentAgentId,
      depth: context.depth
    });
  }
}
