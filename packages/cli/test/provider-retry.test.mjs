import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateBackoffDelay,
  isRetryableError,
  ProviderError,
  withExponentialBackoff,
} from "@hajicli/core";

/** 构造与 provider 包装超时错误时形状一致的 ProviderError（本地化消息、无 status）。 */
function timeoutLikeProviderError(retryable) {
  return new ProviderError(
    "网络请求超时（300s），DeepSeek API 未在规定时间内响应。",
    "deepseek",
    undefined,
    retryable,
  );
}

test("isRetryableError 优先采用显式 retryable 标志", () => {
  // 修复前：本地化超时消息不含英文关键词，永远判定为不可重试。
  assert.equal(isRetryableError(timeoutLikeProviderError(true)), true);
  // 标志优先于 status：即使带 5xx status，retryable: false 也不重试。
  assert.equal(isRetryableError(new ProviderError("msg", "p", 500, false)), false);
  assert.equal(isRetryableError(new ProviderError("msg", "p", 429, false)), false);
});

test("isRetryableError 无标志时保持 status 与关键词判定", () => {
  assert.equal(isRetryableError(new ProviderError("msg", "p", 429)), true);
  assert.equal(isRetryableError(new ProviderError("msg", "p", 503)), true);
  assert.equal(isRetryableError(new ProviderError("msg", "p", 404)), false);
  assert.equal(isRetryableError(new ProviderError("msg", "p", 401)), false);
  assert.equal(isRetryableError(new Error("fetch failed")), true);
  assert.equal(isRetryableError(timeoutLikeProviderError(undefined)), false);
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  assert.equal(isRetryableError(abortError), false);
});

test("withExponentialBackoff 对显式可重试的本地化超时错误自动重试并成功", async () => {
  let calls = 0;
  const result = await withExponentialBackoff(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw timeoutLikeProviderError(true);
      }
      return "ok";
    },
    { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 2 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withExponentialBackoff 最多重试 maxRetries 次后抛出最后一个错误", async () => {
  let calls = 0;
  await assert.rejects(
    withExponentialBackoff(
      async () => {
        calls += 1;
        throw timeoutLikeProviderError(true);
      },
      { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 2 },
    ),
    /网络请求超时/,
  );
  // 首次请求 + 5 次重试 = 6 次。
  assert.equal(calls, 6);
});

test("withExponentialBackoff 对不可重试错误立即抛出且只调用一次", async () => {
  let calls = 0;
  await assert.rejects(
    withExponentialBackoff(
      async () => {
        calls += 1;
        throw new ProviderError("Insufficient Balance", "p", 402);
      },
      { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 2 },
    ),
    /Insufficient Balance/,
  );
  assert.equal(calls, 1);
});

test("withExponentialBackoff 不重试用户中断（AbortError）", async () => {
  let calls = 0;
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  await assert.rejects(
    withExponentialBackoff(
      async () => {
        calls += 1;
        throw abortError;
      },
      { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 2 },
    ),
  );
  assert.equal(calls, 1);
});

test("withExponentialBackoff 通过 onRetry 回调暴露重试进度", async () => {
  const events = [];
  let calls = 0;
  await withExponentialBackoff(
    async () => {
      calls += 1;
      if (calls < 2) {
        throw new ProviderError("msg", "p", 500);
      }
      return "ok";
    },
    {
      maxRetries: 5,
      initialDelayMs: 1,
      maxDelayMs: 4,
      onRetry: (attempt, delay, error) => events.push({ attempt, delay, error }),
    },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].attempt, 1);
  assert.ok(events[0].delay >= 0 && events[0].delay <= 4);
  assert.ok(events[0].error instanceof Error);
});

test("calculateBackoffDelay 带抖动且不超过 maxDelayMs 上限", () => {
  for (let i = 0; i < 200; i += 1) {
    const delay = calculateBackoffDelay(i % 10, 1000, 10000);
    assert.ok(delay >= 0 && delay < 10000, `delay ${delay} 超出 [0, 10000) 范围`);
  }
});
