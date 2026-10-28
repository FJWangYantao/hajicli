import { fitHint, SEQ, truncateText } from "./terminal-text.js";

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

/** 代理面板渲染选项。 */
export interface AgentPanelRenderOptions {
  /**
   * 紧凑模式（侧栏用）：只列仍在进行/排队/待验证的代理，已结束的收成一行计数。
   * 逐个已结束代理的明细走 /agents，不占用常驻侧栏行数。
   */
  compact?: boolean;
}

export function buildAgentPanelRows(
  items: readonly AgentPanelItem[],
  width: number,
  maxRows = 4,
  now = Date.now(),
  options: AgentPanelRenderOptions = {},
): string[] {
  if (items.length === 0 || maxRows <= 0) return [];
  const compact = options.compact === true;
  // 仍在占着注意力的代理：running 要盯，queued 要等，awaiting_verification 要人处理。
  const active = items.filter(
    (item) =>
      item.status === "running" ||
      item.status === "queued" ||
      item.status === "awaiting_verification",
  );
  const visible = compact ? active : items;
  const finished = items.length - active.length;
  const running = items.filter((item) => item.status === "running").length;
  const queued = items.filter((item) => item.status === "queued").length;
  const rows = [
    `${SEQ.boldAccent}代理 ${running} 运行中${queued ? ` · ${queued} 排队` : ""}${SEQ.reset}`,
  ];
  // 有已结束的项时留一行给计数：否则行数被进行中的项吃满，用户看不出还有没有跑完的。
  const capacity = finished > 0 ? Math.max(1, maxRows - 1) : maxRows;
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
  for (const agent of visible) {
    if (rows.length >= capacity) break;
    const icon = statusIcons[agent.status];
    const activity = agent.currentTool || (agent.activity === "responding" ? "回复中" : "思考中");
    const tokenBudget = agent.maxTokens
      ? `${formatAgentTokens(agent.totalTokens)}/${formatAgentTokens(agent.maxTokens)} tok`
      : `${formatAgentTokens(agent.totalTokens)} tok`;
    const toolBudget = agent.maxToolCalls
      ? ` · ${agent.toolCalls || 0}/${agent.maxToolCalls} tools`
      : "";
    const preview = agent.preview ? ` · ${agent.preview}` : "";
    const runtimeConfig = [agent.model, agent.provider, agent.reasoningEffort]
      .filter(Boolean)
      .join(" · ");
    const configSuffix = runtimeConfig ? ` · ${runtimeConfig}` : "";
    const elapsed = formatAgentElapsed(agent.startedAt, now);
    const tokenCompact = agent.maxTokens
      ? `${formatAgentTokens(agent.totalTokens)}/${formatAgentTokens(agent.maxTokens)}`
      : formatAgentTokens(agent.totalTokens);
    // 逐级瘦身：宽栏给全套，窄栏按「谁先让位」的顺序丢——配置、预览、工具数、单位、耗时。
    // 整格（角色 + 细节）一起挑，最后才截断，绝不留下 "… · 25k/" 这种半截数字。
    const detailVariants =
      agent.status === "running"
        ? [
            `${activity} · ${elapsed} · ${tokenBudget}${toolBudget}${preview}${configSuffix}`,
            `${activity} · ${elapsed} · ${tokenBudget}${toolBudget}`,
            `${activity} · ${elapsed} · ${tokenBudget}`,
            `${activity} · ${elapsed} · ${tokenCompact}`,
            `${activity} · ${tokenCompact}`,
            `${activity} · ${elapsed}`,
            activity,
          ]
        : [`${statusLabels[agent.status]}${configSuffix}`, statusLabels[agent.status]];
    const cellBudget = Math.max(1, width - agent.id.length - 4);
    const cell = fitHint(
      detailVariants.map((detail) => `${agent.role} · ${detail}`),
      cellBudget,
    );
    rows.push(`${SEQ.muted}${icon} ${agent.id}  ${truncateText(cell, cellBudget)}${SEQ.reset}`);
  }
  if (compact && finished > 0 && rows.length < maxRows) {
    rows.push(
      `${SEQ.muted}${truncateText(`… ${finished} 个已结束 · /agents 查看`, width)}${SEQ.reset}`,
    );
  }
  return rows;
}
