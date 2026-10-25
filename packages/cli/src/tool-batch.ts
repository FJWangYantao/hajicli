import { performance } from "node:perf_hooks";
import { performanceMonitor } from "@hajicli/core";

export const PARALLEL_READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "global",
  "projectinfo",
  "websearch",
  "webfetch",
  "listskillresources",
  "readskillresource",
]);

export const MAX_PARALLEL_READ_ONLY_TOOLS = 3;

export interface NamedToolCall {
  function: { name: string };
}

export interface ToolCallBatch<T> {
  calls: T[];
  parallel: boolean;
}

export interface TimedToolResult {
  duration: number;
}

export interface ToolBatchRunResult<R> {
  results: R[];
  wallTimeMs: number;
  serialEstimateMs: number;
  savedTimeMs: number;
}

/** Groups only contiguous, explicitly allowlisted read-only calls. Mutation and orchestration calls are barriers. */
export function createToolCallBatches<T extends NamedToolCall>(
  calls: readonly T[],
  maxParallel = MAX_PARALLEL_READ_ONLY_TOOLS,
): ToolCallBatch<T>[] {
  const concurrency = Math.max(1, Math.trunc(maxParallel));
  const batches: ToolCallBatch<T>[] = [];
  const pending: T[] = [];
  const flush = () => {
    while (pending.length > 0) {
      const chunk = pending.splice(0, concurrency);
      batches.push({ calls: chunk, parallel: chunk.length > 1 });
    }
  };

  for (const call of calls) {
    if (PARALLEL_READ_ONLY_TOOLS.has(call.function.name.toLowerCase())) {
      pending.push(call);
      if (pending.length >= concurrency) flush();
      continue;
    }
    flush();
    batches.push({ calls: [call], parallel: false });
  }
  flush();
  return batches;
}

/**
 * 让一次工具执行与中止信号竞速：中止先到就返回 undefined，调用方无需等待
 * 工具自行收尾。原 Promise 仍保留处理器，后台完成或失败都不会变成未处理拒绝。
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.resolve(undefined);
  }
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Executes a prepared batch and returns ordered results plus measured parallel savings. */
export async function runToolCallBatch<T, R extends TimedToolResult>(
  batch: ToolCallBatch<T>,
  execute: (call: T, index: number) => Promise<R>,
): Promise<ToolBatchRunResult<R>> {
  const startedAt = performance.now();
  const results = batch.parallel
    ? await Promise.all(batch.calls.map((call, index) => execute(call, index)))
    : [await execute(batch.calls[0], 0)];
  const wallTimeMs = performance.now() - startedAt;
  const serialEstimateMs = results.reduce(
    (total, result) => total + Math.max(0, result.duration),
    0,
  );
  const savedTimeMs = Math.max(0, serialEstimateMs - wallTimeMs);
  if (batch.parallel) {
    performanceMonitor.record("tool.batch.wall_time", wallTimeMs);
    performanceMonitor.record("tool.batch.serial_estimate", serialEstimateMs);
    performanceMonitor.record("tool.batch.saved_time", savedTimeMs);
  }
  return {
    results,
    wallTimeMs,
    serialEstimateMs,
    savedTimeMs,
  };
}

/** 同一失败原因在一个回合内出现到该次数时，追加提示要求模型停止原样重试。 */
export const REPEATED_FAILURE_NOTICE_AT = 3;
/** 同一失败原因在一个回合内出现到该次数时，直接结束本轮自动循环。 */
export const REPEATED_FAILURE_STOP_AT = 5;

/**
 * edit 检测到「文件在本次编辑前被其他进程/会话改写」时附带的标记。
 * turn-runner 据此立刻结束本回合，避免模型在写者未退出时反复抢写。
 */
export const EDIT_CONCURRENT_MARKER = "[并发写入]";

/**
 * 归并「同一种失败」的判定口径：只取输出首行，并把 16 位 hash 抹成占位符。
 * 否则「文件已被修改，期望 hash=A，当前 hash=B」这类每次 hash 都变的失败
 * 会永远算成不同原因，重复失败保护形同虚设。
 */
export function normalizeFailureReason(output: string): string {
  const firstLine = output.trim().split("\n", 1)[0] ?? "";
  return firstLine.replace(/\b[0-9a-f]{16}\b/gi, "<hash>").trim();
}

/**
 * edit 失败原因的稳定枚举。错误文本里的 hash、行号、最近位置片段每次都不同，
 * 直接按首行比对会让「同一个文件连续改不动」永远停在第一次。
 */
export function classifyEditFailure(output: string): string {
  if (output.includes(EDIT_CONCURRENT_MARKER)) return "hash-conflict-external";
  if (output.includes("[hash冲突]")) {
    return output.includes("最近一次改动是你自己") ? "hash-conflict-own" : "hash-conflict-external";
  }
  if (output.includes("匹配到多处")) return "oldtext-ambiguous";
  if (output.includes("已连续")) return "oldtext-miss-repeat";
  const miss = output.match(/找不到指定的 oldText 原文（([^）]+)）/);
  if (miss) return `oldtext-miss:${miss[1]}`;
  return normalizeFailureReason(output);
}

/** 失败计数键：edit 只按文件计；其他工具沿用「工具 + 目标 + 归一化原因」。 */
export function failureKey(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): string {
  const target = typeof args.command === "string" ? args.command : args.path;
  const targetKey = typeof target === "string" ? target : "";
  if (toolName === "edit") {
    // 原因（hash 冲突 / 未命中类别 / 匹配多处）每次重读都会变，
    // 但「同一个文件连续改不动」才是需要止损的信号。
    return JSON.stringify(["edit", targetKey, "sequence"]);
  }
  return JSON.stringify([toolName, targetKey, normalizeFailureReason(output)]);
}

/**
 * 统计一个回合内失败次数的口径：
 * - edit 按「文件」累计，原因变化不重置（重读后换个写法仍是同一个文件改不动）；
 * - 其他工具仍按「工具 + 目标 + 原因」累计。
 * 成功的清零规则见 noteSuccess：read 不能清 edit 的账。
 */
export class RepeatedFailureTracker {
  private readonly counts = new Map<string, { count: number; reason: string }>();

  public record(toolName: string, args: Record<string, unknown>, output: string): number {
    const key = failureKey(toolName, args, output);
    const reason =
      toolName === "edit" ? classifyEditFailure(output) : normalizeFailureReason(output);
    const count = (this.counts.get(key)?.count ?? 0) + 1;
    this.counts.set(key, { count, reason });
    return count;
  }

  /** 某条失败记录最近一次的原因（用于提示里点名「最近原因」）。 */
  public lastReason(toolName: string, args: Record<string, unknown>): string | undefined {
    const target = typeof args.command === "string" ? args.command : args.path;
    const targetKey = typeof target === "string" ? target : "";
    for (const [key, value] of this.counts) {
      const [tool, keyTarget] = JSON.parse(key) as [string, string];
      if (tool === toolName && keyTarget === targetKey) return value.reason;
    }
    return undefined;
  }

  /**
   * 工具成功后的清零口径：只清「同一工具 + 同一目标」。
   * 其他工具的成功只清非编辑类计数——read 是 edit 失败后的标准恢复动作，
   * 若它也能把 edit 的账清零，熔断器就永远等不到第二次失败。
   */
  public noteSuccess(toolName: string, args: Record<string, unknown>): void {
    const target = typeof args.command === "string" ? args.command : args.path;
    const targetKey = typeof target === "string" ? target : "";
    for (const key of [...this.counts.keys()]) {
      const [tool, keyTarget] = JSON.parse(key) as [string, string];
      if (tool === toolName && keyTarget === targetKey) this.counts.delete(key);
    }
    if (toolName === "edit" || toolName === "write") return;
    for (const key of [...this.counts.keys()]) {
      const [tool] = JSON.parse(key) as [string];
      if (tool !== "edit") this.counts.delete(key);
    }
  }

  public reset(): void {
    this.counts.clear();
  }
}

/** edit 连续失败时点名「哪个文件、最近什么原因」，并要求先诊断再动手。 */
export function buildRepeatedFailureNotice(
  count: number,
  context: { toolName?: string; target?: string; reason?: string } = {},
): string {
  if (count < REPEATED_FAILURE_NOTICE_AT) return "";
  if (context.toolName === "edit") {
    const target = context.target ? `（${context.target}）` : "";
    return `\n\n[系统提示] 同一文件${target}的编辑已连续失败 ${count} 次（最近原因: ${context.reason ?? "未知"}）。继续重试不会改变结果：请先 read 确认当前内容与 hash；若原因含 hash 冲突，说明文件正被其他进程/会话写入，请停止编辑并向用户说明，不要在本回合继续抢写。`;
  }
  return `\n\n[系统提示] 该工具已在本轮以相同原因失败 ${count} 次，重试不会改变结果。不要再发起同样的调用：换用其他方案，或停止调用工具，向用户说明失败原因与可选做法。若失败来自 edit 的 oldText 未命中，请先 read 重新读取目标区域，再用完整整行重试；若失败来自 write/edit 的 hash 冲突（文件已变化），必须先 read 拿到当前内容与新 hash；若 read 确认磁盘内容已经是目标内容则无需再写，不要带着旧 expectedHash 重新生成整份内容。`;
}

/** 达到停止阈值后，同一条消息里剩余的工具调用不再执行，只留一条工具结果维持消息拓扑。 */
export function buildRepeatedFailureSkipMessage(): string {
  return `[工具调用已跳过：同一工具已连续以相同原因失败 ${REPEATED_FAILURE_STOP_AT} 次，本轮自动重试已停止]`;
}

/** 确认是并发写后，本回合不再执行对该文件的编辑。 */
export function isConcurrentWriteFailure(toolName: string, output: string): boolean {
  return toolName === "edit" && output.includes(EDIT_CONCURRENT_MARKER);
}

/** edit 判定「目标内容已存在」的幂等结果：不是失败，但也不应反复重发。 */
export function isNoopEditResult(toolName: string, output: string): boolean {
  return toolName === "edit" && output.startsWith("[文件无需修改]");
}

/** 同一条编辑连续两次返回「无需修改」时，说明目标状态已达成，结束本回合的重复编辑。 */
export function buildNoopEditStopNotice(target: string): string {
  return `\n\n[系统提示] 同一条编辑已连续返回「无需修改」（${target || "目标文件"}），说明文件已经处于目标状态。本回合已停止重复编辑：请直接继续后续步骤或向用户汇报，不要再用不同措辞重发同一处修改。`;
}

/** 因「目标已存在」停止后，剩余调用的占位结果。 */
export function buildNoopEditSkipMessage(): string {
  return "[工具调用已跳过：同一编辑已确认目标内容存在，本回合已停止重复编辑]";
}

/** 并发写停止后，补在失败结果末尾的系统说明。 */
export function buildConcurrentWriteNotice(target: string): string {
  return `\n\n[系统提示] 检测到 ${target || "该文件"} 在本次编辑前被其他进程/会话写入（并发写）。本回合已停止对该文件的自动编辑：请向用户说明，并确认是否还有另一个代理在跑；等写入方退出后重新 read 再改。`;
}

/** 并发写停止后，同一条消息里剩余调用的占位结果。 */
export function buildConcurrentWriteSkipMessage(target: string): string {
  return `[工具调用已跳过：${target || "目标文件"} 正被其他进程/会话写入，本回合已停止自动编辑]`;
}
