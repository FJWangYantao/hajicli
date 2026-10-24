/**
 * 单个对话回合的执行：prompt 提交语义（收回 / 落盘划界）、流式渲染、
 * 工具调用批调度、Plan 审批流与子代理验证兜底。
 *
 * 从 index.ts 主循环抽出。回合内可变状态（requestStarted / isTurnAborted 等）
 * 全部是本函数局部；跨回合共享的 main() 状态经 TurnDeps 访问器读写：
 * permissionMode / riskThreshold 用访问器（Plan 审批会在回合中切换档位），
 * provider / selectedModel / reasoningEffort 快照即可（只在回合之间变化）。
 */
import {
  type AgentManager,
  type BaseTool,
  type ChatMessage,
  estimateTextTokens,
  type HookEngine,
  type ObservableModelProvider,
  type PermissionMode,
  type ReasoningEffort,
  type RiskLevel,
  repairToolCallPairs,
  type SessionManager,
  type SessionTracker,
  type SkillRegistry,
  type SnapshotEngine,
  type ToolCall,
  validateToolCall,
} from "@hajicli/core";
import { PLAN_READY_MARKER } from "@hajicli/plugins";
import type { ActivityIndicator, ToolRunView } from "./activity-indicator.js";
import { formatAgentTokens } from "./agent-commands.js";
import {
  describeModelError,
  formatReasoningPreview,
  formatToolDuration,
  summarizeToolCall,
  summarizeToolResult,
} from "./cli-runtime.js";
import {
  MarkdownRenderThrottle,
  MarkdownStreamRenderer,
  shouldShowToolThinkingSummary,
} from "./markdown-renderer.js";
import { TerminalInputCancelledError, type TerminalUI } from "./terminal-input.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { colors } from "./theme.js";
import { createToolCallBatches, runToolCallBatch } from "./tool-batch.js";
import type { SharedToolExecutor } from "./tool-executor.js";

export interface TurnDeps {
  ui: TerminalUI;
  activityIndicator: ActivityIndicator;
  toolRunView: ToolRunView;
  tracker: SessionTracker;
  sessionManager: SessionManager;
  skillRegistry: SkillRegistry;
  snapshotEngine: SnapshotEngine;
  hookEngine: HookEngine;
  agentManager: AgentManager;
  toolExecutor: SharedToolExecutor;
  toolsMap: Map<string, BaseTool>;
  /** 当前权限档下可用的工具（Plan 模式过滤写操作）。 */
  activeTools(): BaseTool[];
  getProvider(): ObservableModelProvider;
  getSelectedModel(): string;
  getReasoningEffort(): ReasoningEffort;
  /** 回调形式避免 turn-runner 依赖 cost-tracker 具体类型；缺省不记账。 */
  recordCost?: (
    model: string,
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    purpose?: string,
  ) => void;
  /** 会话标题生成用的杂活模型运行时；缺省退回主模型。 */
  getTitleUtility?: () => { provider: ObservableModelProvider; model: string } | undefined;
  getPermissionMode(): PermissionMode;
  getRiskThreshold(): RiskLevel;
  getMessages(): ChatMessage[];
  setMessages(messages: ChatMessage[]): void;
  setLastUserMessageForRecall(message: string): void;
  setForegroundAbortSignal(signal: AbortSignal | undefined): void;
  setLastToolBatchOutputs(
    outputs: Array<{ toolName: string; summary: string; output: string }>,
  ): void;
  isPlanReadyForReview(): boolean;
  setPlanReadyForReview(value: boolean): void;
  isPlanReviewSummaryRequested(): boolean;
  setPlanReviewSummaryRequested(value: boolean): void;
  /** 回合中途收回的草稿队列（const 数组引用）。 */
  deferredInputDrafts: string[];
  /** 待处理输入队列（const 数组引用）。 */
  pendingInputs: string[];
  updateStatusUI(): void;
  applyPermissionMode(mode: PermissionMode): Promise<void>;
  readSelectionSafely: (
    options: Parameters<TerminalUI["readSelection"]>[0],
    draftHandling?: "queue" | "restore",
  ) => ReturnType<TerminalUI["readSelection"]>;
  showRuntimeWarning(warning: string): void;
  refreshAgentVerificationContext(messages: ChatMessage[]): boolean;
  startBackgroundInput(initialValue?: string): void;
}

export interface TurnInput {
  /** 斜杠命令（如 /skill）转发出的 prompt；无转发时为 undefined。 */
  forwardedPrompt: string | undefined;
  /** 触发本轮的原始输入（判定 prompt 能否收回：斜杠命令不可收回）。 */
  commandInput: string;
  manualSkillExchange?: { toolCall: ToolCall; output: string };
  /** 本轮用户消息回显在对话区的起始位置（收回 prompt 时据此清除回显）。 */
  promptDisplayStartOffset: number;
  /** 图片附件（/image 命令）：随用户消息一起发送，需视觉模型。 */
  promptAttachments?: Array<{ mimeType: string; base64: string }>;
}

/** 执行一个对话回合。main() 的主循环在分发完斜杠命令后调用。 */
export async function runAgentTurn(deps: TurnDeps, input: TurnInput): Promise<void> {
  const {
    ui,
    activityIndicator,
    toolRunView,
    tracker,
    sessionManager,
    skillRegistry,
    snapshotEngine,
    hookEngine,
    agentManager,
    toolExecutor,
    toolsMap,
    deferredInputDrafts,
    pendingInputs,
  } = deps;
  const provider = deps.getProvider();
  const selectedModel = deps.getSelectedModel();
  const reasoningEffort = deps.getReasoningEffort();

  // 先把 prompt 放入本轮内存上下文；只有 Provider 真正开始请求时才写入
  // Trace、快照和会话。这样 ESC 可以在请求发出前无痕收回 prompt。
  const promptInput = input.forwardedPrompt || input.commandInput;
  // messages 与 main() 共享绑定：重排时经 setMessages 同步回去，
  // 原位修改（push）直接作用于共享数组引用。
  let messages = deps.getMessages();
  const setMessages = (next: ChatMessage[]): void => {
    messages = next;
    deps.setMessages(next);
  };
  const messagesBeforePrompt = [...messages];
  messages.push({
    role: "user",
    content: promptInput,
    ...(input.promptAttachments?.length ? { attachments: input.promptAttachments } : {}),
  });
  deps.setLastUserMessageForRecall(promptInput);
  if (input.manualSkillExchange) {
    messages.push(
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [input.manualSkillExchange.toolCall],
      },
      {
        role: "tool",
        content: input.manualSkillExchange.output,
        tool_call_id: input.manualSkillExchange.toolCall.id,
      },
    );
  }
  deps.updateStatusUI();

  const isFirstUserMsg = messages.filter((m) => m.role === "user").length === 1;
  const requestAbortController = new AbortController();
  const canReclaimPrompt = !input.commandInput.startsWith("/") && !input.manualSkillExchange;
  let requestStarted = false;
  let promptCommitted = false;
  let promptReclaimed = false;
  let isTurnAborted = false;
  let abortNoticeShown = false;
  let stopActiveTurnVisuals: () => void = () => {};

  const commitPromptForRequest = () => {
    requestStarted = true;
    if (promptCommitted) return;
    promptCommitted = true;
    tracker.recordUserInput(promptInput);
    const snapshotId = snapshotEngine.createAnchor(
      `before user message ${messagesBeforePrompt.length}`,
    );
    const latestUserMessage = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" && message.content === promptInput && !message.snapshotId,
      );
    if (latestUserMessage && snapshotId) latestUserMessage.snapshotId = snapshotId;
    sessionManager.saveCurrentSession(messages);
    if (isFirstUserMsg) {
      sessionManager
        .generateTitleAsync(promptInput, async (prompt) => {
          let fullTitleText = "";
          // 标题是低价值杂活，优先走便宜的 utility 模型。
          const utility = deps.getTitleUtility?.();
          const titleStream = (utility?.provider ?? provider).completeStream(
            [{ role: "user", content: prompt }],
            {
              model: utility?.model ?? selectedModel,
              reasoningEffort: "low",
            },
          );
          for await (const chunk of titleStream) fullTitleText += chunk;
          return fullTitleText;
        })
        .then(() => {
          deps.updateStatusUI();
        })
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          deps.showRuntimeWarning(`会话标题生成失败，已保留默认标题：${detail}`);
        });
    }
  };

  const showAbortNotice = () => {
    stopActiveTurnVisuals();
    activityIndicator.stop();
    ui.setStatus();
    if (abortNoticeShown) return;
    abortNoticeShown = true;
    ui.writeLine();
    ui.writeLine(colors.failLine(colors.muted("已中止本轮")));
  };

  const reclaimPrompt = () => {
    promptReclaimed = true;
    isTurnAborted = true;
    stopActiveTurnVisuals();
    requestAbortController.abort();
    const concurrentDraft = ui.cancelInput();
    if (concurrentDraft?.trim()) deferredInputDrafts.unshift(concurrentDraft);
    deferredInputDrafts.unshift(input.commandInput);
    setMessages(messagesBeforePrompt);
    skillRegistry.restoreScopeFromMessages("main", messages);
    sessionManager.saveCurrentSession(messages);
    ui.updateChatFrom(input.promptDisplayStartOffset, "");
    activityIndicator.stop();
    ui.setStatus();
    ui.writeLine(colors.gray("↩ 请求尚未发出，prompt 已收回到输入框。"));
    ui.setQueue(pendingInputs);
    ui.onEsc();
    deps.updateStatusUI();
  };

  deps.setForegroundAbortSignal(requestAbortController.signal);
  ui.onEsc(() => {
    if (isTurnAborted) return;
    if (!requestStarted && canReclaimPrompt) {
      reclaimPrompt();
      return;
    }
    if (!requestStarted) commitPromptForRequest();
    isTurnAborted = true;
    stopActiveTurnVisuals();
    const interruptedDraft = ui.cancelInput();
    if (interruptedDraft?.trim()) {
      deferredInputDrafts.unshift(interruptedDraft);
    }
    activityIndicator.start("stopping", "正在终止", "等待当前操作响应中止信号");
    requestAbortController.abort();
  });
  deps.startBackgroundInput();

  const promptHookContext = { messages };
  await hookEngine.trigger("UserPromptSubmit", promptHookContext);
  if (promptReclaimed) {
    deps.setForegroundAbortSignal(undefined);
    return;
  }
  if (promptHookContext.messages !== messages) {
    setMessages(promptHookContext.messages);
    skillRegistry.restoreScopeFromMessages("main", messages);
    if (promptCommitted) sessionManager.saveCurrentSession(messages);
    deps.updateStatusUI();
  }
  // 给刚提交后的 ESC 一个事件循环机会；真正的网络请求仍由 onRequestStart 划界。
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (promptReclaimed) {
    deps.setForegroundAbortSignal(undefined);
    return;
  }
  if (isTurnAborted) {
    showAbortNotice();
    ui.onEsc();
    deps.setForegroundAbortSignal(undefined);
    return;
  }

  let keepCalling = true;
  let malformedToolRecoveryAttempts = 0;
  // 回合小结：耗时、模型输出 tokens（以 Provider 统计为准）与工具调用次数。
  const turnStartedAt = Date.now();
  let turnOutputTokens: number | undefined;
  let turnToolCalls = 0;
  let turnFailed = false;
  while (keepCalling) {
    const repairedMessages = repairToolCallPairs(messages);
    if (repairedMessages !== messages) {
      // 静默修复：历史配对不完整通常来自被中止的回合，属于内部卫生问题，
      // 不打断对话区的观感；修好的结果直接落盘，可在会话文件里查到差异。
      setMessages(repairedMessages);
      sessionManager.saveCurrentSession(messages);
    }
    if (deps.refreshAgentVerificationContext(messages)) sessionManager.saveCurrentSession(messages);
    deps.startBackgroundInput();
    let currentToolCalls: ToolCall[] | null = null;
    let completionTokens: number | undefined;
    let finishReason: string | undefined;
    let requestRetryCount = 0;
    const thinkingStartedAt = Date.now();

    let textContent = "";
    let reasoningContent = "";
    // 流式过程中的 token 数按增量估算（不重复扫描全文），与回合结束后的统计口径一致。
    let reasoningTokens = 0;
    let responseTokens = 0;

    // TTFT、推理与流式回复共用一条可观测活动状态。
    let isThinking = true;
    let isResponding = false;
    activityIndicator.start("thinking", "思考中", "模型尚未响应");
    // 思考过程预览：在对话区底部滚动显示最新几行推理，回复开始或回合结束时清除。
    let reasoningPreviewShown = false;
    let reasoningPreviewAt = 0;
    const clearReasoningPreview = () => {
      if (!reasoningPreviewShown) return;
      reasoningPreviewShown = false;
      ui.setLiveTail("");
    };
    stopActiveTurnVisuals = () => {
      isThinking = false;
      clearReasoningPreview();
      activityIndicator.stop();
    };
    const mdStreamRenderer = new MarkdownStreamRenderer(() => ui.getContentWidth());
    const markdownRenderThrottle = new MarkdownRenderThrottle();
    const streamStartOffset = ui.getChatLength();
    ui.markStableChatPrefix(streamStartOffset);

    const stream = provider.completeStream(messages, {
      model: selectedModel,
      reasoningEffort,
      thinking: true,
      tools: deps.activeTools().map((tool) => tool.definition),
      abortSignal: requestAbortController.signal,
      onRequestStart: commitPromptForRequest,
      onToolCall: (tcs: ToolCall[]) => {
        if (isTurnAborted) return;
        currentToolCalls = tcs;
      },
      onReasoning: (content: string) => {
        if (isTurnAborted) return;
        reasoningContent += content;
        reasoningTokens += estimateTextTokens(content);
        activityIndicator.progress(`推理约 ${formatAgentTokens(reasoningTokens)} tokens`);
        const now = Date.now();
        if (!isResponding && now - reasoningPreviewAt >= 50) {
          reasoningPreviewAt = now;
          ui.setLiveTail(formatReasoningPreview(reasoningContent, ui.getContentWidth()));
          reasoningPreviewShown = true;
        }
      },
      onUsage: (usage) => {
        completionTokens = usage.completion_tokens;
        turnOutputTokens = (turnOutputTokens ?? 0) + usage.completion_tokens;
        deps.recordCost?.(selectedModel, usage, "主线回合");
      },
      onFinish: (finish) => {
        finishReason = finish.reason;
      },
      onRetry: ({ attempt, maxRetries, delayMs, error }) => {
        if (isTurnAborted) return;
        requestRetryCount = attempt;
        const reason = Array.from(sanitizeTerminalText(error.message || String(error)))
          .slice(0, 60)
          .join("");
        activityIndicator.progress(
          `请求失败，${(delayMs / 1000).toFixed(1)}s 后第 ${attempt}/${maxRetries} 次重试：${reason}`,
        );
      },
    });

    try {
      for await (const chunk of stream) {
        if (isTurnAborted) continue;
        if (!isResponding) {
          isThinking = false;
          isResponding = true;
          clearReasoningPreview();
          activityIndicator.transition("responding", "生成回复", "正在接收模型输出");
        }

        textContent += chunk;
        responseTokens += estimateTextTokens(chunk);
        activityIndicator.progress(`已生成约 ${formatAgentTokens(responseTokens)} tokens`);
        // Reparse at most once per frame; the final pass below always renders the complete answer.
        if (markdownRenderThrottle.shouldRender(Date.now(), textContent.length)) {
          const renderedMarkdown = mdStreamRenderer.render(textContent, false);
          ui.updateChatFrom(streamStartOffset, renderedMarkdown);
        }
      }

      if (isTurnAborted) {
        const abortError = new Error("Turn aborted");
        abortError.name = "AbortError";
        throw abortError;
      }

      // 结束流式输出，做最终渲染
      if (textContent) {
        const finalRenderedMarkdown = mdStreamRenderer.render(textContent, true);
        ui.updateChatFrom(streamStartOffset, finalRenderedMarkdown);
      }
    } catch (streamError) {
      stopActiveTurnVisuals();
      if (isTurnAborted) {
        // 最后一帧可能尚未经过节流渲染；终止时补齐并保存已生成的部分内容。
        if (textContent) {
          ui.updateChatFrom(streamStartOffset, mdStreamRenderer.render(textContent, true));
        }
        if (textContent || reasoningContent) {
          const partialMessage: ChatMessage = { role: "assistant", content: textContent };
          if (reasoningContent) partialMessage.reasoning_content = reasoningContent;
          messages.push(partialMessage);
          sessionManager.saveCurrentSession(messages);
          deps.updateStatusUI();
        }
        showAbortNotice();
      } else {
        commitPromptForRequest();
        activityIndicator.stop();
        turnFailed = true;
        // 捕获 Provider 调用错误，展示友好提示而非崩溃
        const described = describeModelError(streamError);
        ui.writeLine();
        const retryNote = requestRetryCount > 0 ? `（已自动重试 ${requestRetryCount} 次）` : "";
        ui.writeLine(colors.failLine(colors.bold(`${described.title}${retryNote}`)));
        if (described.detail) ui.writeLine(colors.gray(`  ${described.detail}`));
        ui.writeLine(`  ${colors.muted("提示")} ${described.hint}`);
        ui.writeLine();
      }
      keepCalling = false;
      continue;
    } finally {
      stopActiveTurnVisuals();
      if (!isTurnAborted) activityIndicator.stop();
    }

    if (isThinking) {
      isThinking = false;
    }

    const toolCalls = currentToolCalls as ToolCall[] | null;
    const invalidToolCall = toolCalls
      ?.map((toolCall) => ({
        toolCall,
        validation: validateToolCall(toolCall),
      }))
      .find((item) => !item.validation.valid);
    if (shouldShowToolThinkingSummary(textContent, toolCalls?.length || 0)) {
      const thinkingSeconds = Math.max(1, Math.round((Date.now() - thinkingStartedAt) / 1000));
      const tokenSummary =
        completionTokens === undefined
          ? ""
          : ` · ${completionTokens.toLocaleString("en-US")} tokens`;
      ui.writeLine(colors.faint(`  思考 ${thinkingSeconds}s${tokenSummary}`));
    } else if (!toolCalls || toolCalls.length === 0 || invalidToolCall) {
      // 无工具调用（或工具调用无效）时正文后补一个空行；
      // 有工具调用时由下方工具调用块前后的空行负责分隔，避免产生连续空行。
      ui.writeLine();
    }

    // 保存助理回复
    const assistantMessage: ChatMessage = { role: "assistant", content: textContent };
    if (reasoningContent) {
      assistantMessage.reasoning_content = reasoningContent;
    }
    if (toolCalls && toolCalls.length > 0 && !invalidToolCall) {
      assistantMessage.tool_calls = toolCalls;
    }
    messages.push(assistantMessage);
    sessionManager.saveCurrentSession(messages);
    deps.updateStatusUI();

    if (invalidToolCall) {
      malformedToolRecoveryAttempts += 1;
      const toolName = invalidToolCall.toolCall.function?.name || "unknown";
      const truncationHint =
        finishReason === "length"
          ? "Provider 返回 finish_reason=length；Haji 未设置单次输出上限，这是上游服务端限制。"
          : "工具参数可能因上游流中断而被截断。";
      ui.writeLine(
        colors.warnLine(`已拦截不完整的 ${toolName} 工具调用，未执行、未写入工具调用历史。`),
      );
      ui.writeLine(colors.gray(`${invalidToolCall.validation.error} ${truncationHint}`));

      if (malformedToolRecoveryAttempts <= 1) {
        messages.push({
          role: "user",
          content: `[系统工具调用恢复] 上一轮 ${toolName} 工具参数未完整生成，已安全丢弃且没有执行。请重新生成完整、有效的 JSON 参数；避免一次传入过长正文，必要时将写入拆成较小步骤。`,
        });
        sessionManager.saveCurrentSession(messages);
        deps.updateStatusUI();
        keepCalling = true;
      } else {
        ui.writeLine(
          colors.failLine(
            "连续两次收到不完整工具参数，已停止自动重试，避免无限循环。请缩短单次写入内容后重试。",
          ),
        );
        keepCalling = false;
      }
      continue;
    }

    if (finishReason === "length") {
      const usedText =
        completionTokens !== undefined
          ? `（已生成 ${completionTokens.toLocaleString("en-US")} tokens）`
          : "";
      ui.writeLine(
        colors.warnLine(
          `上游 Provider 以 length 结束${usedText}，本轮内容可能不完整；Haji 未设置单次输出上限。`,
        ),
      );
    }

    // 处理工具调用逻辑
    if (toolCalls && toolCalls.length > 0) {
      turnToolCalls += toolCalls.length;
      // 工具调用块前空一行：与上方思考/正文分隔；工具调用相互之间不空行
      ui.writeBlankLine();
      type ToolExecutionResult = Awaited<ReturnType<typeof toolExecutor.execute>>;
      type BatchItemResult = {
        tc: ToolCall;
        toolName: string;
        args: Record<string, unknown>;
        duration: number;
        execution?: ToolExecutionResult;
        unregistered?: boolean;
        skipped?: boolean;
      };
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      const anchorSnapshotId = [...messages]
        .reverse()
        .find((message) => message.role === "user" && message.snapshotId)?.snapshotId;
      const batches = createToolCallBatches(toolCalls);

      for (const batch of batches) {
        // 按调用顺序登记；工具块在授权通过、真正开始执行时才出现在对话区。
        for (const tc of batch.calls) {
          const registeredArgs = (validateToolCall(tc).arguments || {}) as Record<string, unknown>;
          toolRunView.register(
            tc.id,
            tc.function.name,
            summarizeToolCall(tc.function.name, registeredArgs),
          );
        }
        const executeCall = async (tc: ToolCall, batchIndex: number): Promise<BatchItemResult> => {
          if (isTurnAborted) {
            return { tc, toolName: tc.function.name, args: {}, duration: 0, skipped: true };
          }
          const toolName = tc.function.name;
          const targetTool = toolsMap.get(toolName);
          if (!targetTool) {
            toolRunView.finish(tc.id, { status: "failed", text: `工具 "${toolName}" 未注册` }, 0);
            return { tc, toolName, args: {}, duration: 0, unregistered: true };
          }
          const parsedToolCall = validateToolCall(tc);
          const args = (parsedToolCall.arguments || {}) as Record<string, unknown>;
          try {
            const execution = await toolExecutor.execute(toolName, args, {
              toolCallId: tc.id,
              abortSignal: requestAbortController.signal,
              depth: 0,
              userIntent: lastUserMsg,
              permissionMode: deps.getPermissionMode(),
              riskThreshold: deps.getRiskThreshold(),
              anchorSnapshotId,
              suppressStatus: batch.parallel,
              batchIndex,
              batchSize: batch.calls.length,
              onProgress: (progress) => toolRunView.output(tc.id, progress.chunk),
            });
            toolRunView.finish(
              tc.id,
              summarizeToolResult(toolName, execution.output, execution, args),
              execution.duration,
            );
            return { tc, toolName, args, duration: execution.duration, execution };
          } catch (error) {
            if (!isTurnAborted || !(error instanceof TerminalInputCancelledError)) throw error;
            return { tc, toolName, args, duration: 0, skipped: true };
          }
        };

        if (batch.parallel) {
          activityIndicator.start("batch", `并行运行 ${batch.calls.length} 个工具`);
        }
        let batchRun: Awaited<ReturnType<typeof runToolCallBatch<ToolCall, BatchItemResult>>>;
        try {
          batchRun = await runToolCallBatch(batch, executeCall);
        } finally {
          if (batch.parallel) activityIndicator.stop();
          // 整批结束后按调用顺序把工具块写入正文，实时区域随之清空。
          const committedCells = toolRunView.commit();
          if (committedCells) ui.writeChat(committedCells);
        }
        deps.setLastToolBatchOutputs(
          batchRun.results
            .filter((result) => result.execution)
            .map((result) => ({
              toolName: result.toolName,
              summary: summarizeToolCall(result.toolName, result.args),
              output: result.execution?.output ?? "",
            })),
        );
        for (const result of batchRun.results) {
          const { tc, toolName, args, execution } = result;
          if (result.skipped) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "[工具调用已跳过：用户中止了当前工作流]",
            });
            continue;
          }
          if (result.unregistered || !execution) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: `错误: 工具 "${toolName}" 未注册。`,
            });
            sessionManager.saveCurrentSession(messages);
            deps.updateStatusUI();
            continue;
          }

          const toolOutput = execution.output;
          if (
            deps.getPermissionMode() === "plan" &&
            toolName === "taskcreate" &&
            args.finalize === true &&
            toolOutput.includes(PLAN_READY_MARKER)
          ) {
            deps.setPlanReadyForReview(true);
            deps.setPlanReviewSummaryRequested(false);
          }
          messages.push({ role: "tool", tool_call_id: tc.id, content: toolOutput });
          // read 读到图片时工具结果只有文字摘要，图片本身随一条用户消息以多模态附件补给模型，
          // 模型才能真的“看到”图；顺序保持 tool → user，符合各 Provider 的消息拓扑。
          const toolImages = execution.images ?? [];
          if (toolImages.length > 0) {
            messages.push({
              role: "user",
              content: `[图片内容] read 读取的图片：${toolImages.map((image) => image.path).join("、")}`,
              attachments: toolImages.map((image) => ({
                mimeType: image.mimeType,
                base64: image.base64,
              })),
            });
          }
          sessionManager.saveCurrentSession(messages);
          deps.updateStatusUI();
        }
      }
      // 工具调用块后空一行：与下方思考/正文分隔
      ui.writeLine();
      if (isTurnAborted) {
        showAbortNotice();
        keepCalling = false;
      } else if (deps.getPermissionMode() === "plan" && deps.isPlanReadyForReview()) {
        if (!deps.isPlanReviewSummaryRequested()) {
          messages.push({
            role: "user",
            content:
              "[系统计划审阅要求] Todo 已创建完成。现在请停止调用工具，单独输出一份供用户审阅的简洁方案正文，说明总体思路、关键改动、风险和验证方式。不要只复述 Todo，不要执行计划。",
          });
          deps.setPlanReviewSummaryRequested(true);
          sessionManager.saveCurrentSession(messages);
          deps.updateStatusUI();
        }
        keepCalling = true;
      } else {
        keepCalling = true;
      }
    } else {
      if (deps.getPermissionMode() === "plan" && deps.isPlanReadyForReview()) {
        if (!textContent.trim()) {
          ui.writeLine(colors.warnLine("模型未输出可审阅的方案正文，本次不进入审批。"));
          keepCalling = false;
        } else {
          try {
            const review = await deps.readSelectionSafely({
              title: "Plan ready — choose how Haji should execute it",
              items: [
                {
                  value: "auto",
                  label: "Auto Execute",
                  description: "自动执行安全操作，高风险操作由安全引擎拦截",
                },
                {
                  value: "manual",
                  label: "Approve Manually",
                  description: "每个修改型工具都先请求你的批准",
                },
                {
                  value: "no",
                  label: "No, Revise Plan",
                  description: "留在 Plan Mode，继续修改计划",
                },
              ],
              selectedValue: "auto",
            });
            deps.setPlanReadyForReview(false);
            deps.setPlanReviewSummaryRequested(false);
            if (review.value === "auto" || review.value === "manual") {
              await deps.applyPermissionMode(review.value === "auto" ? "auto" : "default");
              messages.push({
                role: "user",
                content:
                  "[系统工作流通知] 用户已批准当前计划。必须先调用 tasklist 读取当前真实步骤；每个任务都严格按 updatetask(in_progress) → 实施 → 实际验证 → taskfinish 执行，即使任务看起来已完成也不得跳过 in_progress。每完成一项重新检查剩余任务是否需要更新；全部完成后执行一次总验证，通过后总结改动。",
              });
              sessionManager.saveCurrentSession(messages);
              deps.updateStatusUI();
              ui.writeLine(
                colors.okLine(`计划已批准，已切换到 [${deps.getPermissionMode()}] 并继续执行。`),
              );
              keepCalling = true;
            } else {
              ui.writeLine(colors.gray("计划未批准，仍处于 Plan Mode；你可以继续要求调整计划。"));
              keepCalling = false;
            }
          } catch (error) {
            deps.setPlanReadyForReview(false);
            deps.setPlanReviewSummaryRequested(false);
            if (error instanceof TerminalInputCancelledError) {
              ui.writeLine(colors.gray("计划审批已取消，仍处于 Plan 模式。"));
              keepCalling = false;
            } else {
              throw error;
            }
          }
        }
      } else {
        const unverifiedAgents = agentManager
          .list()
          .filter((agent) => agent.status === "awaiting_verification" && agent.result);
        if (unverifiedAgents.length > 0) {
          const ids = unverifiedAgents.map((agent) => agent.id).join(", ");
          ui.writeLine(
            colors.warnLine(
              `子代理结果尚未独立验证：${ids}。主 Agent 将继续验证，当前结论不能视为完成。`,
            ),
          );
          deps.refreshAgentVerificationContext(messages);
          sessionManager.saveCurrentSession(messages);
          keepCalling = true;
        } else {
          keepCalling = false;
        }
      }
    }
    sessionManager.saveCurrentSession(messages);
  }
  stopActiveTurnVisuals();
  if (!isTurnAborted && !turnFailed) {
    const summary = [
      `完成 · ${formatToolDuration(Date.now() - turnStartedAt)}`,
      turnOutputTokens !== undefined ? `输出 ${formatAgentTokens(turnOutputTokens)} tokens` : "",
      turnToolCalls > 0 ? `${turnToolCalls} 次工具调用（Ctrl+O 展开最后一批输出）` : "",
    ].filter(Boolean);
    ui.writeLine(colors.gray(`  ${summary.join(" · ")}`));
  }
  ui.onEsc();
  deps.setForegroundAbortSignal(undefined);
}
