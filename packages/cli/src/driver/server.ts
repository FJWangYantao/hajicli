import type {
  DriverAdjustResult,
  DriverEvent,
  DriverHost,
  DriverPatch,
  DriverSelectionAnswer,
  DriverSelectionRequest,
  DriverSendOutcome,
  DriverStatus,
  DriverTurnResult,
} from "./types.js";

/** 等待 `haji_wait` 时值得中断轮询的事件：进度或需要外部决策。 */
const NOTABLE_EVENTS = new Set(["tool_end", "selection_request", "turn_end", "error"]);

const DEFAULT_MAX_EVENTS = 800;
const DEFAULT_SELECTION_TIMEOUT_MS = 300_000;
const TEXT_FLUSH_MS = 60;
/** turn_end 事件里携带的正文上限：够客户端拿到最终答案，又不至于把事件日志撑爆。 */
const MAX_TURN_TEXT = 20_000;

export interface DriverServerOptions {
  /** `haji_send` 未指定 waitMs 时的默认等待时长。 */
  waitMs: number;
  /** `ask`：需要授权时挂起等 `haji_approve`；`auto`：直接采用默认选项。 */
  approval: "ask" | "auto";
  maxEvents?: number;
  selectionTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 驱动服务端：事件日志 + 选择请求代理 + 回合串行队列。
 *
 * 只做协议侧的编排，真正的回合执行交给注入的 `DriverHost`（index.ts 里的闭包）。
 * 单进程同一时刻只有一个回合在跑，后续 `haji_send` 排队，避免并发写同一工作区。
 */
export class DriverServer {
  private readonly maxEvents: number;
  private readonly selectionTimeoutMs: number;

  private events: DriverEvent[] = [];
  private seq = 0;
  private oldestSeq = 1;
  private textBuffer = "";
  private textTimer: NodeJS.Timeout | null = null;

  private waiters = new Set<() => void>();
  private pendingSelections = new Map<
    string,
    { resolve: (answer: DriverSelectionAnswer) => void; fallback: DriverSelectionAnswer }
  >();
  private selectionSeq = 0;

  private taskSeq = 0;
  private runningTaskId: string | undefined;
  private queuedTasks = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private lastResult: DriverTurnResult | undefined;
  private closed = false;

  constructor(
    private readonly host: DriverHost,
    private readonly options: DriverServerOptions,
  ) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.selectionTimeoutMs = options.selectionTimeoutMs ?? DEFAULT_SELECTION_TIMEOUT_MS;
  }

  // ── 事件 ────────────────────────────────────────────────────────────

  /** 立即推送一个事件（会先把缓冲的正文增量冲刷出去，保证顺序）。 */
  emit(event: Omit<DriverEvent, "seq">): void {
    if (event.type !== "transcript") this.flushText();
    this.pushEvent(event);
  }

  /** 缓冲正文增量：短窗口合并，避免逐 token 事件把日志撑爆。 */
  emitText(text: string): void {
    if (!text) return;
    this.textBuffer += text;
    if (this.textTimer) return;
    this.textTimer = setTimeout(() => this.flushText(), TEXT_FLUSH_MS);
    this.textTimer.unref?.();
  }

  flushText(): void {
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
    if (!this.textBuffer) return;
    const text = this.textBuffer;
    this.textBuffer = "";
    this.pushEvent({ type: "transcript", text });
  }

  private pushEvent(event: Omit<DriverEvent, "seq">): void {
    const full = { seq: this.seq + 1, ...event } as DriverEvent;
    this.seq = full.seq;
    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
      this.oldestSeq = this.events[0]?.seq ?? this.seq + 1;
    }
    this.signal();
  }

  private signal(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  private waitForSignal(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      timer.unref?.();
      this.waiters.add(done);
    });
  }

  // ── 查询 ────────────────────────────────────────────────────────────

  get lastSeq(): number {
    return this.seq;
  }

  get running(): boolean {
    // 排队中（尚未真正开始）也算「在跑」：haji_wait 不能因为一个微任务的时间差提前返回 idle。
    return this.runningTaskId !== undefined || this.queuedTasks > 0;
  }

  /** `haji_send` 未指定 waitMs 时的默认值（来自 mcp-serve 启动参数）。 */
  get defaultWaitMs(): number {
    return this.options.waitMs;
  }

  history(
    sinceSeq: number,
    limit = 200,
  ): {
    events: DriverEvent[];
    lastSeq: number;
    oldestSeq: number;
    truncated: boolean;
    running: boolean;
    taskId?: string;
  } {
    this.flushText();
    const from = Number.isFinite(sinceSeq) ? Math.max(0, Math.floor(sinceSeq)) : 0;
    const selected = this.events.filter((event) => event.seq > from).slice(0, Math.max(1, limit));
    return {
      events: selected,
      lastSeq: this.seq,
      oldestSeq: this.oldestSeq,
      truncated: from > 0 && from < this.oldestSeq - 1,
      running: this.running,
      ...(this.runningTaskId ? { taskId: this.runningTaskId } : {}),
    };
  }

  /** 等到下一个值得报告的事件 / 回合结束 / 超时。 */
  async wait(
    sinceSeq: number,
    timeoutMs: number,
  ): Promise<{
    events: DriverEvent[];
    lastSeq: number;
    running: boolean;
    reason: "event" | "idle" | "timeout";
  }> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      this.flushText();
      const snapshot = this.history(sinceSeq, 500);
      const notable = snapshot.events.some((event) => NOTABLE_EVENTS.has(event.type));
      if (notable) return { ...snapshot, reason: "event" };
      if (!this.running) return { ...snapshot, reason: "idle" };
      const remain = deadline - Date.now();
      if (remain <= 0) return { ...snapshot, reason: "timeout" };
      await this.waitForSignal(Math.min(remain, 500));
    }
  }

  status(): DriverStatus {
    return this.host.status();
  }

  async adjust(patch: DriverPatch): Promise<DriverAdjustResult> {
    return this.host.adjust(patch);
  }

  // ── 回合 ────────────────────────────────────────────────────────────

  /** 投递一条消息；最多等 waitMs，没跑完就返回 running + taskId。 */
  async send(text: string, waitMs = this.options.waitMs): Promise<DriverSendOutcome> {
    if (this.closed) throw new Error("驱动服务已关闭");
    const taskId = `t${++this.taskSeq}`;
    const done = this.enqueueTurn(taskId, text);
    const outcome = await Promise.race([
      done.then((result) => ({ kind: "done" as const, result })),
      sleep(waitMs).then(() => ({ kind: "running" as const })),
    ]);
    if (outcome.kind === "done") {
      return { status: "done", taskId, result: outcome.result, lastSeq: this.lastSeq };
    }
    return {
      status: "running",
      taskId,
      lastSeq: this.lastSeq,
      hint: "回合仍在进行：用 haji_wait 继续等待，或用 haji_events 拉增量事件。",
    };
  }

  private enqueueTurn(taskId: string, text: string): Promise<DriverTurnResult> {
    this.queuedTasks += 1;
    const run = async (): Promise<DriverTurnResult> => {
      this.queuedTasks -= 1;
      this.runningTaskId = taskId;
      this.emit({ type: "turn_start", taskId, prompt: text });
      const startedAt = Date.now();
      let result: DriverTurnResult;
      try {
        result = await this.host.runTurn(text, taskId);
      } catch (error) {
        result = {
          ok: false,
          text: "",
          sessionId: "",
          model: "",
          permissionMode: "",
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      this.runningTaskId = undefined;
      this.lastResult = result;
      this.emit({
        type: "turn_end",
        taskId,
        ok: result.ok,
        durationMs: result.durationMs,
        // 带正文：haji_send 超时返回 running 时，客户端靠这条事件拿最终答案。
        text:
          result.text.length > MAX_TURN_TEXT
            ? `${result.text.slice(0, MAX_TURN_TEXT)}…`
            : result.text,
        model: result.model,
        toolCalls: result.toolCalls,
        sessionId: result.sessionId,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      return result;
    };
    const promise = this.chain.then(run);
    this.chain = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  get lastTurnResult(): DriverTurnResult | undefined {
    return this.lastResult;
  }

  get pendingCount(): number {
    return this.queuedTasks;
  }

  cancel(): boolean {
    return this.host.cancel();
  }

  // ── 选择请求（授权卡片 / 计划审批） ──────────────────────────────────

  /**
   * 需要用户决策时由 turnDeps.readSelectionSafely 调用。
   * `auto` 策略直接返回默认选项（与无头模式的非交互降级一致）；
   * `ask` 策略发事件并挂起，等 `haji_approve`，超时按默认选项放行。
   */
  async requestSelection(request: DriverSelectionRequest): Promise<DriverSelectionAnswer> {
    const fallback: DriverSelectionAnswer = {
      value: request.selectedValue ?? request.items[0]?.value ?? "",
      ...(request.secondary?.selectedValue !== undefined
        ? { secondaryValue: request.secondary.selectedValue }
        : {}),
    };
    if (this.options.approval === "auto" || request.items.length === 0) return fallback;

    const requestId = `p${++this.selectionSeq}`;
    this.emit({
      type: "selection_request",
      requestId,
      title: request.title,
      items: request.items,
      ...(request.preview ? { preview: request.preview } : {}),
      ...(request.secondary ? { secondary: request.secondary } : {}),
      default: fallback,
    });

    const answer = await new Promise<DriverSelectionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSelections.delete(requestId);
        this.emit({ type: "selection_resolved", requestId, ...fallback, timedOut: true });
        resolve(fallback);
      }, this.selectionTimeoutMs);
      timer.unref?.();
      this.pendingSelections.set(requestId, {
        fallback,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
    return answer;
  }

  answerSelection(requestId: string, value: string, secondaryValue?: string): boolean {
    const pending = this.pendingSelections.get(requestId);
    if (!pending) return false;
    this.pendingSelections.delete(requestId);
    const answer: DriverSelectionAnswer = {
      value,
      ...(secondaryValue !== undefined ? { secondaryValue } : {}),
    };
    pending.resolve(answer);
    this.emit({ type: "selection_resolved", requestId, value, secondaryValue });
    return true;
  }

  /** 当前挂起的选择请求（便于状态查询与排障）。 */
  pendingSelectionIds(): string[] {
    return [...this.pendingSelections.keys()];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pendingSelections) {
      pending.resolve(pending.fallback);
      this.pendingSelections.delete(requestId);
    }
    this.flushText();
    await this.host.close();
  }
}
