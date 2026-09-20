import { MODEL_CONTEXT_WINDOWS } from "@hajicli/plugins";

/**
 * 将窗口值归一化为合法 tokens 数：接受有限数字（字符串按数字解析），
 * 小于 1000 或无法解析时返回 undefined。
 */
export function normalizeContextWindowTokens(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (Number.isFinite(num) && num >= 1_000) return Math.round(num);
  return undefined;
}

/**
 * 返回当前模型的上下文窗口。
 * HAJI_CONTEXT_WINDOW_TOKENS 用于自定义端点覆盖内置值；无效覆盖会安全回退到模型配置或 128k。
 * providerModelContextWindow 为 provider 配置声明的模型窗口：优先于内置注册表，低于环境变量。
 */
export function getModelContextWindowTokens(
  modelValue: string,
  environment: NodeJS.ProcessEnv = process.env,
  providerModelContextWindow?: unknown,
): number {
  const configured = normalizeContextWindowTokens(environment.HAJI_CONTEXT_WINDOW_TOKENS);
  if (configured !== undefined) return configured;
  const fromProvider = normalizeContextWindowTokens(providerModelContextWindow);
  if (fromProvider !== undefined) return fromProvider;
  return MODEL_CONTEXT_WINDOWS[modelValue] ?? 128_000;
}
