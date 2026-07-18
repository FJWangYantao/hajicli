import { ProviderError } from './types.js';

/**
 * 指数退避重试配置选项。
 */
export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  providerName?: string;
  onRetry?: (attempt: number, delay: number, error: Error) => void;
}

/**
 * 判断指定错误或 HTTP 响应状态码是否应当触发重试。
 */
export function isRetryableError(error: unknown, status?: number): boolean {
  if (status) {
    // 429 速率限制、500/502/503/504 服务端故障均可重试
    return status === 429 || status >= 500;
  }
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    return (
      name.includes('timeout') ||
      name.includes('abort') ||
      message.includes('fetch failed') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('etimedout')
    );
  }
  return false;
}

/**
 * 计算带抖动（Full Jitter）的指数退避延迟时间。
 */
export function calculateBackoffDelay(attempt: number, initialDelayMs = 1000, maxDelayMs = 10000): number {
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(maxDelayMs, exponentialDelay);
  // Full Jitter 随机抖动避免惊群效应
  return Math.floor(Math.random() * cappedDelay);
}

/**
 * 使用指数退避（Exponential Backoff）算法包装并执行异步任务。
 */
export async function withExponentialBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 1000, maxDelayMs = 10000, onRetry } = options;

  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : undefined;
      const retryable = isRetryableError(error, status);

      if (!retryable || attempt >= maxRetries) {
        throw error;
      }

      const delay = calculateBackoffDelay(attempt, initialDelayMs, maxDelayMs);
      if (onRetry) {
        onRetry(attempt + 1, delay, error instanceof Error ? error : new Error(String(error)));
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}
