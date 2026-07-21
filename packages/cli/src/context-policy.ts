import { MODEL_CONTEXT_WINDOWS } from '@hajicli/plugins';

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
