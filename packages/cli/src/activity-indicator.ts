import {
  formatToolCell,
  formatToolDuration,
  type ToolCellStatus,
  type ToolResultSummary,
} from "./cli-runtime.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";

export type ActivityPhase =
  | "thinking"
  | "responding"
  | "tool"
  | "batch"
  | "permission"
  | "compacting"
  | "stopping";

export type ActivityTone = "active" | "waiting" | "stalled";

export interface ActivityState {
  phase: ActivityPhase;
  label: string;
  detail?: string;
  startedAt: number;
  lastProgressAt: number;
}

export interface ActivityFrame {
  phase: ActivityPhase;
  tone: ActivityTone;
  icon: string;
  label: string;
  elapsed: string;
  detail?: string;
  idleText?: string;
  /** 当前阶段开始时间戳（ms）：活动行据此决定“Esc 中止”提示的显示窗口。 */
  startedAt?: number;
}

interface ActivityIndicatorOptions {
  render: (frame?: ActivityFrame) => void;
  now?: () => number;
  intervalMs?: number;
  waitingAfterMs?: number;
  stalledAfterMs?: number;
  schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  cancel?: (timer: ReturnType<typeof setInterval>) => void;
}

const PHASE_ICONS: Readonly<Record<ActivityPhase, readonly string[]>> = {
  thinking: ["✦", "✧", "⋆", "·", "⋆", "✧"],
  responding: ["▁▂▃", "▂▃▄", "▃▄▅", "▄▅▆", "▅▆▇", "▄▅▆", "▃▄▅", "▂▃▄"],
  tool: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  batch: ["◐", "◓", "◑", "◒"],
  // 等待用户确认时保持静止：动画会让人误以为程序仍在忙。
  permission: ["◆"],
  compacting: ["◜", "◝", "◞", "◟"],
  stopping: ["■", "□"],
};

export const DEFAULT_ACTIVITY_WAITING_MS = 12_000;
export const DEFAULT_ACTIVITY_STALLED_MS = 30_000;

function oneLine(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) return undefined;
  const normalized = sanitizeTerminalText(value)
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export function formatActivityDuration(durationMs: number): string {
  const safeMs = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${String(remainingSeconds).padStart(2, "0")}s`;
}

export function buildActivityFrame(
  state: ActivityState,
  tick: number,
  now = Date.now(),
  waitingAfterMs = DEFAULT_ACTIVITY_WAITING_MS,
  stalledAfterMs = DEFAULT_ACTIVITY_STALLED_MS,
): ActivityFrame {
  const elapsedMs = Math.max(0, now - state.startedAt);
  const idleMs = Math.max(0, now - state.lastProgressAt);
  const isPermission = state.phase === "permission";
  const tone: ActivityTone = isPermission
    ? "waiting"
    : idleMs >= stalledAfterMs
      ? "stalled"
      : idleMs >= waitingAfterMs
        ? "waiting"
        : "active";
  const icons = PHASE_ICONS[state.phase];

  return {
    phase: state.phase,
    tone,
    icon: icons[((tick % icons.length) + icons.length) % icons.length],
    label: state.label,
    elapsed: formatActivityDuration(elapsedMs),
    detail: state.detail,
    startedAt: state.startedAt,
    // 本阶段从未有过进展时，空闲时长与已用时长相同，不再重复显示。
    idleText:
      !isPermission && tone !== "active" && state.lastProgressAt > state.startedAt
        ? `${formatActivityDuration(idleMs)} 无新进展`
        : undefined,
  };
}

/**
 * Drives the single transient activity row. It owns one bounded animation timer
 * and records progress separately from elapsed time so long silent waits are
 * visible without treating them as failures.
 */
export class ActivityIndicator {
  private readonly renderFrame: (frame?: ActivityFrame) => void;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly waitingAfterMs: number;
  private readonly stalledAfterMs: number;
  private readonly schedule: NonNullable<ActivityIndicatorOptions["schedule"]>;
  private readonly cancel: NonNullable<ActivityIndicatorOptions["cancel"]>;
  private state?: ActivityState;
  private timer?: ReturnType<typeof setInterval>;
  private tick = 0;
  private lastRenderedAt = 0;

  constructor(options: ActivityIndicatorOptions) {
    this.renderFrame = options.render;
    this.now = options.now || Date.now;
    this.intervalMs = Math.max(80, options.intervalMs || 140);
    this.waitingAfterMs = Math.max(1_000, options.waitingAfterMs || DEFAULT_ACTIVITY_WAITING_MS);
    this.stalledAfterMs = Math.max(
      this.waitingAfterMs + 1_000,
      options.stalledAfterMs || DEFAULT_ACTIVITY_STALLED_MS,
    );
    this.schedule =
      options.schedule || ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancel = options.cancel || ((timer) => clearInterval(timer));
  }

  start(phase: ActivityPhase, label: string, detail?: string): void {
    this.clearTimer();
    const now = this.now();
    this.state = {
      phase,
      label: oneLine(label, 48) || label,
      detail: oneLine(detail),
      startedAt: now,
      lastProgressAt: now,
    };
    this.tick = 0;
    this.emit(now);
    if (phase === "permission") return;
    this.timer = this.schedule(() => {
      this.tick += 1;
      this.emit(this.now());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  transition(phase: ActivityPhase, label: string, detail?: string): void {
    this.start(phase, label, detail);
  }

  progress(detail?: string): void {
    if (!this.state) return;
    const now = this.now();
    this.state.lastProgressAt = now;
    const normalizedDetail = oneLine(detail);
    if (normalizedDetail) this.state.detail = normalizedDetail;
    if (now - this.lastRenderedAt >= Math.min(100, this.intervalMs)) this.emit(now);
  }

  stop(): void {
    if (!this.state && !this.timer) return;
    this.clearTimer();
    this.state = undefined;
    this.renderFrame(undefined);
  }

  private emit(now: number): void {
    if (!this.state) return;
    this.lastRenderedAt = now;
    this.renderFrame(
      buildActivityFrame(this.state, this.tick, now, this.waitingAfterMs, this.stalledAfterMs),
    );
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }
}

const TOOL_OUTPUT_TAIL_LINES = 4;

interface ToolRunEntry {
  id: string;
  toolName: string;
  summary: string;
  sourceLabel?: string;
  status: ToolCellStatus | "pending";
  startedAt: number;
  durationMs?: number;
  resultText?: string;
  preview?: string[];
  outputTail: string[];
  partialLine: string;
  /** 自动模式判定结论及其过期时间：只挂在实时区域，不进对话正文。 */
  verdict?: { text: string; until: number };
}

interface ToolRunViewOptions {
  /** 把实时区域文本交给界面；空串表示清除。 */
  render: (text: string) => void;
  getWidth: () => number;
  now?: () => number;
  intervalMs?: number;
  schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  cancel?: (timer: ReturnType<typeof setInterval>) => void;
}

/**
 * 对话区底部的实时工具块：工具一开始执行就出现，运行中滚动显示输出尾部，
 * 结束后原地变为 ✓/✕ 摘要；commit() 把整批结果按调用顺序交还给对话正文。
 */
export class ToolRunView {
  private readonly renderText: (text: string) => void;
  private readonly getWidth: () => number;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly schedule: NonNullable<ToolRunViewOptions["schedule"]>;
  private readonly cancel: NonNullable<ToolRunViewOptions["cancel"]>;
  private readonly entries: ToolRunEntry[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: ToolRunViewOptions) {
    this.renderText = options.render;
    this.getWidth = options.getWidth;
    this.now = options.now || Date.now;
    // 运行中的符号是静止的 ●（动画只留给对话区尾部的活动行），定时器只负责刷新耗时与判定结论的过期。
    this.intervalMs = Math.max(60, options.intervalMs || 250);
    this.schedule =
      options.schedule || ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancel = options.cancel || ((timer) => clearInterval(timer));
  }

  /** 按调用顺序登记一个工具；在 start() 之前不显示（例如仍在等待授权）。 */
  register(id: string, toolName: string, summary: string, sourceLabel?: string): void {
    if (this.find(id)) return;
    this.entries.push({
      id,
      toolName,
      summary,
      sourceLabel,
      status: "pending",
      startedAt: this.now(),
      outputTail: [],
      partialLine: "",
    });
  }

  start(id: string): void {
    const entry = this.find(id);
    if (entry?.status !== "pending" && entry?.status !== "judging") return;
    entry.status = "running";
    entry.startedAt = this.now();
    this.ensureTimer();
    this.flush();
  }

  /**
   * 自动模式开始判定：先把这个工具格显示出来（符号 ◈、耗时显示“判定中”），
   * 让判定过程落在对话区的活动行里，而不是底栏状态行。
   */
  judge(id: string): void {
    const entry = this.find(id);
    if (entry?.status !== "pending") return;
    entry.status = "judging";
    entry.startedAt = this.now();
    this.ensureTimer();
    this.flush();
  }

  /** 判定结论：挂在工具格右侧几秒后自然消失，随动画帧刷新。 */
  judged(id: string, verdict: string, ttlMs = 3_000): void {
    const entry = this.find(id);
    if (!entry) return;
    entry.verdict = { text: verdict, until: this.now() + ttlMs };
    this.flush();
  }

  output(id: string, chunk: string): void {
    const entry = this.find(id);
    if (entry?.status !== "running") return;
    const text = `${entry.partialLine}${chunk}`.replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    // 只用 \r 刷新、从不换行的进度输出不能让未完成行无限增长。
    entry.partialLine = (lines.pop() ?? "").slice(-2048);
    for (const line of lines) {
      // 回车覆盖式进度条只保留最后一次刷新的内容。
      const visible = cleanOutputLine(line);
      if (!visible) continue;
      entry.outputTail.push(visible);
      if (entry.outputTail.length > TOOL_OUTPUT_TAIL_LINES) entry.outputTail.shift();
    }
    this.flush();
  }

  finish(id: string, result: ToolResultSummary, durationMs: number): void {
    const entry = this.find(id);
    if (!entry) return;
    entry.status = result.status;
    entry.resultText = result.text;
    entry.preview = result.preview;
    entry.durationMs = durationMs;
    if (!this.entries.some((item) => item.status === "running" || item.status === "judging")) {
      this.clearTimer();
    }
    this.flush();
  }

  hasEntries(): boolean {
    return this.entries.length > 0;
  }

  /** 返回已结束条目的最终文本（按登记顺序）并清空实时区域。 */
  commit(): string {
    const width = this.getWidth();
    const text = this.entries
      .filter(
        (entry) =>
          entry.status !== "pending" && entry.status !== "running" && entry.status !== "judging",
      )
      .flatMap((entry) => this.formatEntry(entry, width, false))
      .map((row) => `${row}\n`)
      .join("");
    this.reset();
    return text;
  }

  reset(): void {
    this.entries.length = 0;
    this.clearTimer();
    this.renderText("");
  }

  private find(id: string): ToolRunEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  private formatEntry(entry: ToolRunEntry, width: number, live = true): string[] {
    if (entry.status === "pending") return [];
    const judging = entry.status === "judging";
    const running = entry.status === "running";
    const outputTail = running
      ? [...entry.outputTail, cleanOutputLine(entry.partialLine)]
          .filter(Boolean)
          .slice(-TOOL_OUTPUT_TAIL_LINES)
      : undefined;
    return formatToolCell({
      status: entry.status,
      toolName: entry.toolName,
      summary: entry.summary,
      sourceLabel: entry.sourceLabel,
      width,
      timing: judging
        ? `判定中 ${formatActivityDuration(this.now() - entry.startedAt)}`
        : running
          ? formatActivityDuration(this.now() - entry.startedAt)
          : entry.durationMs !== undefined && entry.status !== "rejected"
            ? formatToolDuration(entry.durationMs)
            : undefined,
      verdict:
        live && entry.verdict && this.now() < entry.verdict.until ? entry.verdict.text : undefined,
      resultText: entry.resultText,
      preview: entry.preview,
      outputTail,
    });
  }

  private flush(): void {
    const width = this.getWidth();
    const rows = this.entries.flatMap((entry) => this.formatEntry(entry, width));
    this.renderText(rows.length ? `${rows.join("\n")}\n` : "");
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }
}

function cleanOutputLine(line: string): string {
  const lastFrame =
    line
      .split("\r")
      .filter((part) => part.trim())
      .at(-1) || "";
  return sanitizeTerminalText(lastFrame).replace(/\t/g, "  ").trimEnd();
}
