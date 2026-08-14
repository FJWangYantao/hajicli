import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface PerformanceMetricSnapshot {
  count: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface PerformanceSnapshot {
  eventLoop: {
    meanMs: number;
    p95Ms: number;
    maxMs: number;
  };
  metrics: Record<string, PerformanceMetricSnapshot>;
}

const MAX_SAMPLES_PER_METRIC = 256;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export class PerformanceMonitor {
  private readonly samples = new Map<string, number[]>();
  private eventLoopHistogram?: ReturnType<typeof monitorEventLoopDelay>;

  start(): void {
    if (this.eventLoopHistogram) return;
    this.eventLoopHistogram = monitorEventLoopDelay({ resolution: 10 });
    this.eventLoopHistogram.enable();
  }

  stop(): void {
    this.eventLoopHistogram?.disable();
    this.eventLoopHistogram = undefined;
  }

  record(name: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const values = this.samples.get(name) || [];
    values.push(durationMs);
    if (values.length > MAX_SAMPLES_PER_METRIC) {
      values.splice(0, values.length - MAX_SAMPLES_PER_METRIC);
    }
    this.samples.set(name, values);
  }

  measureSync<T>(name: string, operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.record(name, performance.now() - startedAt);
    }
  }

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.record(name, performance.now() - startedAt);
    }
  }

  snapshot(reset = false): PerformanceSnapshot {
    const metrics: Record<string, PerformanceMetricSnapshot> = {};
    for (const [name, values] of this.samples) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((left, right) => left - right);
      const sum = values.reduce((total, value) => total + value, 0);
      metrics[name] = {
        count: values.length,
        averageMs: round(sum / values.length),
        p95Ms: round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))]),
        maxMs: round(sorted[sorted.length - 1])
      };
    }

    const histogram = this.eventLoopHistogram;
    const nanosecondsToMilliseconds = (value: number): number => Number.isFinite(value) ? round(value / 1_000_000) : 0;
    const snapshot: PerformanceSnapshot = {
      eventLoop: {
        meanMs: histogram ? nanosecondsToMilliseconds(histogram.mean) : 0,
        p95Ms: histogram ? nanosecondsToMilliseconds(histogram.percentile(95)) : 0,
        maxMs: histogram ? nanosecondsToMilliseconds(histogram.max) : 0
      },
      metrics
    };

    if (reset) {
      this.samples.clear();
      histogram?.reset();
    }
    return snapshot;
  }
}

export const performanceMonitor = new PerformanceMonitor();
