/**
 * 驱动服务（`haji mcp-serve`）的运行入口：把本进程当作常驻 haji，经 MCP stdio 对外提供
 * 「发消息 + 调整 + 查状态」工具面。复用主流程的全部接线（TurnDeps），只替换授权通道与输出出口。
 *
 * 会话状态（模型、权限档、provider 实例）仍由 index.ts 的闭包持有，这里经 ServeModeContext
 * 的访问器读写，不拷贝值——回合中 /model 之类的切换与驱动侧的 haji_adjust 看到的是同一份状态。
 */
import type { ChatMessage, PermissionMode, ReasoningEffort, SessionManager } from "@hajicli/core";
import type { CostSummary, CostTracker } from "./cost-tracker.js";
import { startMcpStdio } from "./driver/index.js";
import { DriverServer } from "./driver/server.js";
import type { DriverPatch, DriverStatus, DriverTurnResult, DriverUsage } from "./driver/types.js";
import type { ServeRequest } from "./serve-args.js";
import type { SharedToolExecutor } from "./tool-executor.js";
import { runAgentTurn, type TurnDeps, type TurnOutcome } from "./turn-runner.js";

export interface ServeModeContext {
  serveRequest: ServeRequest;
  turnDeps: TurnDeps;
  toolExecutor: SharedToolExecutor;
  costTracker: CostTracker;
  sessionManager: SessionManager;
  /** 驱动模式的选择通道：授权卡片 / 计划审批 / 受控申请一律发事件，等外部 haji_approve。 */
  askSelection: TurnDeps["readSelectionSafely"];
  getChatLength(): number;
  requestAbort(): boolean;
  getSelectedModel(): string;
  getReasoningEffort(): ReasoningEffort;
  getPermissionMode(): PermissionMode;
  /** 当前渠道的展示名（haji_status.provider）。 */
  getProviderLabel(): string;
  getMessageCount(): number;
  /** 切模型：未知模型返回 undefined；成功时重建 provider 并返回新的渠道名。 */
  switchModel(model: string): string | undefined;
  setReasoningEffort(effort: ReasoningEffort): void;
  setThinkingVisible(visible: boolean): void;
  applyPermissionMode(mode: PermissionMode, options: { persist?: boolean }): Promise<void>;
  requestPromptRefresh(): Promise<void>;
  updateStatusUI(): void;
  /** 服务就绪前攒下的输出（启动期报错等），就绪后补发成 notice 事件。 */
  takeBufferedOutput(): string[];
  /** 登记 / 注销当前驱动服务：输出出口与 askSelection 据此改道。 */
  setDriverServer(server: DriverServer | undefined): void;
}

/** 驱动事件里的工具入参摘要：截断避免长参数把事件撑爆。 */
function summarizeDriverArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "(无法序列化)";
  }
}

/** 驱动事件里的工具输出摘要：只要开头一段，完整结果模型仍能在会话里读到。 */
function summarizeDriverOutput(output: string): string {
  return output.length > 300 ? `${output.slice(0, 300)}…` : output;
}

/** 最后一条非空助手正文（回合结果的 text；无头 JSON 输出同口径）。 */
export function lastAssistantText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.trim().length > 0
    ) {
      return message.content;
    }
  }
  return "";
}

function toDriverUsage(summary: CostSummary, base?: CostSummary): DriverUsage {
  return {
    requests: summary.requests - (base?.requests ?? 0),
    promptTokens: summary.promptTokens - (base?.promptTokens ?? 0),
    completionTokens: summary.completionTokens - (base?.completionTokens ?? 0),
    estimatedCostCny: Number((summary.totalCostCny - (base?.totalCostCny ?? 0)).toFixed(6)),
  };
}

export async function runServeMode(ctx: ServeModeContext): Promise<void> {
  const { costTracker, sessionManager, toolExecutor, turnDeps } = ctx;
  let driverServer: DriverServer | undefined;

  // 工具执行进度：包一层 executor，把 start/end 发成事件（不改引擎本身）。
  const toolEventExecutor = Object.create(toolExecutor) as SharedToolExecutor;
  toolEventExecutor.execute = async (toolName, args, context) => {
    driverServer?.emit({ type: "tool_start", name: toolName, args: summarizeDriverArgs(args) });
    const startedAt = Date.now();
    const result = await toolExecutor.execute(toolName, args, context);
    driverServer?.emit({
      type: "tool_end",
      name: toolName,
      ok: !result.blocked && !result.rejected,
      durationMs: Date.now() - startedAt,
      summary: summarizeDriverOutput(result.output),
    });
    return result;
  };

  let lastOutcome: TurnOutcome | undefined;
  const driverTurnDeps: TurnDeps = {
    ...turnDeps,
    readSelectionSafely: ctx.askSelection,
    toolExecutor: toolEventExecutor,
    onTurnSettled: (outcome) => {
      lastOutcome = outcome;
    },
  };

  const adjust = async (patch: DriverPatch) => {
    const applied: Record<string, unknown> = {};
    const errors: string[] = [];
    if (patch.model !== undefined) {
      const providerName = ctx.switchModel(patch.model);
      if (providerName === undefined) {
        errors.push(`未知模型：${patch.model}`);
      } else {
        applied.model = patch.model;
        applied.provider = providerName;
      }
    }
    if (patch.effort !== undefined) {
      ctx.setReasoningEffort(patch.effort);
      applied.effort = patch.effort;
    }
    if (patch.thinkingVisible !== undefined) {
      ctx.setThinkingVisible(patch.thinkingVisible);
      applied.thinkingVisible = patch.thinkingVisible;
    }
    if (patch.permissionMode !== undefined) {
      await ctx.applyPermissionMode(patch.permissionMode, { persist: false });
      applied.permissionMode = ctx.getPermissionMode();
    }
    if (patch.plan !== undefined) {
      await ctx.applyPermissionMode(patch.plan ? "plan" : "default", { persist: false });
      applied.plan = patch.plan;
      applied.permissionMode = ctx.getPermissionMode();
    }
    if (errors.length === 0) {
      await ctx.requestPromptRefresh();
      ctx.updateStatusUI();
    }
    return { applied, errors };
  };

  driverServer = new DriverServer(
    {
      runTurn: async (text) => {
        lastOutcome = undefined;
        const startedAt = Date.now();
        const before = costTracker.getSummary();
        await runAgentTurn(driverTurnDeps, {
          forwardedPrompt: text,
          commandInput: text,
          manualSkillExchange: undefined,
          promptDisplayStartOffset: ctx.getChatLength(),
        });
        // 回合没走到收尾（例如抛错前就退出）时没有 outcome，按失败上报。
        const outcome = lastOutcome ?? { aborted: false, failed: true, toolCalls: 0 };
        return {
          ok: !outcome.aborted && !outcome.failed,
          text: lastAssistantText(turnDeps.getMessages()),
          sessionId: sessionManager.getCurrentSession().id,
          model: ctx.getSelectedModel(),
          permissionMode: ctx.getPermissionMode(),
          toolCalls: outcome.toolCalls,
          durationMs: Date.now() - startedAt,
          usage: toDriverUsage(costTracker.getSummary(), before),
        } satisfies DriverTurnResult;
      },
      status: (): DriverStatus => {
        const session = sessionManager.getCurrentSession();
        return {
          sessionId: session.id,
          sessionTitle: session.title,
          model: ctx.getSelectedModel(),
          provider: ctx.getProviderLabel(),
          effort: ctx.getReasoningEffort(),
          permissionMode: ctx.getPermissionMode(),
          cwd: process.cwd(),
          running: false,
          messageCount: ctx.getMessageCount(),
          usage: toDriverUsage(costTracker.getSummary()),
        };
      },
      adjust,
      cancel: () => ctx.requestAbort(),
      close: async () => {
        await sessionManager.flush();
      },
    },
    { waitMs: ctx.serveRequest.waitMs, approval: ctx.serveRequest.approval },
  );

  ctx.setDriverServer(driverServer);
  for (const line of ctx.takeBufferedOutput()) driverServer.emit({ type: "notice", text: line });
  try {
    await startMcpStdio(driverServer);
  } finally {
    ctx.setDriverServer(undefined);
  }
}
