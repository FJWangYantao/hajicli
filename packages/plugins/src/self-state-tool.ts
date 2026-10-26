import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";

/**
 * `selfstate`：按需查询「我现在的运行状态」。
 *
 * 为什么是工具而不是提示词：状态里包含 token 用量、压缩是否布防、当前权限档
 * 这类每回合都可能变的数据。写进系统提示词会让公共前缀每轮变一次，白白
 * 失效 provider 的隐式前缀缓存；做成工具则是调用时才付费。
 *
 * 这里只做「读」：不改权限、不改工作区、不写盘，也不调用模型。
 */

export type SelfStateRootSource = "cwd" | "add-dir" | "workspace";

export interface SelfStateRoot {
  path: string;
  source: SelfStateRootSource;
}

export interface SelfStateContext {
  usedTokens: number;
  windowTokens: number;
  triggerTokens: number;
  emergencyTokens: number;
  /** 自动压缩是否处于布防状态（低于 rearm 线才会重新布防）。 */
  armed: boolean;
  lastCompaction?: {
    at: string;
    beforeTokens: number;
    afterTokens: number;
    layers: string[];
  };
}

export interface SelfStateSnapshot {
  cwd: string;
  os: string;
  roots: SelfStateRoot[];
  permissionMode: string;
  riskThreshold?: string;
  model: string;
  provider: string;
  reasoningEffort: string;
  context: SelfStateContext;
  session: { id: string; title: string; userTurns: number; goal?: SelfStateGoal };
  gitBranch?: string;
  /** 子代理调用时带上，便于它知道自己的角色与深度。 */
  agent?: { id: string; depth: number };
}

/** 会话目标（setgoal 记录）；selfstate 里只暴露摘要字段，完整行为约束在系统提示词里。 */
export interface SelfStateGoal {
  text: string;
  status: "active" | "achieved";
  createdAt: string;
  /** 达成时刻（已达成时存在）。 */
  achievedAt?: string;
  /** 完成审计摘要（goalfinish 留档）。 */
  evidence?: string;
}

const ROOT_LABELS: Record<SelfStateRootSource, string> = {
  cwd: "启动目录",
  "add-dir": "--add-dir",
  workspace: "/workspace add",
};

function formatTokens(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatPercent(used: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "未知";
  return `${((used / total) * 100).toFixed(1)}%`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/** 纯函数：把快照渲染成紧凑的多行文本（约 10 行，避免挤占上下文）。 */
export function formatSelfState(snapshot: SelfStateSnapshot): string {
  const { context } = snapshot;
  const lines: string[] = ["# 当前运行状态"];

  lines.push(
    `- 会话：${snapshot.session.title || "(未命名)"}（${snapshot.session.id}）· 用户回合 ${snapshot.session.userTurns}`,
  );
  if (snapshot.session.goal) {
    const { text, status, createdAt, achievedAt, evidence } = snapshot.session.goal;
    const goalText = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    const achievedNote =
      status === "achieved" && achievedAt ? `（达成于 ${formatTime(achievedAt)}）` : "";
    lines.push(
      `- 目标：${status === "active" ? "进行中" : "已达成"}${achievedNote}（设定于 ${formatTime(createdAt)}）· ${goalText}`,
    );
    if (status === "achieved" && evidence) {
      const evidenceText = evidence.length > 120 ? `${evidence.slice(0, 120)}…` : evidence;
      lines.push(`- 目标完成审计：${evidenceText}`);
    }
  }
  lines.push(`- 工作目录：${snapshot.cwd}`);
  if (snapshot.roots.length > 0) {
    const roots = snapshot.roots
      .map((root) => `${root.path}（${ROOT_LABELS[root.source] ?? root.source}）`)
      .join("；");
    lines.push(`- 工作区根：${roots}`);
  }
  const risk = snapshot.riskThreshold ? `，危险阈值 ${snapshot.riskThreshold}` : "";
  lines.push(`- 权限档：${snapshot.permissionMode}${risk}`);
  lines.push(
    `- 模型：${snapshot.model} · provider ${snapshot.provider} · 强度 ${snapshot.reasoningEffort}`,
  );
  lines.push(
    `- 上下文：${formatTokens(context.usedTokens)} / ${formatTokens(context.windowTokens)} tokens（${formatPercent(
      context.usedTokens,
      context.windowTokens,
    )}）· 自动压缩 ${formatTokens(context.triggerTokens)} · 紧急线 ${formatTokens(context.emergencyTokens)} · ${
      context.armed ? "已布防" : "未布防（仅紧急线会触发）"
    }`,
  );
  if (context.lastCompaction) {
    const { at, beforeTokens, afterTokens, layers } = context.lastCompaction;
    const layerText = layers.length > 0 ? `（${layers.join(" -> ")}）` : "";
    lines.push(
      `- 上次压缩：${formatTime(at)} · ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens${layerText}`,
    );
  }
  if (snapshot.gitBranch) lines.push(`- Git 分支：${snapshot.gitBranch}`);
  lines.push(`- 系统：${snapshot.os}`);
  if (snapshot.agent) {
    lines.push(`- 调用方：子代理 ${snapshot.agent.id}（depth ${snapshot.agent.depth}）`);
  }
  return lines.join("\n");
}

export class SelfStateTool implements BaseTool {
  public readonly name = "selfstate";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "selfstate",
      description:
        "查询本会话的运行时状态：工作区根（含追加目录）、当前权限档、模型、上下文用量与压缩阈值、会话与目标、Git 分支。只读、无副作用。不确定路径边界、上下文余量或当前权限档时先调用它，不要靠试探性调用来推断。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  };

  public constructor(private readonly snapshot: () => SelfStateSnapshot) {}

  public async execute(
    _args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const snapshot = this.snapshot();
    // 子代理调用时补上自身的角色与深度，主代理保持原样。
    if (context?.agentId) {
      snapshot.agent = { id: context.agentId, depth: context.depth ?? 1 };
    }
    return formatSelfState(snapshot);
  }
}
