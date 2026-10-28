import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { SEQ, truncateText } from "./terminal-text.js";

export interface RecentSessionEntry {
  id: string;
  title: string;
  updatedAt: string;
}

export interface StartupAction {
  label: string;
  value: string;
  kind: "prompt" | "resume";
}

export function startupActions(sessions: readonly RecentSessionEntry[]): StartupAction[] {
  return [
    { label: "了解当前项目", value: "请梳理当前项目的结构、主要入口和运行方式。", kind: "prompt" },
    {
      label: "检查工作区",
      value: "请检查当前工作区的代码改动，找出潜在问题和回归风险。",
      kind: "prompt",
    },
    { label: "描述一个需求", value: "我想实现一个功能：", kind: "prompt" },
    ...sessions.slice(0, 3).map((session) => ({
      label: session.title,
      value: session.id,
      kind: "resume" as const,
    })),
  ];
}

export function relativeTime(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
}

/** 首屏只构建展示行与命中位置，入口不进入对话历史。 */
export function buildStartupHome(
  sessions: readonly RecentSessionEntry[],
  width: number,
  maxRows: number,
  selected = -1,
  now = Date.now(),
): { rows: string[]; hits: Array<{ row: number; index: number }> } {
  const rows: string[] = [];
  const hits: Array<{ row: number; index: number }> = [];
  if (width < 16 || maxRows < 3) return { rows, hits };
  const clean = (text: string): string => sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
  const push = (text: string): void => {
    rows.push(truncateText(text, width));
  };
  const action = (label: string, index: number): void => {
    if (rows.length >= maxRows) return;
    hits.push({ row: rows.length, index });
    const text = truncateText(`${selected === index ? "›" : "·"} ${clean(label)}`, width);
    rows.push(`${selected === index ? SEQ.boldAccent : SEQ.muted}${text}${SEQ.reset}`);
  };
  push("从这里开始");
  const actions = startupActions(sessions);
  for (let index = 0; index < 3; index++) action(actions[index].label, index);
  if (sessions.length > 0 && rows.length + 2 < maxRows) {
    push("");
    push("最近会话");
    sessions.slice(0, 3).forEach((session, index) => {
      const stamp = relativeTime(session.updatedAt, now);
      action(`${clean(session.title) || "未命名会话"}${stamp ? ` · ${stamp}` : ""}`, index + 3);
    });
  }
  if (rows.length + 1 < maxRows) {
    push("");
    push("Tab 选择 · Enter 打开 · 点击入口");
  }
  return { rows, hits };
}
