import { MODEL_CONTEXT_WINDOWS, MODEL_MAX_OUTPUT_TOKENS } from '@hajicli/plugins';

/**
 * 返回当前模型的上下文窗口。
 * HAJI_CONTEXT_WINDOW_TOKENS 用于自定义端点覆盖内置值；无效覆盖会安全回退到模型配置或 128k。
 */
export function getModelContextWindowTokens(
  modelValue: string,
  environment: NodeJS.ProcessEnv = process.env
): number {
  const configured = Number(environment.HAJI_CONTEXT_WINDOW_TOKENS);
  if (Number.isFinite(configured) && configured >= 1_000) return Math.round(configured);
  return MODEL_CONTEXT_WINDOWS[modelValue] ?? 128_000;
}

/**
 * 返回当前模型的单次输出 token 上限。
 * HAJI_MAX_TOKENS 可覆盖任意模型；无效覆盖安全回退到模型配置或 8192。
 * 该值会作为请求体 max_tokens 发给 Provider，避免走服务端默认（常远小于上下文窗口）。
 */
export function getModelMaxOutputTokens(
  modelValue: string,
  environment: NodeJS.ProcessEnv = process.env
): number {
  const configured = Number(environment.HAJI_MAX_TOKENS);
  if (Number.isFinite(configured) && configured >= 1) return Math.round(configured);
  return MODEL_MAX_OUTPUT_TOKENS[modelValue] ?? 8_192;
}
