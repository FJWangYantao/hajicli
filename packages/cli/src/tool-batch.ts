import { performance } from 'node:perf_hooks';
import { performanceMonitor } from '@hajicli/core';

export const PARALLEL_READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'global',
  'projectinfo',
  'websearch',
  'webfetch',
  'listskillresources',
  'readskillresource'
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
  maxParallel = MAX_PARALLEL_READ_ONLY_TOOLS
): ToolCallBatch<T>[] {
  const concurrency = Math.max(1, Math.trunc(maxParallel));
  const batches: ToolCallBatch<T>[] = [];
  let pending: T[] = [];
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
  execute: (call: T, index: number) => Promise<R>
): Promise<ToolBatchRunResult<R>> {
  const startedAt = performance.now();
  const results = batch.parallel
    ? await Promise.all(batch.calls.map((call, index) => execute(call, index)))
    : [await execute(batch.calls[0], 0)];
  const wallTimeMs = performance.now() - startedAt;
  const serialEstimateMs = results.reduce((total, result) => total + Math.max(0, result.duration), 0);
  const savedTimeMs = Math.max(0, serialEstimateMs - wallTimeMs);
  if (batch.parallel) {
    performanceMonitor.record('tool.batch.wall_time', wallTimeMs);
    performanceMonitor.record('tool.batch.serial_estimate', serialEstimateMs);
    performanceMonitor.record('tool.batch.saved_time', savedTimeMs);
  }
  return {
    results,
    wallTimeMs,
    serialEstimateMs,
    savedTimeMs
  };
}
