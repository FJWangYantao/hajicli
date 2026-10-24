/**
 * 首次启动配置向导：没有任何可用 API Key 时引导用户完成第一份 provider 配置。
 *
 * 在 TUI 启动之前运行，因此直接使用 readline/promises 问答（不依赖 TerminalUI）；
 * 交互模式下随后 console.clear() 会清掉含 Key 回显的屏幕。
 * 无头模式不进入向导（调用方保持原退出码 1 行为）。
 */
import readlinePromises from "node:readline/promises";
import {
  normalizeBaseUrl,
  parseModelList,
  saveProviderConfig,
  testProviderConnection,
  validateProviderName,
} from "./provider-config.js";
import { DEEPSEEK_MODELS, providerLabel, VOLCENGINE_MODELS } from "./provider-models.js";

interface OnboardingOutcome {
  /** 是否完成配置（至少一个 provider 已写盘）。 */
  configured: boolean;
  /** 本次配置的 provider 名称；未完成时为 undefined。 */
  providerName?: string;
}

const BUILTIN_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/coding/v3",
};

function builtinDefaultModel(provider: string): string {
  if (provider === "deepseek") return DEEPSEEK_MODELS[0]?.value || "deepseek-chat";
  if (provider === "volcengine") return VOLCENGINE_MODELS[0]?.value || "glm-5.2";
  return "";
}

/**
 * 运行首次配置向导。输出默认写 stdout、输入读 stdin（均可注入以便测试）；
 * 任何一步留空或 Ctrl+C 都视为放弃（configured: false），由调用方决定后续。
 */
export async function runProviderOnboarding(
  stdin: NodeJS.ReadableStream,
  output: NodeJS.WritableStream = process.stdout,
): Promise<OnboardingOutcome> {
  const rl = readlinePromises.createInterface({ input: stdin, output });
  try {
    output.write("欢迎使用 haji。还没有可用的模型提供商，先完成一次基础配置（约 1 分钟）：\n");
    const choice = (
      await rl.question(
        "  1) DeepSeek（需要 DEEPSEEK_API_KEY）\n  2) 火山方舟（需要 VOLC_API_KEY / ARK_API_KEY）\n  3) 自定义 OpenAI 兼容端点\n选择 1/2/3（回车默认 1，留空跳过向导）：",
      )
    ).trim();
    if (choice === "" || choice.toLowerCase() === "q") {
      return { configured: false };
    }
    if (choice !== "1" && choice !== "2" && choice !== "3") {
      output.write("无效选择，已退出向导。可稍后运行 haji 再试，或用 /provider add 配置。\n");
      return { configured: false };
    }

    if (choice === "1" || choice === "2") {
      const providerName = choice === "1" ? "deepseek" : "volcengine";
      const apiKey = (
        await rl.question(`粘贴 ${providerLabel(providerName)} API Key（留空取消）：`)
      ).trim();
      if (!apiKey) return { configured: false };
      const baseUrl = BUILTIN_BASE_URLS[providerName];
      const model = builtinDefaultModel(providerName);
      output.write(`正在测试连通性（${baseUrl} · ${model}）…\n`);
      const result = await testProviderConnection(baseUrl, apiKey, model);
      if (!result.ok) {
        output.write(
          `连通性测试失败：${result.error ?? "未知错误"}。配置未写入，可重启 haji 重试或用 /provider set 检查。\n`,
        );
        return { configured: false };
      }
      const ok = saveProviderConfig(providerName, { apiKey, baseUrl, model });
      if (!ok) {
        output.write("配置写入失败（磁盘权限？），请检查 ~/.haji/ 目录。\n");
        return { configured: false };
      }
      output.write(
        `✓ 连通测试通过（${result.ms}ms）· 已写入 ~/.haji/config.json · 默认模型 ${model}\n` +
          "注意：API Key 以明文存储于本地 .haji/config.json（已被 git 忽略），请勿共享该文件。\n",
      );
      return { configured: true, providerName };
    }

    // 自定义 OpenAI 兼容端点
    const nameInput = (
      await rl.question("Provider 名称（如 openai、moonshot；留空取消）：")
    ).trim();
    if (!nameInput) return { configured: false };
    const nameError = validateProviderName(nameInput);
    if (nameError) {
      output.write(`${nameError}，已退出向导。\n`);
      return { configured: false };
    }
    const providerName = nameInput.toLowerCase();
    const baseUrlInput = (
      await rl.question("Base URL（OpenAI 兼容端点，如 https://api.openai.com/v1；留空取消）：")
    ).trim();
    if (!baseUrlInput) return { configured: false };
    const normalized = normalizeBaseUrl(baseUrlInput);
    if (!/^https?:\/\//i.test(normalized.url)) {
      output.write(`Base URL 无效（${baseUrlInput}），已退出向导。\n`);
      return { configured: false };
    }
    const apiKey = (await rl.question("API Key（留空取消）：")).trim();
    if (!apiKey) return { configured: false };
    const modelListInput = (
      await rl.question("模型名称（多个用分号分隔，如 gpt-4o;gpt-4o-mini；留空取消）：")
    ).trim();
    const models = parseModelList(modelListInput);
    if (models.length === 0) {
      output.write("至少需要输入一个模型名称，已退出向导。\n");
      return { configured: false };
    }
    output.write(`正在测试连通性（${normalized.url} · ${models[0]}）…\n`);
    const result = await testProviderConnection(normalized.url, apiKey, models[0]);
    if (!result.ok) {
      output.write(
        `连通性测试失败：${result.error ?? "未知错误"}。配置未写入，可重启 haji 重试。\n`,
      );
      return { configured: false };
    }
    const ok = saveProviderConfig(providerName, {
      apiKey,
      baseUrl: normalized.url,
      model: models[0],
      models,
    });
    if (!ok) {
      output.write("配置写入失败（磁盘权限？），请检查 ~/.haji/ 目录。\n");
      return { configured: false };
    }
    output.write(
      `✓ 连通测试通过（${result.ms}ms）· 已写入 ~/.haji/config.json · 模型 ${models.join("、")}\n` +
        "注意：API Key 以明文存储于本地 .haji/config.json（已被 git 忽略），请勿共享该文件。\n",
    );
    return { configured: true, providerName };
  } finally {
    rl.close();
  }
}
