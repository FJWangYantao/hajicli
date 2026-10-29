/**
 * 模型单价配置与后台定价 agent：/cost config、/cost price、/cost agent，
 * 以及「出现未定价模型时问一次」。
 *
 * 从 index.ts 的 main() 抽出；会变的会话状态（当前模型 / provider / 权限档…）经
 * PricingCommandContext 的访问器读取，与主循环共享同一份 let 绑定。
 * 模块内部只持有定价自己的状态：是否有查询在跑、最近一次查询过程、已提醒过的模型。
 */
import type {
  BaseTool,
  ObservableModelProvider,
  PermissionMode,
  ReasoningEffort,
  RiskLevel,
  ToolCall,
} from "@hajicli/core";
import { formatOffPeakWindow, type OffPeakPricing, parseOffPeakWindow } from "@hajicli/plugins";
import { loadPreference, saveUserPreference } from "./cli-runtime.js";
import type { CostTracker } from "./cost-tracker.js";
import {
  channelPricingKey,
  describeCurrentTier,
  formatPricingLabel,
  parsePriceInput,
  pricingOrigin,
  recentPricingFailure,
  recordPricingAttempt,
  removePricingOverride,
  resolveModelPricing,
  savePricingOverride,
} from "./model-pricing.js";
import {
  PRICING_AGENT_TOOLS,
  resolveOfficialPricingUrls,
  runPricingAgent,
} from "./pricing-agent.js";
import { isBuiltinProvider, type ProviderConfig } from "./provider-config.js";
import { findProviderForModel } from "./provider-models.js";
import type { TerminalUI } from "./terminal-input.js";
import { colors } from "./theme.js";
import type { SharedToolExecutor } from "./tool-executor.js";

export interface PricingCommandContext {
  ui: TerminalUI;
  costTracker: CostTracker;
  toolsMap: ReadonlyMap<string, BaseTool>;
  toolExecutor: SharedToolExecutor;
  /** 启动时读到的偏好（只用来恢复「已提醒过的模型」）。 */
  savedPreference: { pricingPromptedModels?: unknown } | null | undefined;
  /** 无头模式（-p）不弹任何选择。 */
  headless: boolean;
  getSelectedModel(): string;
  getReasoningEffort(): ReasoningEffort;
  getProvider(): ObservableModelProvider;
  getProviderConfig(): ProviderConfig;
  getCurrentProviderName(): string;
  getPermissionMode(): PermissionMode;
  getRiskThreshold(): RiskLevel;
  getUtilityRuntime(): { provider: ObservableModelProvider; model: string } | undefined;
  /** 费用信息唯一出口：单价变了要刷新侧栏。 */
  publishCostInfo(): void;
  startBackgroundInput(draft?: string): void;
  readSelectionSafely: TerminalUI["readSelection"] extends (options: infer O) => infer R
    ? (options: O, draftHandling?: "queue" | "restore") => R
    : never;
}

export interface PricingCommands {
  /** 费用栏点击与 /cost config 的入口。 */
  openPricingConfig(): Promise<void>;
  /** /cost price <模型> <输入> <输出> …：脚本化写入。 */
  applyPricingFromArgs(args: readonly string[]): Promise<void>;
  /** 最近一次定价查询的过程（侧栏 agent 状态行 / /cost agent）。 */
  showPricingAgentDetails(): void;
  /** 回合结束后：出现未定价模型时问一次。 */
  maybeOfferPricingAgent(): Promise<void>;
}

export function createPricingCommands(ctx: PricingCommandContext): PricingCommands {
  // ── 未定价模型：本会话只提醒一次，之后从侧栏「费用」或 /cost config 进入配置 ──
  const pricingPrompted = new Set<string>(
    Array.isArray(ctx.savedPreference?.pricingPromptedModels)
      ? ctx.savedPreference.pricingPromptedModels.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );
  /** 记下「已提醒过」的模型：跨会话持久化，避免每次启动都问同一批模型。 */
  const markPricingPrompted = (models: readonly string[]): void => {
    let changed = false;
    for (const model of models) {
      if (pricingPrompted.has(model)) continue;
      pricingPrompted.add(model);
      changed = true;
    }
    if (!changed) return;
    const base = loadPreference();
    saveUserPreference(
      {
        model: base?.model || ctx.getSelectedModel(),
        reasoningEffort: base?.reasoningEffort || ctx.getReasoningEffort(),
        ...base,
        pricingPromptedModels: [...pricingPrompted],
      },
      (message) => ctx.ui.writeLine(colors.warnLine(message)),
    );
  };

  /**
   * 单价写盘键：内置 provider 用模型名，自定义渠道用 `<provider>/<model>`。
   * 同名模型可能同时由官方与中转渠道提供，只按模型名落盘会把两个渠道的价串在一起。
   * 查价失败记录也用同一个键，否则自定义渠道下成功后清不掉失败记录。
   */
  const pricingStorageKey = (model: string): string => {
    const providerName = ctx.getCurrentProviderName();
    if (!providerName || isBuiltinProvider(providerName)) return model;
    return channelPricingKey(model, providerName) ?? model;
  };

  /** 把单价写进 ~/.haji/pricing.json，并按新单价立刻重算本会话已发生的调用。 */
  const savePricingFor = (
    model: string,
    inputPerMTokens: number,
    outputPerMTokens: number,
    source: string,
    cachedInputPerMTokens?: number,
    offPeak?: OffPeakPricing,
  ): boolean => {
    const storageKey = pricingStorageKey(model);
    const saved = savePricingOverride(storageKey, {
      inputPerMTokens,
      outputPerMTokens,
      source,
      ...(cachedInputPerMTokens !== undefined ? { cachedInputPerMTokens } : {}),
      ...(offPeak ? { offPeak } : {}),
    });
    if (!saved.ok) {
      ctx.ui.writeLine(colors.red(`写入单价失败：${saved.error}`));
      return false;
    }
    // 有单价了，之前「查不到」的记录就没意义了。
    recordPricingAttempt(storageKey, undefined);
    ctx.publishCostInfo();
    const cachedNote =
      cachedInputPerMTokens !== undefined ? ` · 缓存命中 ¥${cachedInputPerMTokens}` : "";
    const offPeakNote = offPeak
      ? ` · 谷时 ¥${offPeak.inputPerMTokens} / ¥${offPeak.outputPerMTokens}（${formatOffPeakWindow(offPeak.window)}）`
      : "";
    ctx.ui.writeLine(
      colors.okLine(
        `${storageKey} 单价已保存：输入 ¥${inputPerMTokens} / 输出 ¥${outputPerMTokens}${cachedNote}${offPeakNote} 每百万 token（~/.haji/pricing.json）。`,
      ),
    );
    return true;
  };

  let pricingAgentRunning = false;
  /** 最近一次定价查询的过程记录（侧栏那行点开就是它）；只保留本会话最后一次。 */
  let pricingAgentLog: { model: string; startedAt: number; lines: string[] } | undefined;
  const logPricing = (line: string): void => {
    if (!pricingAgentLog) return;
    if (pricingAgentLog.lines.length >= 200) return;
    pricingAgentLog.lines.push(line);
  };
  /** 打开查询过程详情（侧栏点击 agent 状态行 / /cost agent）。 */
  const showPricingAgentDetails = (): void => {
    if (!pricingAgentLog) {
      ctx.ui.writeLine(
        colors.gray("本次会话还没有定价查询记录；先在费用区点「配置单价」交给 agent。"),
      );
      return;
    }
    const { model, startedAt, lines } = pricingAgentLog;
    ctx.ui.writeChat(
      `${[
        colors.bold(`定价查询过程 · ${model}`),
        colors.gray(
          `  开始于 ${new Date(startedAt).toLocaleTimeString("zh-CN")} · ${lines.length} 条记录`,
        ),
        ...lines.map((line) => `  ${line}`),
      ].join(String.fromCharCode(10))}\n`,
    );
  };

  /** 定价检索只用已登记的归属；未知型号不能使用请求路由的默认 provider。 */
  const pricingLookupProvider = (model: string): string | undefined =>
    findProviderForModel(model, ctx.getProviderConfig(), ctx.getCurrentProviderName());
  /**
   * 后台定价 agent：用杂活模型跑一个有界工具循环（只读检索：websearch / webfetch），
   * 结论写回定价覆盖表。不占用输入行，进度显示在侧栏「费用」区。
   */
  const startPricingAgent = (model: string): void => {
    if (pricingAgentRunning) {
      ctx.ui.writeLine(colors.gray("  已有一个定价查询在后台运行，等它结束再试。"));
      return;
    }
    // 只给 websearch 不够：国内网络下检索可能整体失败，webfetch 能直接抓官方定价页。
    const agentTools = PRICING_AGENT_TOOLS.map((name) => ctx.toolsMap.get(name)).filter(
      (tool): tool is NonNullable<typeof tool> => tool !== undefined,
    );
    if (agentTools.length === 0) {
      ctx.ui.writeLine(
        colors.warnLine("当前没有可用的只读检索工具（websearch / webfetch），请手动输入单价。"),
      );
      return;
    }
    const recentFailure = recentPricingFailure(pricingStorageKey(model));
    if (recentFailure) {
      ctx.ui.writeLine(
        colors.warnLine(
          `${model} ${recentFailure}，这次仍会重试；再失败就建议直接用 /cost config 手填。`,
        ),
      );
    }
    pricingAgentRunning = true;
    pricingAgentLog = { model, startedAt: Date.now(), lines: [] };
    const pricingProvider = pricingLookupProvider(model);
    logPricing(`模型 ${model}（provider ${pricingProvider ?? "未知"}）`);
    ctx.ui.setPricingAgentState({ status: "running", model });
    ctx.ui.writeLine(
      colors.gray(`  ↳ 后台查询 ${model} 的官方定价（只读网页检索，不打断当前会话）。`),
    );
    void (async () => {
      const utility = ctx.getUtilityRuntime();
      const agentProvider = utility?.provider ?? ctx.getProvider();
      const agentModel = utility?.model ?? ctx.getSelectedModel();
      const controller = new AbortController();
      try {
        const outcome = await runPricingAgent({
          query: {
            model,
            provider: pricingProvider,
            officialUrls: resolveOfficialPricingUrls(pricingProvider, model),
          },
          abortSignal: controller.signal,
          onEvent: (event) => {
            if (event.type === "step") {
              logPricing(`第 ${event.step}/${event.maxSteps} 步：请求模型`);
              return;
            }
            if (event.type === "tool") {
              const target = event.args.query ?? event.args.url ?? "";
              logPricing(`  → ${event.toolName}(${String(target)})`);
              return;
            }
            if (event.type === "tool_result") {
              logPricing(`  ← ${event.ok ? "成功" : "失败"}：${event.preview}`);
              return;
            }
            if (event.type === "reply") {
              logPricing(`模型回复：${event.preview}`);
              return;
            }
            logPricing(
              event.outcome.ok
                ? `结论：输入 ¥${event.outcome.inputPerMTokens} / 输出 ¥${event.outcome.outputPerMTokens}${
                    event.outcome.cachedInputPerMTokens !== undefined
                      ? ` / 缓存 ¥${event.outcome.cachedInputPerMTokens}`
                      : ""
                  }${
                    event.outcome.offPeak
                      ? ` / 谷时 ¥${event.outcome.offPeak.inputPerMTokens} / ¥${event.outcome.offPeak.outputPerMTokens}`
                      : ""
                  }${event.outcome.source ? `（${event.outcome.source}）` : ""}`
                : `未查到：${event.outcome.reason}`,
            );
          },
          callModel: async (messages) => {
            let toolCalls: ToolCall[] | undefined;
            const text = await agentProvider.complete(messages, {
              model: agentModel,
              reasoningEffort: "low",
              thinking: false,
              maxTokens: 1200,
              tools: agentTools.map((tool) => tool.definition),
              abortSignal: controller.signal,
              onToolCall: (calls) => {
                toolCalls = calls;
              },
            });
            return { text, toolCalls };
          },
          runTool: async (name, args) => {
            const result = await ctx.toolExecutor.execute(name, args, {
              agentId: "pricing-agent",
              permissionMode: ctx.getPermissionMode(),
              riskThreshold: ctx.getRiskThreshold(),
              abortSignal: controller.signal,
            });
            return result.output;
          },
        });
        if (!outcome.ok) {
          recordPricingAttempt(pricingStorageKey(model), outcome.reason);
          ctx.ui.setPricingAgentState({ status: "failed", model, detail: outcome.reason });
          ctx.ui.writeLine(
            colors.warnLine(`定价查询未成功：${outcome.reason}。可用 /cost config 手动输入单价。`),
          );
          return;
        }
        const saved = savePricingFor(
          model,
          outcome.inputPerMTokens,
          outcome.outputPerMTokens,
          outcome.source ? `agent: ${outcome.source}` : "agent 查询",
          outcome.cachedInputPerMTokens,
          outcome.offPeak
            ? {
                inputPerMTokens: outcome.offPeak.inputPerMTokens,
                outputPerMTokens: outcome.offPeak.outputPerMTokens,
                ...(outcome.offPeak.cachedInputPerMTokens !== undefined
                  ? { cachedInputPerMTokens: outcome.offPeak.cachedInputPerMTokens }
                  : {}),
                window: {
                  startMinute: outcome.offPeak.startMinute,
                  endMinute: outcome.offPeak.endMinute,
                  ...(outcome.offPeak.utcOffsetMinutes !== undefined
                    ? { utcOffsetMinutes: outcome.offPeak.utcOffsetMinutes }
                    : {}),
                },
              }
            : undefined,
        );
        ctx.ui.setPricingAgentState(
          saved ? { status: "done", model } : { status: "failed", model, detail: "写入失败" },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.setPricingAgentState({ status: "failed", model, detail: reason });
        ctx.ui.writeLine(colors.warnLine(`定价查询失败：${reason}。可用 /cost config 手动配置。`));
      } finally {
        pricingAgentRunning = false;
      }
    })();
  };

  /**
   * 定价录入要独占输入行：抢走（takeOver）而不是取消——主循环收到
   * TerminalInputTakenOverError 会继续等待下一句，不会把这次操作当成用户退出。
   */
  const readPricingLine = async (prompt: string): Promise<string> => {
    const draft = ctx.ui.takeOverInput();
    try {
      return await ctx.ui.readInput({ prompt });
    } finally {
      if (draft?.trim()) ctx.startBackgroundInput(draft);
    }
  };

  /** 手动录入单价：输入/输出各问一次，两个都是正数才写入。 */
  const configurePricingManually = async (model: string): Promise<void> => {
    const current = resolveModelPricing(model, ctx.getCurrentProviderName());
    const currentHint = current ? `（当前 ${formatPricingLabel(current)}）` : "";
    try {
      const inputText = await readPricingLine(
        colors.muted(`${model} 输入单价（元 / 百万 token）${currentHint}：`),
      );
      const inputPrice = parsePriceInput(inputText);
      if (inputPrice === undefined) {
        ctx.ui.writeLine(colors.red("输入单价必须是大于 0 的数字，已取消。"));
        return;
      }
      const outputText = await readPricingLine(
        colors.muted(`${model} 输出单价（元 / 百万 token）：`),
      );
      const outputPrice = parsePriceInput(outputText);
      if (outputPrice === undefined) {
        ctx.ui.writeLine(colors.red("输出单价必须是大于 0 的数字，已取消。"));
        return;
      }
      // 缓存命中价可选：留空表示该模型没有缓存折扣（或 provider 不上报命中数）。
      const cachedText = await readPricingLine(
        colors.muted(`${model} 缓存命中输入单价（元 / 百万 token，直接回车跳过）：`),
      );
      let cachedPrice: number | undefined;
      if (cachedText.trim()) {
        cachedPrice = parsePriceInput(cachedText);
        if (cachedPrice === undefined) {
          ctx.ui.writeLine(colors.yellow("缓存命中单价无效，已忽略（按普通输入价计费）。"));
        } else if (cachedPrice > inputPrice) {
          ctx.ui.writeLine(colors.yellow("缓存命中单价高于输入单价，已忽略（按普通输入价计费）。"));
          cachedPrice = undefined;
        }
      }
      // 谷时价可选：先问两个谷时单价，再问时段（回车用官方常见的 00:00–09:00 UTC+8）。
      const offPeakText = await readPricingLine(
        colors.muted(`${model} 谷时单价（格式 输入/输出，如 0.25/1；回车跳过）：`),
      );
      let offPeak: OffPeakPricing | undefined;
      if (offPeakText.trim()) {
        const [offInputRaw, offOutputRaw] = offPeakText.split("/").map((part) => part.trim());
        const offInput = parsePriceInput(offInputRaw ?? "");
        const offOutput = parsePriceInput(offOutputRaw ?? "");
        if (offInput === undefined || offOutput === undefined) {
          ctx.ui.writeLine(
            colors.yellow("谷时单价格式不对（要 输入/输出 两个数），已跳过谷时配置。"),
          );
        } else if (offInput >= inputPrice || offOutput >= outputPrice) {
          ctx.ui.writeLine(colors.yellow("谷时单价不低于峰时单价，已跳过谷时配置。"));
        } else {
          const windowText = await readPricingLine(
            colors.muted("谷时时段（如 00:00-09:00，默认北京时间；回车用 00:00-09:00）："),
          );
          const parsedWindow = parseOffPeakWindow(windowText.trim() || "00:00-09:00");
          if (!parsedWindow) {
            ctx.ui.writeLine(colors.yellow("谷时时段格式不对（要 HH:MM-HH:MM），已跳过谷时配置。"));
          } else {
            offPeak = {
              inputPerMTokens: offInput,
              outputPerMTokens: offOutput,
              window: parsedWindow,
            };
          }
        }
      }
      savePricingFor(model, inputPrice, outputPrice, "手动录入", cachedPrice, offPeak);
    } catch {
      ctx.ui.writeLine(colors.gray("  已取消单价录入。"));
    }
  };

  /** /cost price <模型> <输入单价> <输出单价>：脚本化的一次写入。 */
  const applyPricingFromArgs = async (args: readonly string[]): Promise<void> => {
    const [modelArg, inputArg, outputArg, cachedArg, offPeakArg, windowArg] = args;
    if (!modelArg || !inputArg || !outputArg) {
      ctx.ui.writeLine(
        colors.red(
          "用法：/cost price <模型> <输入单价> <输出单价> [缓存命中单价] [谷时输入/谷时输出] [谷时时段]",
        ),
      );
      return;
    }
    const inputPrice = parsePriceInput(inputArg);
    const outputPrice = parsePriceInput(outputArg);
    if (inputPrice === undefined || outputPrice === undefined) {
      ctx.ui.writeLine(colors.red("单价必须是大于 0 的数字（元 / 百万 token）。"));
      return;
    }
    let cachedPrice: number | undefined;
    if (cachedArg?.trim()) {
      cachedPrice = parsePriceInput(cachedArg);
      if (cachedPrice === undefined || cachedPrice > inputPrice) {
        ctx.ui.writeLine(colors.yellow("缓存命中单价无效或高于输入单价，已忽略。"));
        cachedPrice = undefined;
      }
    }
    let offPeak: OffPeakPricing | undefined;
    if (offPeakArg?.trim()) {
      const [offInputRaw, offOutputRaw] = offPeakArg.split("/").map((part) => part.trim());
      const offInput = parsePriceInput(offInputRaw ?? "");
      const offOutput = parsePriceInput(offOutputRaw ?? "");
      const parsedWindow = windowArg?.trim()
        ? parseOffPeakWindow(windowArg)
        : // 省略时段时按官方常见谷时（北京 00:00–09:00）。
          parseOffPeakWindow("00:00-09:00");
      if (offInput === undefined || offOutput === undefined) {
        ctx.ui.writeLine(colors.yellow("谷时单价格式不对（要 输入/输出），已跳过谷时配置。"));
      } else if (offInput >= inputPrice || offOutput >= outputPrice) {
        ctx.ui.writeLine(colors.yellow("谷时单价不低于峰时单价，已跳过谷时配置。"));
      } else if (!parsedWindow) {
        ctx.ui.writeLine(colors.yellow("谷时时段格式不对（要 HH:MM-HH:MM），已跳过谷时配置。"));
      } else {
        offPeak = { inputPerMTokens: offInput, outputPerMTokens: offOutput, window: parsedWindow };
      }
    }
    savePricingFor(modelArg, inputPrice, outputPrice, "手动录入", cachedPrice, offPeak);
  };

  /** 费用栏点击与 /cost config 的入口：选模型 → 手动输入 / agent 查询 / 删除覆盖。 */
  const openPricingConfig = async (): Promise<void> => {
    const summary = ctx.costTracker.getSummary();
    const candidates = [
      ...new Set([...summary.unpricedModels, ...summary.byModel.map((entry) => entry.model)]),
    ];
    if (candidates.length === 0) {
      ctx.ui.writeLine(
        colors.gray("本会话还没有模型调用记录；可用 /cost price <模型> <输入> <输出> 直接配置。"),
      );
      return;
    }
    try {
      const pickedModel = await ctx.readSelectionSafely(
        {
          title: "配置哪个模型的单价？",
          items: candidates.map((model) => {
            const origin = pricingOrigin(model, ctx.getCurrentProviderName());
            return {
              value: model,
              label: model,
              description:
                origin === "none"
                  ? "未定价 · 只能统计 tokens"
                  : origin === "builtin"
                    ? "内置单价"
                    : "本地覆盖",
            };
          }),
        },
        "restore",
      );
      const model = pickedModel.value;
      const origin = pricingOrigin(model, ctx.getCurrentProviderName());
      const pricing = resolveModelPricing(model, ctx.getCurrentProviderName());
      const originLabel =
        origin === "none" ? "未定价" : origin === "builtin" ? "内置单价" : "本地覆盖单价";
      const pickedAction = await ctx.readSelectionSafely(
        {
          title: `${model} · ${originLabel}`,
          preview: [
            pricing
              ? colors.muted(`当前单价：${formatPricingLabel(pricing)}`)
              : colors.muted("当前没有单价，费用只能统计 tokens"),
            ...(pricing?.offPeak
              ? [
                  colors.accent(
                    describeCurrentTier(model) === "offPeak"
                      ? "当前时段：谷时（按谷时价计费）"
                      : "当前时段：峰时（谷时时段外）",
                  ),
                ]
              : []),
          ],
          items: [
            {
              value: "manual",
              label: "手动输入单价",
              description: "写入 ~/.haji/pricing.json",
              hotkey: "m",
            },
            { value: "agent", label: "交给后台 agent 查官方定价", hotkey: "a" },
            ...(origin === "override"
              ? [{ value: "remove", label: "删除本地覆盖", hotkey: "d" }]
              : []),
          ],
        },
        "restore",
      );
      if (pickedAction.value === "manual") {
        await configurePricingManually(model);
      } else if (pickedAction.value === "agent") {
        startPricingAgent(model);
      } else if (pickedAction.value === "remove") {
        if (removePricingOverride(model)) {
          ctx.publishCostInfo();
          ctx.ui.writeLine(colors.okLine(`已删除 ${model} 的本地单价覆盖。`));
        } else {
          ctx.ui.writeLine(colors.gray(`  ${model} 没有本地覆盖。`));
        }
      }
    } catch {
      ctx.ui.writeLine(colors.gray("  已取消（有输入/选择正在进行时，等它结束后再试）。"));
    }
  };

  /**
   * 出现未定价模型时问一次：后台查价 / 手动输入 / 稍后 / 不再提示。
   * 无论选什么都会记为「已提醒」，后续入口只剩侧栏「费用」与 /cost config。
   */
  const maybeOfferPricingAgent = async (): Promise<void> => {
    if (ctx.headless || pricingAgentRunning) return;
    const summary = ctx.costTracker.getSummary();
    const pending = summary.unpricedModels.filter((model) => !pricingPrompted.has(model));
    if (pending.length === 0) return;
    const model = pending[0];
    try {
      const choice = await ctx.readSelectionSafely(
        {
          title: `${model} 没有单价，本次费用只能统计 tokens`,
          items: [
            {
              value: "agent",
              label: "交给后台 agent 查官方定价",
              description: "只读网页检索，不打断当前操作",
              hotkey: "a",
            },
            { value: "manual", label: "我现在手动输入单价", hotkey: "m" },
            { value: "later", label: "稍后再说（侧栏「费用」可随时点开）", hotkey: "l" },
            { value: "never", label: "不再提示这个模型", hotkey: "n" },
          ],
        },
        "restore",
      );
      markPricingPrompted(pending);
      if (choice.value === "agent") {
        startPricingAgent(model);
      } else if (choice.value === "manual") {
        await configurePricingManually(model);
      } else if (choice.value === "later") {
        ctx.ui.writeLine(colors.gray("  提示：点击侧栏「费用」或输入 /cost config 可随时补单价。"));
      }
    } catch {
      // 用户正在输入/选择时插不进对话框：按「已提醒」处理，把入口留给 /cost config。
      markPricingPrompted(pending);
      ctx.ui.writeLine(
        colors.gray("  点击侧栏「费用」或输入 /cost config 可配置单价，本会话不再追问。"),
      );
    }
  };

  return {
    openPricingConfig,
    applyPricingFromArgs,
    showPricingAgentDetails,
    maybeOfferPricingAgent,
  };
}
