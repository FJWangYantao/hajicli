/**
 * provider / 模型选择的纯逻辑集合。
 *
 * 这里只放无副作用的判定函数与常量：模型归属哪个 provider、显示名、
 * 初始模型与 provider 的解析顺序。交互流程（/provider 命令族）在
 * provider-commands.ts，实例构建在 index.ts 的 buildProvider。
 */
import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "@hajicli/core";
import { getModelPricing, MODEL_REGISTRY } from "@hajicli/plugins";
import {
  isBuiltinProvider,
  type ProviderConfig,
  resolveProviderSetting,
} from "./provider-config.js";
import { loadUserModels } from "./user-models.js";

export const DEEPSEEK_MODELS = MODEL_REGISTRY.filter((model) => model.provider === "deepseek");
export const VOLCENGINE_MODELS = MODEL_REGISTRY.filter((model) => model.provider === "volcengine");

export const EFFORT_OPTIONS = REASONING_EFFORTS.map((value) => ({
  value,
  label: value,
  description: (
    {
      low: "快速",
      medium: "均衡",
      high: "深入",
      xhigh: "严谨",
      max: "极致",
    } as const
  )[value],
}));

/**
 * 判断给定 model value 属于哪个 provider：
 * 先查内置模型注册表，再查自定义 provider 声明的模型列表，最后回退 deepseek。
 */
export function detectProviderForModel(
  modelValue: string,
  config?: ProviderConfig,
  preferProvider?: string,
): string {
  return findProviderForModel(modelValue, config, preferProvider) ?? "deepseek";
}

/** 只返回有登记依据的归属；检索定价等场景不能把路由默认值当成真实厂商。 */
export function findProviderForModel(
  modelValue: string,
  config?: ProviderConfig,
  preferProvider?: string,
): string | undefined {
  // 同名模型可能同时被内置与自定义 provider 声明（例如 opencode 也提供 deepseek-v4-flash）。
  // 此时若已知用户当前/上次使用的 provider，应优先尊重它，避免静默回退到内置 provider，
  // 导致请求发往官方端点而扣费。
  if (preferProvider) {
    const declaredByPrefer = isBuiltinProvider(preferProvider)
      ? (preferProvider === "deepseek" ? DEEPSEEK_MODELS : VOLCENGINE_MODELS).some(
          (m) => m.value === modelValue,
        )
      : Boolean(config?.providers[preferProvider]?.models?.includes(modelValue));
    if (declaredByPrefer) return preferProvider;
  }
  if (DEEPSEEK_MODELS.some((m) => m.value === modelValue)) return "deepseek";
  if (VOLCENGINE_MODELS.some((m) => m.value === modelValue)) return "volcengine";
  if (config) {
    for (const [name, entry] of Object.entries(config.providers)) {
      if (entry?.models?.includes(modelValue)) return name;
    }
  }
  // 用户模型表（~/.haji/models.json）：内置 provider 的新模型无需发版即可正确路由。
  const userModel = loadUserModels().find((entry) => entry.model === modelValue);
  return userModel?.provider;
}

/** 提供商显示名：内置带图标，自定义显示名称。 */
export function providerLabel(name: string): string {
  if (name === "deepseek") return "🔵 DeepSeek";
  if (name === "volcengine") return "🌋 火山引擎";
  return `⚙️ ${name}`;
}

/** 状态栏用的提供商名称：不带图标，避免与启动信息重复且节省宽度。 */
export function providerPlainLabel(name: string): string {
  if (name === "deepseek") return "DeepSeek";
  if (name === "volcengine") return "火山引擎";
  return name;
}

/** 将已配置的模型窗口格式化为展示文本；未配置时返回“未设置”。 */
export function formatModelContextWindows(windows?: Record<string, number>): string {
  const entries = Object.entries(windows || {});
  if (entries.length === 0) return "未设置";
  return entries.map(([model, tokens]) => `${model}=${tokens}`).join("、");
}

/** 判断某个 provider 当前是否有可用 API Key（内置看解析结果，自定义看配置条目）。 */
export function providerHasApiKey(
  name: string,
  config: ProviderConfig,
  deepseekApiKey: string | undefined,
  volcApiKey: string | undefined,
): boolean {
  return name === "deepseek"
    ? Boolean(deepseekApiKey)
    : name === "volcengine"
      ? Boolean(volcApiKey)
      : Boolean(config.providers[name]?.apiKey);
}

export interface InitialSelectionParams {
  providerConfig: ProviderConfig;
  env: Record<string, string | undefined>;
  deepseekApiKey: string | undefined;
  volcApiKey: string | undefined;
  savedModel: string | undefined;
  savedProvider: string | undefined;
  availableModels: Array<{ value: string }>;
}

export interface InitialSelection {
  model: string;
  providerName: string;
}

/**
 * 启动时确定初始模型与 provider（纯函数，便于测试）。
 *
 * 模型优先顺序 = 环境变量（DEEPSEEK_MODEL / VOLC_MODEL / ARK_MODEL）> 上次保存偏好 > 第一个可用模型。
 * provider 优先沿用上次保存值（Key 可用且与模型归属不矛盾时），否则按模型反推——
 * 这样自定义 provider 重启后也能被正确记住，而不是静默回退到 deepseek。
 */
export function resolveInitialSelection(params: InitialSelectionParams): InitialSelection {
  const { providerConfig, env, deepseekApiKey, volcApiKey, savedModel, savedProvider } = params;
  const availableModels = params.availableModels;
  const envModel = (
    deepseekApiKey
      ? resolveProviderSetting("deepseek", "model", env.DEEPSEEK_MODEL, undefined, providerConfig)
      : resolveProviderSetting(
          "volcengine",
          "model",
          env.VOLC_MODEL || env.ARK_MODEL,
          undefined,
          providerConfig,
        )
  )
    ?.trim()
    .toLowerCase();
  const model: string =
    envModel ||
    (savedModel && availableModels.some((m) => m.value === savedModel)
      ? savedModel
      : availableModels[0]?.value || "deepseek-v4-flash");
  const detectedProviderName = detectProviderForModel(model, providerConfig);
  const modelInBuiltinRegistry =
    DEEPSEEK_MODELS.some((m) => m.value === model) ||
    VOLCENGINE_MODELS.some((m) => m.value === model);
  // 同名模型可能同时被自定义 provider 声明（例如 opencode 也提供 deepseek-v4-flash），
  // 此时不能认为模型“明确属于”内置 provider，应尊重用户上次保存的 provider。
  const modelDeclaredByCustomProvider = Object.entries(providerConfig.providers).some(
    ([name, entry]) => !isBuiltinProvider(name) && entry?.models?.includes(model),
  );
  const modelOwnedByBuiltinOnly = modelInBuiltinRegistry && !modelDeclaredByCustomProvider;
  const providerName =
    savedProvider &&
    providerHasApiKey(savedProvider, providerConfig, deepseekApiKey, volcApiKey) &&
    !(modelOwnedByBuiltinOnly && detectedProviderName !== savedProvider)
      ? savedProvider
      : detectedProviderName;
  return { model, providerName };
}

/** 思考强度字符串的归一化校验（供偏好解析与 /effort 命令共用）。 */
export function normalizeReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  return isReasoningEffort(normalized) ? normalized : undefined;
}

export interface UtilityModelCandidate {
  value: string;
}

/**
 * 解析杂活模型（压缩摘要 / 会话标题 / 经验提炼）：偏好显式指定时优先
 * （不可用则回退主模型，绝不静默换选）；否则在可用模型里按注册表单价
 * 挑最便宜的，无单价信息时按 flash/lite/mini 命名惯例兜底。
 * 返回 undefined 表示没有合适的杂活模型，调用方直接用主模型。
 */
export function resolveUtilityModel(
  preference: string | undefined,
  availableModels: readonly UtilityModelCandidate[],
): string | undefined {
  if (preference) {
    return availableModels.some((model) => model.value === preference) ? preference : undefined;
  }
  type PricedCandidate = {
    value: string;
    pricing: NonNullable<ReturnType<typeof getModelPricing>>;
  };
  const priced = availableModels
    .map((model): PricedCandidate | { value: string; pricing: undefined } => ({
      value: model.value,
      pricing: getModelPricing(model.value),
    }))
    .filter((entry): entry is PricedCandidate => entry.pricing !== undefined);
  if (priced.length > 0) {
    const total = (pricing: PricedCandidate["pricing"]): number =>
      pricing.inputPerMTokens + pricing.outputPerMTokens;
    return priced.reduce((cheapest, entry) =>
      total(entry.pricing) < total(cheapest.pricing) ? entry : cheapest,
    ).value;
  }
  const heuristic = availableModels.find((model) =>
    /flash|lite|mini|small|haiku/i.test(model.value),
  );
  return heuristic?.value;
}
