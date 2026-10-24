export type ModelProviderName = "deepseek" | "volcengine";

/** 模型定位：utility 档用于压缩/摘要/标题等杂活路由，成本优先。 */
export type ModelTier = "flagship" | "balanced" | "utility";

/** 单价（每百万 token）。用于 /cost 估算与 utility 模型路由排序，均为估算值。 */
export interface ModelPricing {
  readonly inputPerMTokens: number;
  readonly outputPerMTokens: number;
  readonly currency: "CNY" | "USD";
}

export interface ModelDescriptor {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly provider: ModelProviderName;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly tier?: ModelTier;
  readonly pricing?: ModelPricing;
}

/** Provider-owned model metadata consumed by the CLI and context policy. */
export const MODEL_REGISTRY = [
  {
    value: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "快速 · 高性价比",
    provider: "deepseek",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    tier: "utility",
    pricing: { inputPerMTokens: 0.5, outputPerMTokens: 2, currency: "CNY" },
  },
  {
    value: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "更强 · 复杂任务",
    provider: "deepseek",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    tier: "flagship",
    pricing: { inputPerMTokens: 2, outputPerMTokens: 8, currency: "CNY" },
  },
  {
    value: "glm-5.2",
    label: "GLM 5.2",
    description: "火山方舟 · 强力通用/代码模型",
    provider: "volcengine",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 16_384,
    tier: "flagship",
    pricing: { inputPerMTokens: 2, outputPerMTokens: 8, currency: "CNY" },
  },
  {
    value: "doubao-pro-32k",
    label: "Doubao Pro 32k",
    description: "火山方舟 · 豆包大模型",
    provider: "volcengine",
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    tier: "balanced",
    pricing: { inputPerMTokens: 0.8, outputPerMTokens: 2, currency: "CNY" },
  },
  {
    value: "doubao-lite-32k",
    label: "Doubao Lite 32k",
    description: "火山方舟 · 豆包轻量大模型",
    provider: "volcengine",
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    tier: "utility",
    pricing: { inputPerMTokens: 0.3, outputPerMTokens: 0.6, currency: "CNY" },
  },
] as const satisfies readonly ModelDescriptor[];

export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(MODEL_REGISTRY.map((model) => [model.value, model.contextWindowTokens])),
);

export function getModelMetadata(modelValue: string): ModelDescriptor | undefined {
  return MODEL_REGISTRY.find((model) => model.value === modelValue);
}

export function getModelPricing(modelValue: string): ModelPricing | undefined {
  return getModelMetadata(modelValue)?.pricing;
}
