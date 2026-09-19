import { SEQ, truncateText } from "./terminal-text.js";

export interface AgentPanelItem {
  id: string;
  role: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  status:
    | "queued"
    | "running"
    | "awaiting_verification"
    | "verified"
    | "rejected"
    | "failed"
    | "aborted";
  startedAt?: number;
  currentTool?: string;
  activity?: "thinking" | "responding" | "tool";
  preview?: string;
  totalTokens: number;
  maxTokens?: number;
  toolCalls?: number;
  maxToolCalls?: number;
}

export function formatAgentElapsed(startedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return "0s";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export function formatAgentTokens(totalTokens: number): string {
  if (totalTokens < 1000) return String(totalTokens);
  return `${(totalTokens / 1000).toFixed(totalTokens < 10000 ? 1 : 0)}k`;
}

export function buildAgentPanelRows(
  items: readonly AgentPanelItem[],
  width: number,
  maxRows = 4,
  now = Date.now(),
): string[] {
  if (items.length === 0 || maxRows <= 0) return [];
  const running = items.filter((item) => item.status === "running").length;
  const queued = items.filter((item) => item.status === "queued").length;
  const rows = [
    `${SEQ.boldAccent}代理 ${running} 运行中${queued ? ` · ${queued} 排队` : ""}${SEQ.reset}`,
  ];
  const statusLabels: Record<AgentPanelItem["status"], string> = {
    queued: "排队中",
    running: "运行中",
    awaiting_verification: "待验证",
    verified: "已验证",
    rejected: "未通过",
    failed: "失败",
    aborted: "已中止",
  };
  const statusIcons: Record<AgentPanelItem["status"], string> = {
    queued: "○",
    running: "●",
    awaiting_verification: "◇",
    verified: "✓",
    rejected: "×",
    failed: "×",
    aborted: "■",
  };
  for (const agent of items) {
    if (rows.length >= maxRows) break;
    const icon = statusIcons[agent.status];
    const activity = agent.currentTool || (agent.activity === "responding" ? "回复中" : "思考中");
    const tokenBudget = agent.maxTokens
      ? `${formatAgentTokens(agent.totalTokens)}/${formatAgentTokens(agent.maxTokens)} tok`
      : `${formatAgentTokens(agent.totalTokens)} tok`;
    const toolBudget = agent.maxToolCalls
      ? ` · ${agent.toolCalls || 0}/${agent.maxToolCalls} tools`
      : "";
    const preview = agent.preview ? ` · ${agent.preview}` : "";
    const detail =
      agent.status === "running"
        ? `${activity} · ${formatAgentElapsed(agent.startedAt, now)} · ${tokenBudget}${toolBudget}${preview}`
        : statusLabels[agent.status];
    const runtimeConfig = [agent.model, agent.provider, agent.reasoningEffort]
      .filter(Boolean)
      .join(" · ");
    const configSuffix = runtimeConfig ? ` · ${runtimeConfig}` : "";
    rows.push(
      `${SEQ.muted}${icon} ${agent.id}  ${truncateText(`${agent.role} · ${detail}${configSuffix}`, Math.max(1, width - agent.id.length - 4))}${SEQ.reset}`,
    );
  }
  return rows;
}
