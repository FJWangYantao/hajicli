import { sanitizeTerminalText } from './terminal-sanitize.js';

export type ActivityPhase =
  | 'thinking'
  | 'responding'
  | 'tool'
  | 'batch'
  | 'permission'
  | 'compacting'
  | 'stopping';

export type ActivityTone = 'active' | 'waiting' | 'stalled';

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
  meter: string;
  elapsed: string;
  detail?: string;
  idleText?: string;
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
  thinking: ['✦', '✧', '⋆', '·', '⋆', '✧'],
  responding: ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▇', '▄▅▆', '▃▄▅', '▂▃▄'],
  tool: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  batch: ['◐', '◓', '◑', '◒'],
  permission: ['◆', '◇'],
  compacting: ['◜', '◝', '◞', '◟'],
  stopping: ['■', '□']
};

export const DEFAULT_ACTIVITY_WAITING_MS = 12_000;
export const DEFAULT_ACTIVITY_STALLED_MS = 30_000;

function oneLine(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) return undefined;
  const normalized = sanitizeTerminalText(value).replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export function formatActivityDuration(durationMs: number): string {
  const safeMs = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${String(remainingSeconds).padStart(2, '0')}s`;
}

function buildPulseMeter(tick: number, width = 7): string {
  const cycle = Math.max(1, (width - 1) * 2);
  const offset = ((tick % cycle) + cycle) % cycle;
  const head = offset < width ? offset : cycle - offset;
  return Array.from({ length: width }, (_, index) => {
    if (index === head) return '▰';
    if (Math.abs(index - head) === 1) return '▱';
    return '·';
  }).join('');
}

export function buildActivityFrame(
  state: ActivityState,
  tick: number,
  now = Date.now(),
  waitingAfterMs = DEFAULT_ACTIVITY_WAITING_MS,
  stalledAfterMs = DEFAULT_ACTIVITY_STALLED_MS
): ActivityFrame {
  const elapsedMs = Math.max(0, now - state.startedAt);
  const idleMs = Math.max(0, now - state.lastProgressAt);
  const isPermission = state.phase === 'permission';
  const tone: ActivityTone = isPermission
    ? 'waiting'
    : idleMs >= stalledAfterMs
      ? 'stalled'
      : idleMs >= waitingAfterMs
        ? 'waiting'
        : 'active';
  const icons = PHASE_ICONS[state.phase];

  return {
    phase: state.phase,
    tone,
    icon: icons[((tick % icons.length) + icons.length) % icons.length],
    label: state.label,
    meter: buildPulseMeter(tick),
    elapsed: formatActivityDuration(elapsedMs),
    detail: state.detail,
    idleText: !isPermission && tone !== 'active'
      ? `${formatActivityDuration(idleMs)} 无新事件`
      : undefined
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
  private readonly schedule: NonNullable<ActivityIndicatorOptions['schedule']>;
  private readonly cancel: NonNullable<ActivityIndicatorOptions['cancel']>;
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
      options.stalledAfterMs || DEFAULT_ACTIVITY_STALLED_MS
    );
    this.schedule = options.schedule || ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancel = options.cancel || (timer => clearInterval(timer));
  }

  start(phase: ActivityPhase, label: string, detail?: string): void {
    this.clearTimer();
    const now = this.now();
    this.state = {
      phase,
      label: oneLine(label, 48) || label,
      detail: oneLine(detail),
      startedAt: now,
      lastProgressAt: now
    };
    this.tick = 0;
    this.emit(now);
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
    this.renderFrame(buildActivityFrame(
      this.state,
      this.tick,
      now,
      this.waitingAfterMs,
      this.stalledAfterMs
    ));
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }
}
