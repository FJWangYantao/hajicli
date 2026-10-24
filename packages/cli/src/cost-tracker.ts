import { getModelPricing } from "@hajicli/plugins";

export interface CostUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CostRecord {
  model: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
}

export interface ModelCostSummary {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
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
  byModel: ModelCostSummary[];
}

/** 金额展示：小数额保留 4 位小数，避免四舍五入成 0.0000。 */
export function formatCostCny(value: number): string {
  return `¥${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** 按注册表单价估算一次调用的费用（元）；无单价返回 null。 */
export function estimateRequestCostCny(model: string, usage: CostUsage): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;
  return (
    (usage.prompt_tokens / 1_000_000) * pricing.inputPerMTokens +
    (usage.completion_tokens / 1_000_000) * pricing.outputPerMTokens
  );
}

/**
 * 会话级费用记账：只累计 onUsage 上报的真实 token 消耗，
 * 按注册表单价估算金额（估算值，不含缓存命中折扣等细节）。
 */
export class CostTracker {
  private readonly records: CostRecord[] = [];

  record(model: string, usage: CostUsage, purpose = "主线回合"): void {
    if (!Number.isFinite(usage.total_tokens) || usage.total_tokens <= 0) return;
    this.records.push({
      model,
      purpose,
      promptTokens: Math.max(0, usage.prompt_tokens),
      completionTokens: Math.max(0, usage.completion_tokens),
    });
  }

  getSummary(): CostSummary {
    const byModelMap = new Map<string, ModelCostSummary>();
    let promptTokens = 0;
    let completionTokens = 0;
    let totalCostCny = 0;
    let hasUnpriced = false;
    for (const recordItem of this.records) {
      promptTokens += recordItem.promptTokens;
      completionTokens += recordItem.completionTokens;
      const current = byModelMap.get(recordItem.model) ?? {
        model: recordItem.model,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        costCny: null,
      };
      current.requests += 1;
      current.promptTokens += recordItem.promptTokens;
      current.completionTokens += recordItem.completionTokens;
      const cost = estimateRequestCostCny(recordItem.model, {
        prompt_tokens: recordItem.promptTokens,
        completion_tokens: recordItem.completionTokens,
        total_tokens: recordItem.promptTokens + recordItem.completionTokens,
      });
      if (cost !== null) {
        current.costCny = (current.costCny ?? 0) + cost;
        totalCostCny += cost;
      } else {
        hasUnpriced = true;
      }
      byModelMap.set(recordItem.model, current);
    }
    return {
      requests: this.records.length,
      promptTokens,
      completionTokens,
      totalCostCny,
      hasUnpriced,
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
      lines.push(
        `  ${model.model}  ${model.requests} 次 · ${cost} · 输入 ${model.promptTokens.toLocaleString("en-US")} / 输出 ${model.completionTokens.toLocaleString("en-US")}`,
      );
    }
    if (summary.hasUnpriced) {
      lines.push("  注：自定义 provider 的模型没有内置单价，仅统计 tokens。");
    }
    lines.push("  金额按注册表单价估算，未含缓存命中折扣，仅供参考。");
    return lines;
  }
}
