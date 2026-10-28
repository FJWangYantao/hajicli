import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { SEQ, terminalWidth, truncateText } from "./terminal-text.js";

export interface RecentSessionEntry {
  id: string;
  title: string;
  updatedAt: string;
  /** 会话停在哪：进行中的目标与任务计划进度（只给「继续上次」那条读）。 */
  progress?: SessionProgress;
}

export interface SessionProgress {
  /** 进行中的会话目标原文（已达成的不给）。 */
  goal?: string;
  /** 任务计划进度；没有计划时缺省。 */
  done?: number;
  total?: number;
  /** 正在做（或下一项待做）的任务。 */
  current?: string;
}

/**
 * 从会话目标与任务计划提炼「停在哪」：目标只取进行中的，任务数把已归档的完成项也算上。
 * 两者都没有返回 undefined（首页就不出这行）。
 */
export function buildSessionProgress(
  goal: { text: string; status: string } | undefined,
  plan:
    | {
        tasks: ReadonlyArray<{ content: string; status: string }>;
        completedTasks: ReadonlyArray<unknown>;
      }
    | null
    | undefined,
): SessionProgress | undefined {
  const progress: SessionProgress = {};
  if (goal?.status === "active" && goal.text.trim()) progress.goal = goal.text;
  if (plan) {
    const total = plan.tasks.length + plan.completedTasks.length;
    if (total > 0) {
      progress.total = total;
      progress.done =
        plan.completedTasks.length +
        plan.tasks.filter((task) => task.status === "completed").length;
      const current =
        plan.tasks.find((task) => task.status === "in_progress") ??
        plan.tasks.find((task) => task.status === "pending");
      if (current) progress.current = current.content;
    }
  }
  return progress.goal || progress.total ? progress : undefined;
}

/**
 * 「继续上次」下面那行：目标 · 任务 3/7 · 进行中 xxx。
 * 放不下时逐级去掉「进行中」与目标，只留进度，不截成半句；什么都没有返回空串。
 */
export function formatResumeDetail(progress: SessionProgress | undefined, width: number): string {
  if (!progress || width <= 0) return "";
  const clean = (text: string): string => sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
  const goal = progress.goal ? clean(progress.goal) : "";
  const tasks =
    progress.total && progress.total > 0 ? `任务 ${progress.done ?? 0}/${progress.total}` : "";
  const current = progress.current && tasks ? clean(progress.current) : "";
  const candidates = [
    [goal && `目标 ${goal}`, tasks, current && `进行中 ${current}`],
    [goal && `目标 ${goal}`, tasks],
    [tasks, current && `进行中 ${current}`],
    [tasks],
    [goal && `目标 ${goal}`],
  ];
  for (const parts of candidates) {
    const text = parts.filter(Boolean).join(" · ");
    if (text && terminalWidth(text) <= width) return text;
  }
  // 只剩目标且很长：目标本身允许截断（它是用户原话，留个开头就能认出来）。
  return goal
    ? truncateText(`目标 ${goal}`, width)
    : tasks && terminalWidth(tasks) <= width
      ? tasks
      : "";
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
