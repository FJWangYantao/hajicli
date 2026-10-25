import { getModelPricing, isWithinOffPeak, type ModelPricing } from "@hajicli/plugins";

export interface CostUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** 命中缓存的输入 token 数；缺省表示 provider 没上报（按全价计）。 */
  prompt_cache_hit_tokens?: number;
}

export interface CostRecord {
  model: string;
  purpose: string;
  /** 调用发生时刻（ms）：峰谷价按它判定，事后补单价也能算对。 */
  at: number;
  promptTokens: number;
  /** 其中命中缓存的输入 token（≤ promptTokens）。 */
  cachedPromptTokens: number;
  completionTokens: number;
}

export interface ModelCostSummary {
  model: string;
  requests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  /** 落在谷时窗口内的请求次数（0 表示该模型没有峰谷价或都在峰时）。 */
  offPeakRequests: number;
  /** 无单价信息的模型为 null（自定义 provider 模型常见）。 */
  costCny: number | null;
}

export interface CostSummary {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** 已定价请求的合计（元）；只要有未定价请求就同时置 hasUnpriced。 */
  totalCostCny: number;
  hasUnpriced: boolean;
  /** 命中缓存的输入 token 合计（用于说明费用为何比全价估算低）。 */
  cachedPromptTokens: number;
  /** 按谷时价计费的请求数。 */
  offPeakRequests: number;
  /** 未定价的模型名（去重）；用于提示用户补单价。 */
  unpricedModels: string[];
  byModel: ModelCostSummary[];
}

/** 定价解析器：内置注册表 + 本地覆盖表（由 CLI 注入，便于测试与热更新）。 */
export type PricingResolver = (model: string) => ModelPricing | undefined;

/** 金额展示：小数额保留 4 位小数，避免四舍五入成 0.0000。 */
export function formatCostCny(value: number): string {
  return `¥${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** 实际生效的单价档位：调用落在谷时窗口内就用谷时价，否则用峰时价。 */
export function effectiveModelPricing(
  pricing: ModelPricing,
  atMs: number = Date.now(),
): {
  inputPerMTokens: number;
  outputPerMTokens: number;
  cachedInputPerMTokens?: number;
  offPeak: boolean;
} {
  const offPeak = pricing.offPeak;
  if (offPeak && isWithinOffPeak(atMs, offPeak.window)) {
    return {
      inputPerMTokens: offPeak.inputPerMTokens,
      outputPerMTokens: offPeak.outputPerMTokens,
      ...(offPeak.cachedInputPerMTokens !== undefined
        ? { cachedInputPerMTokens: offPeak.cachedInputPerMTokens }
        : pricing.cachedInputPerMTokens !== undefined
          ? { cachedInputPerMTokens: pricing.cachedInputPerMTokens }
          : {}),
      offPeak: true,
    };
  }
  return {
    inputPerMTokens: pricing.inputPerMTokens,
    outputPerMTokens: pricing.outputPerMTokens,
    ...(pricing.cachedInputPerMTokens !== undefined
      ? { cachedInputPerMTokens: pricing.cachedInputPerMTokens }
      : {}),
    offPeak: false,
  };
}

/**
 * 按单价估算一次调用的费用（元）；无单价返回 null。
 *
 * 三件事都会影响结果：调用时刻（峰/谷价）、缓存命中数（缓存价），以及模型是否上报。
 * 时间戳必须在记账时就存下来——事后补单价时无法还原「当时是不是谷时」。
 */
export function estimateRequestCostCny(
  model: string,
  usage: CostUsage,
  resolvePricing: PricingResolver = getModelPricing,
  atMs: number = Date.now(),
): number | null {
  const pricing = resolvePricing(model);
  if (!pricing) return null;
  const tier = effectiveModelPricing(pricing, atMs);
  const promptTokens = Math.max(0, usage.prompt_tokens);
  const cachedTokens = Math.min(promptTokens, Math.max(0, usage.prompt_cache_hit_tokens ?? 0));
  const cachedPrice = tier.cachedInputPerMTokens ?? tier.inputPerMTokens;
  return (
    ((promptTokens - cachedTokens) / 1_000_000) * tier.inputPerMTokens +
    (cachedTokens / 1_000_000) * cachedPrice +
    (usage.completion_tokens / 1_000_000) * tier.outputPerMTokens
  );
}

/**
 * 会话级费用记账：只累计 onUsage 上报的真实 token 消耗，
 * 按注册表单价估算金额（估算值，不含缓存命中折扣等细节）。
 */
export class CostTracker {
  private readonly records: CostRecord[] = [];

  /**
   * 金额按调用时刻的单价解析结果即时计算（不落盘），
   * 所以用户补上单价后，本会话已经发生的调用也会立刻被算出来。
   */
  constructor(private readonly resolvePricing: PricingResolver = getModelPricing) {}

  record(model: string, usage: CostUsage, purpose = "主线回合", at: number = Date.now()): void {
    if (!Number.isFinite(usage.total_tokens) || usage.total_tokens <= 0) return;
    const promptTokens = Math.max(0, usage.prompt_tokens);
    this.records.push({
      model,
      purpose,
      at: Number.isFinite(at) ? at : Date.now(),
      promptTokens,
      // provider 上报的命中数可能大于 prompt_tokens（先减后加口径不同），夹逼一次。
      cachedPromptTokens: Math.min(promptTokens, Math.max(0, usage.prompt_cache_hit_tokens ?? 0)),
      completionTokens: Math.max(0, usage.completion_tokens),
    });
  }

  /** 记账明细快照：用于写进会话文件（/resume 后能还原本会话的费用）。 */
  getRecords(): CostRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /**
   * 用历史会话的记账替换当前记录（/resume 切会话、/clear 清空）。
   * 传 undefined 等价于清空：费用区回到「本会话暂无已计费调用」。
   */
  loadRecords(records: readonly CostRecord[] | undefined): void {
    this.records.length = 0;
    for (const record of records ?? []) {
      if (!record || typeof record.model !== "string" || record.model.length === 0) continue;
      const promptTokens = Math.max(0, Math.round(Number(record.promptTokens) || 0));
      this.records.push({
        model: record.model,
        purpose: typeof record.purpose === "string" ? record.purpose : "主线回合",
        at: Number.isFinite(record.at) ? record.at : Date.now(),
        promptTokens,
        cachedPromptTokens: Math.min(
          promptTokens,
          Math.max(0, Math.round(Number(record.cachedPromptTokens) || 0)),
        ),
        completionTokens: Math.max(0, Math.round(Number(record.completionTokens) || 0)),
      });
    }
  }

  getSummary(): CostSummary {
    const byModelMap = new Map<string, ModelCostSummary>();
    let promptTokens = 0;
    let cachedPromptTokens = 0;
    let completionTokens = 0;
    let offPeakRequests = 0;
    let totalCostCny = 0;
    let hasUnpriced = false;
    const unpricedModels: string[] = [];
    for (const recordItem of this.records) {
      promptTokens += recordItem.promptTokens;
      cachedPromptTokens += recordItem.cachedPromptTokens;
      completionTokens += recordItem.completionTokens;
      const current = byModelMap.get(recordItem.model) ?? {
        model: recordItem.model,
        requests: 0,
        promptTokens: 0,
        cachedPromptTokens: 0,
        completionTokens: 0,
        offPeakRequests: 0,
        costCny: null,
      };
      current.requests += 1;
      current.promptTokens += recordItem.promptTokens;
      current.cachedPromptTokens += recordItem.cachedPromptTokens;
      current.completionTokens += recordItem.completionTokens;
      const pricing = this.resolvePricing(recordItem.model);
      if (pricing?.offPeak && isWithinOffPeak(recordItem.at, pricing.offPeak.window)) {
        current.offPeakRequests += 1;
        offPeakRequests += 1;
      }
      const cost = estimateRequestCostCny(
        recordItem.model,
        {
          prompt_tokens: recordItem.promptTokens,
          completion_tokens: recordItem.completionTokens,
          total_tokens: recordItem.promptTokens + recordItem.completionTokens,
          prompt_cache_hit_tokens: recordItem.cachedPromptTokens,
        },
        this.resolvePricing,
        recordItem.at,
      );
      if (cost !== null) {
        current.costCny = (current.costCny ?? 0) + cost;
        totalCostCny += cost;
      } else {
        hasUnpriced = true;
        if (!unpricedModels.includes(recordItem.model)) unpricedModels.push(recordItem.model);
      }
      byModelMap.set(recordItem.model, current);
    }
    return {
      requests: this.records.length,
      promptTokens,
      completionTokens,
      totalCostCny,
      hasUnpriced,
      cachedPromptTokens,
      offPeakRequests,
      unpricedModels,
      byModel: [...byModelMap.values()].sort((left, right) => right.requests - left.requests),
    };
  }

  /** /cost 展示行（中文，无 ANSI——着色由调用方决定）。 */
  formatCostReport(): string[] {
    const summary = this.getSummary();
    if (summary.requests === 0) {
      return ["本会话暂无已计费的模型调用。"];
    }
    const lines = [
      `本会话费用估算：${formatCostCny(summary.totalCostCny)} · ${summary.requests} 次请求 · 输入 ${summary.promptTokens.toLocaleString("en-US")} / 输出 ${summary.completionTokens.toLocaleString("en-US")} tokens`,
    ];
    for (const model of summary.byModel) {
      const cost = model.costCny === null ? "未定价" : formatCostCny(model.costCny);
      const cacheNote =
        model.cachedPromptTokens > 0
          ? ` · 缓存命中 ${model.cachedPromptTokens.toLocaleString("en-US")}`
          : "";
      const offPeakNote = model.offPeakRequests > 0 ? ` · 谷时 ${model.offPeakRequests} 次` : "";
      lines.push(
        `  ${model.model}  ${model.requests} 次 · ${cost} · 输入 ${model.promptTokens.toLocaleString("en-US")} / 输出 ${model.completionTokens.toLocaleString("en-US")}${cacheNote}${offPeakNote}`,
      );
    }
    if (summary.hasUnpriced) {
      lines.push(`  注：未定价模型 ${summary.unpricedModels.join("、")} 没有单价，仅统计 tokens。`);
      lines.push("  补单价：点击侧栏「费用」，或 /cost config（手动输入 / 后台 agent 查询）。");
    }
    lines.push(
      "  金额按单价估算（缓存命中按缓存价、谷时按谷时价计；provider 未上报命中数时按全价），仅供参考。",
    );
    return lines;
  }
}
