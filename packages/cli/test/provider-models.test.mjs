import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectProviderForModel,
  formatModelContextWindows,
  normalizeReasoningEffort,
  providerHasApiKey,
  providerLabel,
  providerPlainLabel,
  resolveInitialSelection,
} from "../dist/provider-models.js";

const EMPTY_CONFIG = { providers: {} };

function configWith(providers) {
  return { providers };
}

test("detectProviderForModel resolves builtin and custom models", () => {
  assert.equal(detectProviderForModel("deepseek-v4-flash"), "deepseek");
  assert.equal(detectProviderForModel("glm-5.2"), "volcengine");
  // 自定义 provider 声明的模型归属该 provider
  const config = configWith({ openai: { apiKey: "k", models: ["gpt-x"] } });
  assert.equal(detectProviderForModel("gpt-x", config), "openai");
  // 未注册的模型回退 deepseek
  assert.equal(detectProviderForModel("totally-unknown", config), "deepseek");
});

test("detectProviderForModel honors preferProvider for ambiguous models", () => {
  // 同名模型同时被内置与自定义 provider 声明时，优先尊重用户当前 provider
  const config = configWith({ openai: { apiKey: "k", models: ["deepseek-v4-flash"] } });
  assert.equal(detectProviderForModel("deepseek-v4-flash", config, "openai"), "openai");
  assert.equal(detectProviderForModel("deepseek-v4-flash", config, "deepseek"), "deepseek");
  // preferProvider 未声明该模型时忽略
  assert.equal(detectProviderForModel("glm-5.2", config, "openai"), "volcengine");
});

test("providerHasApiKey checks builtin keys and custom entries", () => {
  const config = configWith({ openai: { apiKey: "k" }, empty: {} });
  assert.equal(providerHasApiKey("deepseek", config, "sk-1", undefined), true);
  assert.equal(providerHasApiKey("deepseek", config, undefined, "sk-2"), false);
  assert.equal(providerHasApiKey("volcengine", config, undefined, "sk-2"), true);
  assert.equal(providerHasApiKey("openai", config, undefined, undefined), true);
  assert.equal(providerHasApiKey("empty", config, undefined, undefined), false);
});

test("resolveInitialSelection prefers env model then saved preference then first available", () => {
  const base = {
    providerConfig: EMPTY_CONFIG,
    deepseekApiKey: "k",
    volcApiKey: undefined,
    availableModels: [{ value: "deepseek-v4-flash" }, { value: "deepseek-v4-pro" }],
  };
  // 无偏好 → 第一个可用模型
  assert.deepEqual(resolveInitialSelection({ ...base, env: {}, savedModel: undefined }), {
    model: "deepseek-v4-flash",
    providerName: "deepseek",
  });
  // 保存的偏好模型可用 → 沿用
  assert.equal(
    resolveInitialSelection({ ...base, env: {}, savedModel: "deepseek-v4-pro" }).model,
    "deepseek-v4-pro",
  );
  // 环境变量优先于偏好
  assert.equal(
    resolveInitialSelection({
      ...base,
      env: { DEEPSEEK_MODEL: "deepseek-v4-pro" },
      savedModel: "deepseek-v4-flash",
    }).model,
    "deepseek-v4-pro",
  );
  // 保存的模型不在可用列表 → 回退第一个可用
  assert.equal(
    resolveInitialSelection({ ...base, env: {}, savedModel: "gone-model" }).model,
    "deepseek-v4-flash",
  );
});

test("resolveInitialSelection keeps saved provider only when its key exists", () => {
  const config = configWith({ openai: { apiKey: "k", models: ["gpt-x"] } });
  const models = [{ value: "deepseek-v4-flash" }, { value: "gpt-x" }];
  // 自定义 provider 有 key 且未与内置归属冲突 → 沿用
  assert.equal(
    resolveInitialSelection({
      providerConfig: config,
      env: {},
      deepseekApiKey: "k",
      volcApiKey: undefined,
      savedModel: "gpt-x",
      savedProvider: "openai",
      availableModels: models,
    }).providerName,
    "openai",
  );
  // 保存的 provider 没有 key → 回退按模型反推
  assert.equal(
    resolveInitialSelection({
      providerConfig: config,
      env: {},
      deepseekApiKey: "k",
      volcApiKey: undefined,
      savedModel: "deepseek-v4-flash",
      savedProvider: "openai",
      availableModels: models,
    }).providerName,
    "deepseek",
  );
});

test("normalizeReasoningEffort accepts known efforts and rejects others", () => {
  assert.equal(normalizeReasoningEffort("LOW"), "low");
  assert.equal(normalizeReasoningEffort(" max "), "max");
  assert.equal(normalizeReasoningEffort("bogus"), undefined);
  assert.equal(normalizeReasoningEffort(undefined), undefined);
});

test("provider labels and context window formatting", () => {
  assert.equal(providerLabel("deepseek"), "🔵 DeepSeek");
  assert.equal(providerLabel("volcengine"), "🌋 火山引擎");
  assert.equal(providerLabel("custom"), "⚙️ custom");
  assert.equal(providerPlainLabel("deepseek"), "DeepSeek");
  assert.equal(providerPlainLabel("volcengine"), "火山引擎");
  assert.equal(formatModelContextWindows(undefined), "未设置");
  assert.equal(formatModelContextWindows({ "glm-5.2": 131072 }), "glm-5.2=131072");
});
