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
export const REPEATED_FAILURE_NOTICE_AT = 2;
/** 同一失败原因在一个回合内出现到该次数时，直接结束本轮自动循环。 */
export const REPEATED_FAILURE_STOP_AT = 3;

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
 * 统计一个回合内"连续"失败中，相同工具、相同目标（命令/路径）、相同原因（归一化后的输出首行）的次数。
 * 不比较其余参数：模型换一份内容重写同一个越界路径，仍算同一种失败。
 * 期间任何一次工具调用成功即清零，避免"测试失败→修改→再测"的正常迭代被误判。
 */
export class RepeatedFailureTracker {
  private readonly counts = new Map<string, number>();

  public record(toolName: string, args: Record<string, unknown>, output: string): number {
    const target = typeof args.command === "string" ? args.command : args.path;
    const reason = normalizeFailureReason(output);
    const key = JSON.stringify([toolName, typeof target === "string" ? target : "", reason]);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count;
  }

  public reset(): void {
    this.counts.clear();
  }
}

/** 追加到工具结果末尾、提示模型换方案的系统说明；未达阈值时返回空串。 */
export function buildRepeatedFailureNotice(count: number): string {
  if (count < REPEATED_FAILURE_NOTICE_AT) return "";
  return `\n\n[系统提示] 该工具已在本轮以相同原因失败 ${count} 次，重试不会改变结果。不要再发起同样的调用：换用其他方案，或停止调用工具，向用户说明失败原因与可选做法。`;
}
