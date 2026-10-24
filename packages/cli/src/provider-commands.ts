/**
 * /provider 命令族：快速切换、引导添加、set/unset 配置与状态查看。
 *
 * 从 index.ts 的主循环分发中抽出；所有可变会话状态（当前模型 / provider /
 * API Key / 可用模型列表）经 ProviderCommandContext 的访问器读写，
 * 保证与主循环共享同一份 let 绑定。
 */
import type { ObservableModelProvider, ReasoningEffort } from "@hajicli/core";
import { savePreference } from "./cli-runtime.js";
import {
  isBuiltinProvider,
  listVisibleProviderNames,
  loadProviderConfig,
  loadProviderConfigScope,
  normalizeBaseUrl,
  PROVIDER_NAMES,
  type ProviderConfig,
  type ProviderConfigScope,
  parseModelContextWindows,
  parseModelList,
  providerConfigPath,
  saveProviderConfig,
  testProviderConnection,
  unsetProviderConfig,
  validateProviderName,
} from "./provider-config.js";
import {
  DEEPSEEK_MODELS,
  formatModelContextWindows,
  providerLabel,
  VOLCENGINE_MODELS,
} from "./provider-models.js";
import { TerminalInputCancelledError, type TerminalUI } from "./terminal-input.js";
import { colors } from "./theme.js";

/** 可选模型条目（内置注册表与自定义 provider 声明共用的最小结构）。 */
export interface ProviderModelOption {
  value: string;
  label: string;
  description?: string;
  provider: string;
}

/**
 * main() 注入的会话状态与回调。访问器而不是裸引用，因为对应的
 * let 绑定（selectedModel 等）会在命令执行中被重新赋值。
 */
export interface ProviderCommandContext {
  ui: TerminalUI;
  providerConfig: ProviderConfig;
  getDeepseekApiKey(): string | undefined;
  setDeepseekApiKey(key: string | undefined): void;
  getVolcApiKey(): string | undefined;
  setVolcApiKey(key: string | undefined): void;
  getAvailableModels(): ProviderModelOption[];
  rebuildAvailableModels(): void;
  getSelectedModel(): string;
  setSelectedModel(model: string): void;
  getCurrentProviderName(): string;
  setCurrentProviderName(name: string): void;
  getReasoningEffort(): ReasoningEffort;
  buildProvider(
    modelValue: string,
    providerOverride?: string,
    preferProvider?: string,
  ): ObservableModelProvider;
  setProvider(provider: ObservableModelProvider): void;
  refreshSystemPrompt(): Promise<void>;
  updateStatusUI(): void;
  getSelectedContextWindowTokens(): number;
  onPreferenceWarning(message: string): void;
}

/** 分发 /provider 与 /providers 指令；调用方负责其后的主循环 continue。 */
export async function handleProviderCommand(
  ctx: ProviderCommandContext,
  input: { parts: string[] },
): Promise<void> {
  const { ui, providerConfig } = ctx;
  const parts = input.parts;
  const action = parts[1]?.toLowerCase();
  const target = parts[2]?.toLowerCase();
  const hasProjectScope = parts.some((part) => part.toLowerCase() === "--project");
  const hasUserScope = parts.some(
    (part) => part.toLowerCase() === "--global" || part.toLowerCase() === "--user",
  );
  if (hasProjectScope && hasUserScope) {
    ui.writeLine(colors.red("不能同时指定 --project 与 --global。"));
    return;
  }
  const configScope: ProviderConfigScope = hasProjectScope ? "project" : "user";
  const configScopeLabel = configScope === "project" ? "项目级" : "用户全局";

  // 快速切换：/provider <name>（内置或自定义）
  if (action && action !== "add" && action !== "set" && action !== "unset") {
    const targetName = action;
    const targetKey = isBuiltinProvider(targetName)
      ? targetName === "deepseek"
        ? ctx.getDeepseekApiKey()
        : ctx.getVolcApiKey()
      : providerConfig.providers[targetName]?.apiKey;
    if (!targetKey) {
      ui.writeLine(
        colors.red(`未配置 ${providerLabel(targetName)} API Key。使用 /provider add 引导配置。`),
      );
      return;
    }
    const targetModel =
      ctx
        .getAvailableModels()
        .find((m) => m.value === ctx.getSelectedModel() && m.provider === targetName)?.value ||
      (targetName === "deepseek"
        ? DEEPSEEK_MODELS[0].value
        : targetName === "volcengine"
          ? VOLCENGINE_MODELS[0].value
          : providerConfig.providers[targetName]?.model ||
            providerConfig.providers[targetName]?.models?.[0] ||
            "");
    if (!targetModel) {
      ui.writeLine(
        colors.red(
          `${providerLabel(targetName)} 未配置任何模型。使用 /provider add 补充模型列表。`,
        ),
      );
      return;
    }
    ctx.setProvider(ctx.buildProvider(targetModel, targetName));
    ctx.setCurrentProviderName(targetName);
    ctx.setSelectedModel(targetModel);
    await ctx.refreshSystemPrompt();
    savePreference(
      {
        model: ctx.getSelectedModel(),
        reasoningEffort: ctx.getReasoningEffort(),
        provider: ctx.getCurrentProviderName(),
      },
      ctx.onPreferenceWarning,
    );
    ctx.updateStatusUI();
    ui.writeLine(
      colors.green(`已切换到 ${providerLabel(targetName)}，模型：${ctx.getSelectedModel()}。`),
    );
    return;
  }

  // 引导添加：/provider add [--project]（名称 → URL → Key → 模型列表 → 连通性测试）
  if (action === "add") {
    try {
      while (true) {
        const nameInput = (
          await ui.readInput({ prompt: "Provider 名称（如 openai、moonshot；留空取消）" })
        ).trim();
        if (!nameInput) {
          ui.writeLine(colors.gray("已取消添加 provider。"));
          break;
        }
        const nameError = validateProviderName(nameInput);
        if (nameError) {
          ui.writeLine(colors.red(`✗ ${nameError}，请重新输入。`));
          continue;
        }
        const lowerName = nameInput.toLowerCase();
        if (providerConfig.providers[lowerName]?.apiKey) {
          ui.writeLine(
            colors.yellow(`已存在 ${providerLabel(lowerName)} 的配置，继续输入将覆盖。`),
          );
        }
        const baseUrl = (
          await ui.readInput({
            prompt: "Base URL（OpenAI 兼容端点，如 https://api.openai.com/v1；留空取消）",
          })
        ).trim();
        if (!baseUrl) {
          ui.writeLine(colors.gray("已取消添加 provider。"));
          break;
        }
        const normalizedUrl = normalizeBaseUrl(baseUrl);
        if (normalizedUrl.note) {
          ui.writeLine(
            colors.yellow(`提示：${normalizedUrl.note}，已自动修正为 ${normalizedUrl.url}`),
          );
        }
        if (!/^https?:\/\//i.test(normalizedUrl.url)) {
          ui.writeLine(colors.red(`✗ Base URL 无效（${baseUrl}），请重新输入。`));
          continue;
        }
        const apiKey = (
          await ui.readInput({
            prompt: "API Key（留空取消）",
            sensitive: true,
          })
        ).trim();
        if (!apiKey) {
          ui.writeLine(colors.gray("已取消添加 provider。"));
          break;
        }
        const modelListInput = (
          await ui.readInput({
            prompt: "模型名称（多个用分号分隔，如 gpt-4o;gpt-4o-mini；留空取消）",
          })
        ).trim();
        const models = parseModelList(modelListInput);
        if (models.length === 0) {
          ui.writeLine(colors.red("✗ 至少需要输入一个模型名称，请重新输入。"));
          continue;
        }
        // 连通性测试：用第一个模型发最小请求
        ui.writeLine(colors.cyan(`正在测试连通性（${normalizedUrl.url} · ${models[0]}）…`));
        const result = await testProviderConnection(normalizedUrl.url, apiKey, models[0]);
        if (!result.ok) {
          ui.writeLine(
            colors.red(
              `✗ 连通性测试失败：${result.error}${result.ms !== undefined ? `（${result.ms}ms）` : ""}`,
            ),
          );
          if (result.normalizedNote) {
            ui.writeLine(
              colors.yellow(`提示：${result.normalizedNote}（实际请求 ${result.usedUrl}）`),
            );
          }
          const retry = (await ui.readInput({ prompt: "输入 r 重新配置，输入 c 取消" }))
            .trim()
            .toLowerCase();
          if (retry === "c" || retry === "") {
            ui.writeLine(colors.gray("已取消添加 provider。"));
            break;
          }
          continue; // 重新进入引导流程
        }
        const ok = saveProviderConfig(
          lowerName,
          {
            apiKey,
            baseUrl: normalizedUrl.url,
            model: models[0],
            models,
          },
          configScope,
        );
        if (!ok) {
          ui.writeLine(colors.red("保存配置失败，请检查磁盘权限。"));
          break;
        }
        // 同步内存状态，使配置立即生效
        const refreshed = loadProviderConfig();
        providerConfig.providers[lowerName] = refreshed.providers[lowerName];
        ctx.rebuildAvailableModels();
        ctx.updateStatusUI();
        ui.writeLine(
          colors.green(
            `✓ 已添加 ${providerLabel(lowerName)}（${configScopeLabel}，连通性测试通过，${result.ms}ms）。`,
          ),
        );
        ui.writeLine(colors.gray(`配置文件：${providerConfigPath(configScope)}`));
        ui.writeLine(
          colors.gray(`模型：${models.join("、")}。输入 /provider ${lowerName} 切换到该提供商。`),
        );
        ui.writeLine(
          colors.gray(
            "注意：API Key 以明文存储于本地 .haji/config.json（已被 git 忽略），请勿共享该文件。",
          ),
        );
        break;
      }
    } catch (error) {
      if (error instanceof TerminalInputCancelledError) {
        ui.writeLine(colors.gray("已取消添加 provider。"));
        return;
      }
      throw error;
    }
    return;
  }

  // 配置：/provider set <name> [--project]（API Key 通过安全输入框录入）
  if (action === "set") {
    if (!target || validateProviderName(target)) {
      ui.writeLine(colors.red("用法: /provider set <name> [--project]"));
      return;
    }
    const name = target.toLowerCase();
    const label = providerLabel(name);
    try {
      const inlineArguments = parts
        .slice(3)
        .filter((part) => !["--project", "--global", "--user"].includes(part.toLowerCase()));
      if (inlineArguments.length > 0) {
        ui.writeLine(colors.red("API Key 不再支持内联传入；请使用掩码输入框。"));
        return;
      }
      const apiKey = (
        await ui.readInput({
          prompt: `输入 ${label} API Key（留空保留现有配置）`,
          sensitive: true,
        })
      ).trim();
      const current = providerConfig.providers[name] || {};
      const baseUrlInput = (
        await ui.readInput({
          prompt: `Base URL（当前: ${current.baseUrl || "未设置"}，留空保留）`,
        })
      ).trim();
      let baseUrlToSave = baseUrlInput || undefined;
      if (baseUrlToSave) {
        const normalizedUrl = normalizeBaseUrl(baseUrlToSave);
        if (normalizedUrl.note) {
          ui.writeLine(
            colors.yellow(`提示：${normalizedUrl.note}，已自动修正为 ${normalizedUrl.url}`),
          );
        }
        if (!/^https?:\/\//i.test(normalizedUrl.url)) {
          ui.writeLine(colors.red(`✗ Base URL 无效（${baseUrlToSave}），已跳过保存。`));
          baseUrlToSave = undefined;
        } else {
          baseUrlToSave = normalizedUrl.url;
        }
      }
      const modelInput = (
        await ui.readInput({
          prompt: `默认模型（当前: ${current.model || "未设置"}，留空保留）`,
        })
      ).trim();
      const modelsInput = (
        await ui.readInput({
          prompt: `模型列表（当前: ${current.models?.join("、") || "未设置"}，多个用分号分隔，留空保留）`,
        })
      ).trim();
      const models = modelsInput ? parseModelList(modelsInput) : undefined;
      const windowsInput = (
        await ui.readInput({
          prompt: `模型上下文窗口（当前: ${formatModelContextWindows(current.modelContextWindows)}，格式 模型=tokens 多个用分号分隔，留空保留）`,
        })
      ).trim();
      let modelContextWindows: Record<string, number> | undefined;
      if (windowsInput) {
        const parsedWindows = parseModelContextWindows(windowsInput);
        if (parsedWindows.invalid.length > 0) {
          ui.writeLine(
            colors.yellow(
              `! 已忽略无法解析的窗口项：${parsedWindows.invalid.join("；")}（格式应为 模型=tokens 且 tokens ≥ 1000）`,
            ),
          );
        }
        if (Object.keys(parsedWindows.windows).length > 0) {
          modelContextWindows = parsedWindows.windows;
        } else {
          ui.writeLine(colors.red("✗ 未解析出有效窗口，保持原有窗口配置不变。"));
        }
      }
      const ok = saveProviderConfig(
        name,
        {
          apiKey: apiKey || undefined,
          baseUrl: baseUrlToSave,
          model: modelInput || undefined,
          modelContextWindows,
          models,
        },
        configScope,
      );
      if (!ok) {
        ui.writeLine(colors.red(`保存 ${label} 配置失败，请检查磁盘权限。`));
        return;
      }
      // 同步内存状态，使配置立即生效
      const refreshed = loadProviderConfig();
      providerConfig.providers[name] = refreshed.providers[name];
      if (name === "deepseek") {
        ctx.setDeepseekApiKey(apiKey || ctx.getDeepseekApiKey());
      } else if (name === "volcengine") {
        ctx.setVolcApiKey(apiKey || ctx.getVolcApiKey());
      }
      ctx.rebuildAvailableModels();
      // 若当前正使用该 provider，则重建实例并同步模型
      if (ctx.getCurrentProviderName() === name) {
        const newModel = modelInput || ctx.getSelectedModel();
        ctx.setProvider(ctx.buildProvider(newModel, name));
        ctx.setCurrentProviderName(name);
        if (modelInput) {
          ctx.setSelectedModel(modelInput);
          await ctx.refreshSystemPrompt();
          savePreference(
            {
              model: ctx.getSelectedModel(),
              reasoningEffort: ctx.getReasoningEffort(),
              provider: ctx.getCurrentProviderName(),
            },
            ctx.onPreferenceWarning,
          );
        }
        ctx.updateStatusUI();
      }
      ui.writeLine(
        colors.green(
          `✓ 已保存 ${label} 的${configScopeLabel}配置（${providerConfigPath(configScope)}）。`,
        ),
      );
      if (
        configScope === "user" &&
        Object.keys(loadProviderConfigScope("project").providers[name] || {}).length > 0
      ) {
        ui.writeLine(colors.yellow("当前项目仍有同名项目级配置，会继续覆盖对应的全局字段。"));
      }
      ui.writeLine(
        colors.gray(
          "注意：API Key 以明文存储于本地 .haji/config.json（已被 git 忽略），请勿共享该文件。",
        ),
      );
    } catch (error) {
      if (error instanceof TerminalInputCancelledError) {
        ui.writeLine(colors.gray("已取消配置。"));
        return;
      }
      throw error;
    }
    return;
  }

  // 清除：/provider unset <name> [--project]
  if (action === "unset") {
    if (!target) {
      ui.writeLine(colors.red("用法: /provider unset <name> [--project]"));
      return;
    }
    const name = target.toLowerCase();
    const label = providerLabel(name);
    if (!unsetProviderConfig(name, configScope)) {
      ui.writeLine(colors.red(`清除 ${label} 的${configScopeLabel}配置失败。`));
      return;
    }
    const refreshed = loadProviderConfig();
    providerConfig.providers[name] = refreshed.providers[name];
    if (name === "deepseek") {
      ctx.setDeepseekApiKey(
        process.env.DEEPSEEK_API_KEY || providerConfig.providers.deepseek?.apiKey,
      );
    } else if (name === "volcengine") {
      ctx.setVolcApiKey(
        process.env.VOLC_API_KEY ||
          process.env.ARK_API_KEY ||
          providerConfig.providers.volcengine?.apiKey,
      );
    }
    ctx.rebuildAvailableModels();
    ctx.updateStatusUI();
    ui.writeLine(colors.green(`✓ 已清除 ${label} 的${configScopeLabel}配置。`));
    const keyAfter = isBuiltinProvider(name)
      ? name === "deepseek"
        ? ctx.getDeepseekApiKey()
        : ctx.getVolcApiKey()
      : providerConfig.providers[name]?.apiKey;
    if (ctx.getCurrentProviderName() === name && !keyAfter) {
      ui.writeLine(
        colors.yellow(
          `当前正在使用 ${label}，但已无可用 API Key。建议 /provider add 重新配置或切换提供商。`,
        ),
      );
    }
    return;
  }

  // 状态查看：/provider
  const rows = [
    colors.bold("模型提供商状态："),
    colors.gray(`当前窗口：${ctx.getSelectedContextWindowTokens().toLocaleString()} tokens`),
  ];
  const userConfig = loadProviderConfigScope("user");
  const projectConfig = loadProviderConfigScope("project");
  const sourceFor = (
    name: string,
    fields: Array<keyof ProviderConfig["providers"][string]>,
  ): string => {
    if (fields.some((field) => projectConfig.providers[name]?.[field] !== undefined))
      return "项目级";
    if (fields.some((field) => userConfig.providers[name]?.[field] !== undefined)) return "全局";
    return "默认";
  };
  const allNames = listVisibleProviderNames(providerConfig, (name) =>
    name === "deepseek" ? Boolean(ctx.getDeepseekApiKey()) : Boolean(ctx.getVolcApiKey()),
  );
  for (const name of allNames) {
    const label = providerLabel(name);
    const entry = providerConfig.providers[name] || {};
    let key: string | undefined;
    let envKey: string | undefined;
    if (name === "deepseek") {
      key = ctx.getDeepseekApiKey();
      envKey = process.env.DEEPSEEK_API_KEY;
    } else if (name === "volcengine") {
      key = ctx.getVolcApiKey();
      envKey = process.env.VOLC_API_KEY || process.env.ARK_API_KEY;
    } else {
      key = entry.apiKey;
    }
    const masked = key ? `${key.slice(0, 6)}***（共 ${key.length} 位）` : "未配置";
    const source = key && key === envKey ? "环境变量" : sourceFor(name, ["apiKey"]);
    rows.push(`  ${label}${ctx.getCurrentProviderName() === name ? colors.green("（当前）") : ""}`);
    rows.push(
      `    API Key: ${key ? colors.green(masked) + colors.gray(` [${source}]`) : colors.red("未配置")}`,
    );
    rows.push(
      `    Base URL: ${entry.baseUrl || "默认"} ${colors.gray(`[${sourceFor(name, ["baseUrl"])}]`)}`,
    );
    const modelLabel = entry.models?.length ? entry.models.join("、") : entry.model || "默认";
    rows.push(
      `    模型: ${modelLabel} ${colors.gray(`[${sourceFor(name, ["models", "model"])}]`)}`,
    );
  }
  if (allNames.filter((name) => isBuiltinProvider(name)).length < PROVIDER_NAMES.length) {
    rows.push(
      colors.gray(
        "未配置 API Key 的内置 provider 不在此列出；可用 /provider set <名称> 重新配置。",
      ),
    );
  }
  rows.push(
    colors.gray(
      `当前模型：${ctx.getSelectedModel()} · 提供商：${providerLabel(ctx.getCurrentProviderName())}`,
    ),
  );
  rows.push(
    colors.gray(
      "/provider add 引导添加；set/unset 默认全局，附加 --project 操作当前项目；/provider <name> 切换。",
    ),
  );
  ui.writeChat(rows.join("\n"));
}
