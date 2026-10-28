#!/usr/bin/env node
/**
 * A/B 指标公共口径：ab-report 与 ab-extract 共用，避免两边算法漂移。
 *
 * 除了工具调用数，这里还统计**模型请求数**与 token/费用——一次请求可以并行发多个
 * 工具调用，所以「调用数下降」不等于「请求数下降」，成本真正跟的是
 * 请求数 × 每次请求的上下文。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 标题/压缩/distill 这类杂活请求没有 system 消息，据此和主线请求区分开。 */
function isUtilityCall(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return !messages.some((message) => message?.role === "system");
}

/**
 * trace 里缓存命中字段在不同 provider 下叫法不同。
 *
 * `prompt_cache_hit_tokens` 必须排在最前：provider 归一化（openai-stream.ts 的
 * `cachedUsageFields`）只写这个字段，而 `cache_read_input_tokens` / `cached_tokens`
 * 在 trace 里通常**存在但恒为 0**——`??` 不会跳过 0，顺序错了就永远统计不到命中。
 */
function cachedTokens(usage) {
  if (!usage) return 0;
  const value =
    usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0;
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

let pricingCache;
function loadPricing() {
  if (pricingCache) return pricingCache;
  const overrides = new Map();
  const overridePath =
    process.env.HAJI_PRICING_PATH?.trim() || path.join(os.homedir(), ".haji", "pricing.json");
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath, "utf8"));
    for (const [model, entry] of Object.entries(raw?.models ?? {})) {
      if (entry && typeof entry === "object") overrides.set(model, entry);
    }
  } catch {
    // 没有覆盖表就只用内置单价
  }
  pricingCache = { overrides, builtin: undefined };
  return pricingCache;
}

/** 内置注册表按需加载（脚本可能在没有 dist 的环境里跑）。 */
async function builtinPricing() {
  const pricing = loadPricing();
  if (pricing.builtin !== undefined) return pricing.builtin;
  try {
    const module = await import(new URL("../packages/plugins/dist/index.js", import.meta.url));
    pricing.builtin = (model) => module.getModelPricing(model);
  } catch {
    pricing.builtin = () => undefined;
  }
  return pricing.builtin;
}

/** 去掉 `global:` / `cn:` 这类 provider 前缀后再查一次。 */
function stripProviderPrefix(model) {
  const index = model.indexOf(":");
  return index > 0 ? model.slice(index + 1) : undefined;
}

/**
 * 解析单价：内置注册表 > ~/.haji/pricing.json 覆盖表，两处都试「原名」和「去前缀名」。
 * 返回 `{ pricing, assumed }`；`assumed` 表示只按同名前缀的模型推定（例如只有 `cn:` 的
 * 单价、请求却来自 `global:`），报告里要标出来。返回 undefined 表示未定价，不猜。
 */
export async function createPricingResolver() {
  const pricing = loadPricing();
  const builtin = await builtinPricing();
  return (model) => {
    if (!model) return undefined;
    const candidates = [model, stripProviderPrefix(model)].filter(Boolean);
    for (const candidate of candidates) {
      const entry = builtin(candidate);
      if (entry) return { pricing: entry, assumed: false };
    }
    for (const candidate of candidates) {
      const entry = pricing.overrides.get(candidate);
      if (entry) return { pricing: entry, assumed: false };
    }
    // 同名模型换了 provider 前缀（cn: / global:）：借用已知单价，标记为推定。
    const bare = stripProviderPrefix(model) ?? model;
    for (const [key, entry] of pricing.overrides) {
      if (stripProviderPrefix(key) === bare) return { pricing: entry, assumed: true };
    }
    return undefined;
  };
}

/** 单次请求费用（元）。谷时价需要时段判断，这里统一按表内基准价算，报告里注明口径。 */
function requestCost(pricing, usage) {
  if (!pricing) return null;
  const prompt = Math.max(0, Number(usage?.prompt_tokens) || 0);
  const cached = Math.min(prompt, cachedTokens(usage));
  const completion = Math.max(0, Number(usage?.completion_tokens) || 0);
  const cachedPrice = pricing.cachedInputPerMTokens ?? pricing.inputPerMTokens;
  return (
    ((prompt - cached) * pricing.inputPerMTokens +
      cached * cachedPrice +
      completion * pricing.outputPerMTokens) /
    1_000_000
  );
}

/**
 * 单会话指标。
 *
 * - `requests`：模型请求数（含子代理、含杂活），`mainRequests` 只算带 system 的
 * - `truncatedReads`：回执里带 `nextStartLine=` 的 read 次数（翻页的直接证据）
 * - `costCny`：只在全部请求都有单价时给出，否则为 null 并记 `unpricedRequests`
 */
export function sessionMetrics(events, options = {}) {
  const resolvePricing = options.resolvePricing ?? (() => undefined);
  const toolCounts = {};
  const seenReads = new Set();
  let turns = 0;
  let subagents = 0;
  let redundantReads = 0;
  let batchParamCalls = 0;
  let requests = 0;
  let utilityRequests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  let costCny = 0;
  let unpricedRequests = 0;
  let assumedPricingRequests = 0;
  let truncatedReads = 0;
  // read_symbol：按符号读定义的次数，以及 grep 回执里出现「可按符号读」提示的次数。
  let symbolReads = 0;
  let symbolHints = 0;

  for (const event of events) {
    if (event.type === "user_input") {
      turns += 1;
      continue;
    }
    if (event.type === "llm_call") {
      const data = event.data ?? {};
      requests += 1;
      if (isUtilityCall(data)) utilityRequests += 1;
      const usage = data.usage;
      promptTokens += Math.max(0, Number(usage?.prompt_tokens) || 0);
      completionTokens += Math.max(0, Number(usage?.completion_tokens) || 0);
      cachedPromptTokens += cachedTokens(usage);
      const resolved = resolvePricing(data.model);
      const cost = requestCost(resolved?.pricing, usage);
      if (cost === null) unpricedRequests += 1;
      else {
        costCny += cost;
        if (resolved.assumed) assumedPricingRequests += 1;
      }
      continue;
    }
    if (event.type !== "tool_execution") continue;
    const name = String(event.data?.name || "");
    toolCounts[name] = (toolCounts[name] || 0) + 1;
    if (name === "subagent") subagents += 1;
    if (name === "read" && typeof event.data?.output === "string") {
      if (event.data.output.includes("nextStartLine=")) truncatedReads += 1;
    }
    const args = event.data?.arguments;
    if (name === "read" && typeof args?.symbol === "string" && args.symbol.trim()) symbolReads += 1;
    if (
      name === "grep" &&
      typeof event.data?.output === "string" &&
      event.data.output.includes("symbol: ")
    ) {
      symbolHints += 1;
    }
    if (name === "read" && args && typeof args === "object") {
      const batch = Array.isArray(args.paths);
      if (batch) batchParamCalls += 1;
      for (const request of batch ? args.paths : [args]) {
        if (!request) continue;
        const key =
          typeof request === "string"
            ? request
            : [
                request.path ?? "",
                request.startLine ?? "",
                request.endLine ?? "",
                request.limit ?? "",
                request.aroundLine ?? "",
              ].join("|");
        if (seenReads.has(key)) redundantReads += 1;
        else seenReads.add(key);
      }
    } else if (name === "grep" && Array.isArray(args?.queries)) {
      batchParamCalls += 1;
    } else if (name === "global" && Array.isArray(args?.patterns)) {
      batchParamCalls += 1;
    }
  }

  const toolCalls = Object.values(toolCounts).reduce((sum, value) => sum + value, 0);
  return {
    turns,
    requests,
    mainRequests: requests - utilityRequests,
    utilityRequests,
    toolCalls,
    toolCounts,
    requestsPerTool: toolCalls > 0 ? requests / toolCalls : 0,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    costCny: unpricedRequests === 0 ? costCny : null,
    unpricedRequests,
    assumedPricingRequests,
    redundantReads,
    batchParamCalls,
    subagents,
    readCalls: toolCounts.read ?? 0,
    truncatedReads,
    symbolReads,
    symbolHints,
  };
}

/** 把每会话指标累加进 arm 桶。 */
export function emptyTotals() {
  return {
    sessions: 0,
    wallMs: 0,
    turns: 0,
    requests: 0,
    utilityRequests: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    costCny: 0,
    unpricedRequests: 0,
    assumedPricingRequests: 0,
    redundantReads: 0,
    batchParamCalls: 0,
    subagents: 0,
    readCalls: 0,
    truncatedReads: 0,
    symbolReads: 0,
    symbolHints: 0,
  };
}

export function addSession(totals, session) {
  totals.sessions += 1;
  totals.wallMs += session.wallMs ?? 0;
  totals.turns += session.turns;
  totals.requests += session.requests;
  totals.utilityRequests += session.utilityRequests;
  totals.toolCalls += session.toolCalls;
  totals.promptTokens += session.promptTokens;
  totals.completionTokens += session.completionTokens;
  totals.cachedPromptTokens += session.cachedPromptTokens;
  totals.unpricedRequests += session.unpricedRequests;
  totals.assumedPricingRequests += session.assumedPricingRequests;
  if (session.costCny !== null) totals.costCny += session.costCny;
  totals.redundantReads += session.redundantReads;
  totals.batchParamCalls += session.batchParamCalls;
  totals.subagents += session.subagents;
  totals.readCalls += session.readCalls;
  totals.truncatedReads += session.truncatedReads;
  totals.symbolReads += session.symbolReads ?? 0;
  totals.symbolHints += session.symbolHints ?? 0;
}

/** 由累加桶算出每会话均值（报告直接用这些字段）。 */
export function averageTotals(totals) {
  const n = totals.sessions || 1;
  return {
    ...totals,
    costCny: totals.unpricedRequests === 0 ? totals.costCny : null,
    avgWallMs: totals.wallMs / n,
    avgTurns: totals.turns / n,
    avgRequests: totals.requests / n,
    avgToolCalls: totals.toolCalls / n,
    avgRequestsPerTool: totals.toolCalls > 0 ? totals.requests / totals.toolCalls : 0,
    avgPromptTokens: totals.promptTokens / n,
    avgCompletionTokens: totals.completionTokens / n,
    avgCachedPromptTokens: totals.cachedPromptTokens / n,
    avgCostCny: totals.unpricedRequests === 0 ? totals.costCny / n : null,
    avgRedundantReads: totals.redundantReads / n,
    avgBatchParamCalls: totals.batchParamCalls / n,
    avgReadCalls: totals.readCalls / n,
    avgTruncatedReads: totals.truncatedReads / n,
    truncatedRate: totals.readCalls > 0 ? totals.truncatedReads / totals.readCalls : 0,
  };
}
