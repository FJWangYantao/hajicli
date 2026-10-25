import path from "node:path";
import {
  type BaseTool,
  type HookEngine,
  isFailedToolOutput,
  type PermissionEngine,
  performanceMonitor,
  type SnapshotEngine,
  type TaskItem,
  type TaskStore,
  type ToolExecutionContext,
  type ToolImage,
  type ToolProgressEvent,
} from "@hajicli/core";

export interface ToolExecutionResult {
  output: string;
  /** 工具附带的图片（read 读取图片文件）：调用方在工具消息之后补一条多模态用户消息。 */
  images?: ToolImage[];
  /** 工具实际执行耗时；不含等待用户授权等前置钩子的时间。 */
  duration: number;
  blocked: boolean;
  /** 被 PreToolUse 钩子拦截（用户拒绝或安全策略拒绝），工具本身未执行。 */
  rejected?: boolean;
}

export interface SharedToolExecutorOptions {
  cwd: string;
  tools: Map<string, BaseTool>;
  hookEngine: HookEngine;
  permissionEngine: PermissionEngine;
  snapshotEngine: SnapshotEngine;
  taskStore: TaskStore;
  setStatus?: (status?: string) => void;
  /** 前置钩子（含授权）通过、工具即将真正执行时触发。 */
  onToolStart?: (event: {
    toolName: string;
    args: Record<string, unknown>;
    context: ToolExecutionContext;
  }) => void;
  onToolProgress?: (event: {
    toolName: string;
    progress: ToolProgressEvent;
    context: ToolExecutionContext;
  }) => void;
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
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const targetTool = this.options.tools.get(toolName);
    if (!targetTool) {
      return { output: `错误: 工具 "${toolName}" 未注册。`, duration: 0, blocked: true };
    }
    if (context.abortSignal?.aborted) {
      return { output: "[工具执行已中止]", duration: 0, blocked: true };
    }

    const preHookResult = await performanceMonitor.measure("tool.pre_hook", () =>
      this.options.hookEngine.trigger("PreToolUse", {
        toolName,
        args,
        userIntent: context.userIntent || "",
        permissionMode: context.permissionMode,
        riskThreshold: context.riskThreshold,
        abortSignal: context.abortSignal,
        agentId: context.agentId,
        parentAgentId: context.parentAgentId,
        depth: context.depth,
      }),
    );
    if (preHookResult) {
      await this.post(toolName, args, preHookResult, context);
      return { output: preHookResult, duration: 0, blocked: true, rejected: true };
    }
    if (context.abortSignal?.aborted) {
      return { output: "[工具执行已中止]", duration: 0, blocked: true };
    }

    const isOrchestrationTool =
      ["subagent", "verifyagent", "loadskill"].includes(toolName) ||
      toolName.toLowerCase().startsWith("task");
    const declaredMutationScope = targetTool.getMutationScope?.(args);
    const mutationScope =
      declaredMutationScope ??
      (this.options.permissionEngine.isReadOnlyTool(toolName)
        ? "none"
        : this.options.permissionEngine.isEditTool(toolName)
          ? "paths"
          : "workspace");
    const shouldTrackMutation = Boolean(
      context.anchorSnapshotId &&
        !this.options.permissionEngine.isReadOnlyTool(toolName) &&
        !isOrchestrationTool &&
        mutationScope !== "none",
    );
    let mutationPaths: string[] | undefined;
    if (mutationScope === "paths" && typeof args.path === "string") {
      // 传给快照引擎的是绝对路径：工作区内会被编码成相对键，工作区外编码成 external: 键，
      // 这样 /rewind 也能覆盖经授权写入的外部文件。
      mutationPaths = [path.resolve(this.options.cwd, args.path)];
    }
    const checkpoint =
      shouldTrackMutation && context.anchorSnapshotId
        ? performanceMonitor.measureSync("snapshot.begin_mutation", () =>
            this.options.snapshotEngine.beginMutation(context.anchorSnapshotId!, mutationPaths),
          )
        : null;
    const finishingTask =
      toolName === "taskfinish"
        ? this.options.taskStore
            .getPlan()
            ?.tasks.find((task) => task.id === String(args.taskId || ""))
        : undefined;

    const agentPrefix = context.agentId ? `[${context.agentId}] ` : "";
    if (!context.agentId && !context.suppressStatus)
      this.options.setStatus?.(`${agentPrefix}运行 ${toolName}`);
    let output: string;
    let images: ToolImage[] | undefined;
    let mutationWarning: string | undefined;
    let lastProgressAt = 0;
    const emitProgress = (progress: ToolProgressEvent): void => {
      if (context.abortSignal?.aborted) return;
      context.onProgress?.(progress);
      const now = Date.now();
      if (now - lastProgressAt < 80) return;
      lastProgressAt = now;
      this.options.onToolProgress?.({ toolName, progress, context });
    };
    this.options.onToolStart?.({ toolName, args, context });
    // 计时从这里开始：等待用户授权的时间不应计入工具耗时。
    const startedAt = Date.now();
    let finishedAt = startedAt;
    try {
      const raw = await performanceMonitor.measure("tool.execute", () =>
        targetTool.execute(args, {
          ...context,
          toolCallId: context.toolCallId,
          onProgress: emitProgress,
        }),
      );
      // 工具可以只返回字符串；结构化结果额外携带图片（read 读图）。
      if (typeof raw === "string") {
        output = raw;
      } else {
        output = raw.output;
        if (raw.images?.length) images = raw.images;
      }
    } catch (error) {
      output = `执行出错: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      finishedAt = Date.now();
      if (checkpoint) {
        const mutationResult = performanceMonitor.measureSync("snapshot.complete_mutation", () =>
          this.options.snapshotEngine.completeMutation(checkpoint),
        );
        mutationWarning = mutationResult?.warning;
      }
      if (!context.agentId && !context.suppressStatus && !context.abortSignal?.aborted)
        this.options.setStatus?.();
    }
    if (mutationWarning) output = `${output}\n${mutationWarning}`;
    // 中止后工具可能仍在后台收尾：只保留快照收尾，不再回报计划变更、
    // PostToolUse 或执行证据，避免污染已经结束的回合和下一次回合的统计。
    const aborted = Boolean(context.abortSignal?.aborted);

    if (!aborted && toolName.toLowerCase().startsWith("task") && !output.startsWith("错误:")) {
      this.options.onTaskPlanChanged?.(finishingTask);
    }
    const failed = isFailedToolOutput(output);
    if (!context.agentId && !failed && !isOrchestrationTool && context.toolCallId) {
      output = `${output}\n[verification_evidence_id: ${context.toolCallId}]`;
    }
    if (!aborted) {
      await performanceMonitor.measure("tool.post_hook", () =>
        this.post(toolName, args, output, context),
      );
      this.options.onToolExecuted?.({
        toolName,
        toolCallId: context.toolCallId,
        context,
        output,
        blocked: failed,
        finishedAt: Date.now(),
      });
    }
    return {
      output,
      ...(images?.length ? { images } : {}),
      duration: finishedAt - startedAt,
      blocked: failed,
    };
  }

  private async post(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    context: ToolExecutionContext,
  ): Promise<void> {
    await this.options.hookEngine.trigger("PostToolUse", {
      toolCallId: context.toolCallId,
      toolName,
      args,
      toolOutput: output,
      agentId: context.agentId,
      parentAgentId: context.parentAgentId,
      depth: context.depth,
    });
  }
}
