export type ModelProviderName = 'deepseek' | 'volcengine';

export interface ModelDescriptor {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly provider: ModelProviderName;
  readonly contextWindowTokens: number;
}

/** Provider-owned model metadata consumed by the CLI and context policy. */
export const MODEL_REGISTRY = [
  {
    value: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: '快速 · 高性价比',
    provider: 'deepseek',
    contextWindowTokens: 1_000_000
  },
  {
    value: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: '更强 · 复杂任务',
    provider: 'deepseek',
    contextWindowTokens: 1_000_000
  },
  {
    value: 'glm-5.2',
    label: 'GLM 5.2',
    description: '火山方舟 · 强力通用/代码模型',
    provider: 'volcengine',
    contextWindowTokens: 1_000_000
  },
  {
    value: 'doubao-pro-32k',
    label: 'Doubao Pro 32k',
    description: '火山方舟 · 豆包大模型',
    provider: 'volcengine',
    contextWindowTokens: 32_768
  },
  {
    value: 'doubao-lite-32k',
    label: 'Doubao Lite 32k',
    description: '火山方舟 · 豆包轻量大模型',
    provider: 'volcengine',
    contextWindowTokens: 32_768
  }
] as const satisfies readonly ModelDescriptor[];

export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(MODEL_REGISTRY.map(model => [model.value, model.contextWindowTokens]))
);

export function getModelMetadata(modelValue: string): ModelDescriptor | undefined {
  return MODEL_REGISTRY.find(model => model.value === modelValue);
}
