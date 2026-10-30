/**
 * 中继唤醒源：出站订阅 SSE，不需要本地开端口，也不需要公网地址。
 *
 * 为什么不直接开 HTTP 端口收 webhook：本地进程没有公网地址，开端口也得靠隧道兜底；
 * 而「中继 + 出站订阅」让「能不能被叫醒」不依赖网络拓扑。
 *
 * smee.io 官方定位是开发/测试用；要长期跑就换成自建 Worker（保持同样的 SSE 契约即可，
 * 只替换本文件，`PatrolWakeSource` 不变）。
 */
import { type PatrolWakeEvent, type PatrolWakeSource, parseWakePayload } from "@hajicli/core";

export interface SmeeWakeSourceOptions {
  /** 测试注入点：默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  logger?: (line: string) => void;
  /** 首次重连间隔，默认 1s，逐次翻倍。 */
  reconnectMs?: number;
  /** 重连间隔上限，默认 30s。 */
  maxReconnectMs?: number;
  /** 已处理投递 ID 的保留上限，默认 512（只用于去重）。 */
  seenLimit?: number;
}

export function createSmeeWakeSource(
  url: string,
  options: SmeeWakeSourceOptions = {},
): PatrolWakeSource {
  return new SmeeWakeSource(url, options);
}

class SmeeWakeSource implements PatrolWakeSource {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: (line: string) => void;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly seenLimit: number;
  private readonly controller = new AbortController();
  private readonly queue: PatrolWakeEvent[] = [];
  /** 已处理的投递 ID：中继重投时 delivery 不变，用它去重。 */
  private readonly seen = new Set<string>();
  /** 当前 `wait()` 的唤醒回调；`wait` 是串行调用的，只需一个。 */
  private waiter?: () => void;
  private pump?: Promise<void>;
  private closed = false;

  constructor(url: string, options: SmeeWakeSourceOptions) {
    this.url = url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.reconnectMs = options.reconnectMs ?? 1_000;
    this.maxReconnectMs = options.maxReconnectMs ?? 30_000;
    this.seenLimit = options.seenLimit ?? 512;
  }

  /**
   * 等下一条相关事件。
   * 队列里已有事件时立即返回；否则在「事件到达 / 超时 / 中止」三者中最先发生的一个上返回。
   */
  wait(signal: AbortSignal, timeoutMs: number): Promise<PatrolWakeEvent | null> {
    const ready = this.take();
    if (ready) return Promise.resolve(ready);
    if (this.closed || signal.aborted) return Promise.resolve(null);
    this.ensurePump();
    return new Promise<PatrolWakeEvent | null>((resolve) => {
      let settled = false;
      const finish = (value: PatrolWakeEvent | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.waiter === onEvent) this.waiter = undefined;
        resolve(value);
      };
      const onEvent = (): void => finish(this.take() ?? null);
      const onAbort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
      // 只用于等待，不该阻止进程退出。
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiter = onEvent;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.controller.abort();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
    this.pump = undefined;
  }

  private take(): PatrolWakeEvent | undefined {
    return this.queue.shift();
  }

  private ensurePump(): void {
    if (this.pump) return;
    this.pump = this.run().catch((error) => {
      // run() 自己吞掉断线错误；这里只兜住意料之外的异常，避免 unhandled rejection。
      if (!this.closed) this.logger?.(`唤醒通道异常：${(error as Error).message}`);
    });
  }

  /** 连接 → 消费 → 断开重连，直到 `close()`。 */
  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      try {
        const response = await this.fetchImpl(this.url, {
          headers: { accept: "text/event-stream", "cache-control": "no-cache" },
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        attempt = 0;
        await this.consume(response.body);
      } catch (error) {
        if (this.closed) return;
        const wait = Math.min(this.reconnectMs * 2 ** attempt, this.maxReconnectMs);
        attempt += 1;
        this.logger?.(
          `唤醒通道断开（${(error as Error).message}），${Math.round(wait / 1000)}s 后重连；巡检仍在轮询。`,
        );
        await sleep(wait);
      }
    }
  }

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          this.dispatch(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // 连接已被对端关闭：忽略。
      }
    }
  }

  /** 一帧 SSE：只关心 `data:` 行，`event: ready` / `: keepalive` 都跳过。 */
  private dispatch(frame: string): void {
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) return;
    const event = parseWakePayload(data.join("\n"));
    if (!event) return;
    if (event.deliveryId) {
      if (this.seen.has(event.deliveryId)) return;
      this.seen.add(event.deliveryId);
      if (this.seen.size > this.seenLimit) {
        // 只保留最近的一半，避免无界增长。
        const keep = [...this.seen].slice(-Math.floor(this.seenLimit / 2));
        this.seen.clear();
        for (const id of keep) this.seen.add(id);
      }
    }
    this.queue.push(event);
    this.waiter?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
