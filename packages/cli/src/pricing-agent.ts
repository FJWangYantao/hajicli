import type { ChatMessage, ToolCall } from "@hajicli/core";

/**
 * 后台定价 agent：为「查不到单价」的模型查一次官方价格。
 *
 * 这里只放纯逻辑与一个可注入的有界工具循环，不直接持有 provider / 工具表，
 * 便于单测覆盖提示词与解析，也保证它在任何权限档下都只做只读检索。
 * 结论只有两种：给出可写入覆盖表的单价，或明确说明查不到。
 */
export interface PricingAgentQuery {
  model: string;
  /** 归属 provider（deepseek / volcengine / 自定义名称），用于缩小检索范围。 */
  provider?: string;
  /** 已知的官方定价页候选（由 CLI 按 provider 与上游模型推导），让 agent 优先直接抓。 */
  officialUrls?: readonly string[];
}

/**
 * 定价 agent 可用的只读工具。
 *
 * 只有 websearch 不够：国内网络下 DuckDuckGo 检索可能整体失败，
 * 而 webfetch 只要能拿到官方定价页 URL 就能直接读到价格，成功率更高。
 */
export const PRICING_AGENT_TOOLS = ["websearch", "webfetch"] as const;

/** 内置 provider 的官方定价页；中转/自定义 provider 没有公开定价，只能退回上游官方价。 */
const OFFICIAL_PRICING_URLS: Record<string, readonly string[]> = {
  deepseek: ["https://api-docs.deepseek.com/quick_start/pricing"],
  volcengine: [
    "https://www.volcengine.com/docs/82379/1099320",
    "https://www.volcengine.com/docs/82379/1544106",
  ],
};

/** 按 provider 名取官方定价页候选（未知 provider 返回空数组）。 */
export function resolveOfficialPricingUrls(provider: string | undefined): string[] {
  const key = (provider || "").trim().toLowerCase();
  return [...(OFFICIAL_PRICING_URLS[key] || [])];
}

/**
 * 从带前缀的模型名里取出上游模型名：`cn:deepseek-v4.1-flash`、`openai/gpt-4o`、
 * `vendor:model` 这类别名在官方文档里查不到，去掉前缀才是有定价的那个。
 */
export function deriveUpstreamModel(model: string): string {
  const trimmed = model.trim();
  const tail = trimmed.split(/[:/]/).pop()?.trim() || "";
  return tail.length > 0 ? tail : trimmed;
}

export type PricingAgentOutcome =
  | {
      ok: true;
      inputPerMTokens: number;
      outputPerMTokens: number;
      /** 命中缓存的输入单价；官网有这个档位才返回，没有就省略（按输入价计）。 */
      cachedInputPerMTokens?: number;
      /** 谷时（off-peak）单价与时段；官网有峰谷分档才返回。 */
      offPeak?: {
        inputPerMTokens: number;
        outputPerMTokens: number;
        cachedInputPerMTokens?: number;
        startMinute: number;
        endMinute: number;
        utcOffsetMinutes?: number;
      };
      /** 出处（官网定价页 URL 或页面标题），写入覆盖表便于回溯。 */
      source?: string;
    }
  | { ok: false; reason: string };

/** 最多允许的模型调用轮数：定价是一问一答的检索任务，超过这个数一定是在绕圈。 */
export const PRICING_AGENT_MAX_STEPS = 5;

/**
 * 单次工具结果注入长度上限：搜索结果很长，全塞回上下文只会拖慢下一步；
 * 但官方定价页往往在 3–8k 字符之间（价格表在后面），取得太小会把单价截掉。
 */
export const PRICING_AGENT_TOOL_OUTPUT_LIMIT = 8_000;

/**
 * 提示词：只要一份可写入的单价，不要解释、不要改文件。
 * 明确要求「以官方定价页为准」，避免 agent 拿博客/二手文章里的旧价格；
 * 同时交代清楚 websearch 失败就换 webfetch、中转 provider 用上游官方价兜底。
 */
export function buildPricingAgentMessages(query: PricingAgentQuery): ChatMessage[] {
  const upstream = deriveUpstreamModel(query.model);
  const providerHint = query.provider?.trim()
    ? `归属 provider：${query.provider.trim()}`
    : "归属 provider：未知（按模型名查官方文档）";
  const system = [
    "你是模型定价查询助手，只做一件事：查到一个模型的官方单价并返回结构化结果。",
    "规则：",
    "1. 只允许 websearch 与 webfetch 两个只读工具；不改文件、不执行命令。",
    "2. websearch 返回网络失败/被拦截时，不要重复同一个关键词：改用 webfetch 直接抓候选官方定价页。",
    "3. 只认官方定价页或官方文档；找不到官方来源就不要猜。",
    "4. 模型名带前缀（cn:xxx、openai/xxx）时，前缀只是中转/自定义 provider 的别名：",
    "   这类 provider 往往没有公开定价，此时查上游同名模型的官方价，",
    "   并在 source 写成「上游官方价：<URL>」，让用户知道这是估算口径。",
    "5. 单价统一换算为「元 / 百万 tokens」，保留原币种数值，不要做汇率换算。",
    "6. 如果官方定价页区分「缓存命中（cache hit / 缓存命中输入）」与普通输入价，",
    "   额外返回 cachedInputPerMTokens；没有这个档位就不要编造。",
    "6b. 如果官方区分峰谷价（off-peak / 谷时 / 闲时），额外返回 offPeak：",
    '   {"inputPerMTokens":..,"outputPerMTokens":..,"startMinute":..,"endMinute":..,"utcOffsetMinutes":..}',
    "   时段按官方原文换算成「当地分钟数」（例如北京 00:30–08:30 → 30 到 510，offset 480）。",
    "7. 工具调用总共不超过 3 次；信息够了就立即给结论。",
    "8. 结论只能是下列两种 JSON 之一，不要输出其他文字：",
    '   {"inputPerMTokens": 0.5, "outputPerMTokens": 2, "cachedInputPerMTokens": 0.1, "source": "https://..."}',
    '   {"unresolved": "查不到官方定价的原因"}',
  ].join("\n");
  const user = [
    `请查询模型 ${query.model} 的官方定价。`,
    providerHint,
    upstream !== query.model ? `可查的上游模型名：${upstream}` : "",
    ...(query.officialUrls?.length
      ? ["已知候选官方定价页（优先直接抓取）：", ...query.officialUrls.map((url) => `- ${url}`)]
      : []),
    "需要输入（prompt/input）与输出（completion/output）两侧的单价。",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function positiveNumber(value: unknown): number | undefined {
  const candidate = typeof value === "string" ? Number(value.trim()) : value;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : undefined;
}

/**
 * 解析 agent 的最终回复：容忍 ```json 包裹、前后多余解释；
 * 只要出现 <0 的数字或字段缺失，就当作没查到（宁可让用户手填，也不要写入错误单价）。
 */
export function parsePricingAgentReply(text: string): PricingAgentOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "模型没有返回内容" };
  const candidates = [
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
    ...(trimmed.match(/\{[\s\S]*?\}/g) ?? []),
  ];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const value = parsed as Record<string, unknown>;
    if (typeof value.unresolved === "string" && value.unresolved.trim()) {
      return { ok: false, reason: value.unresolved.trim() };
    }
    const input = positiveNumber(value.inputPerMTokens ?? value.input);
    const output = positiveNumber(value.outputPerMTokens ?? value.output);
    if (input === undefined || output === undefined) continue;
    // 缓存价必须真的更低才有意义；比输入价还高说明模型记错了，直接丢弃。
    const cachedRaw = positiveNumber(
      value.cachedInputPerMTokens ?? value.cachedInput ?? value.cacheInputPerMTokens,
    );
    const cached = cachedRaw !== undefined && cachedRaw < input ? cachedRaw : undefined;
    const source =
      typeof value.source === "string" && value.source.trim() ? value.source.trim() : undefined;
    return {
      ok: true,
      inputPerMTokens: input,
      outputPerMTokens: output,
      ...(cached !== undefined ? { cachedInputPerMTokens: cached } : {}),
      ...(parseOffPeakFromReply(value.offPeak, input, output) ?? {}),
      ...(source ? { source } : {}),
    };
  }
  return { ok: false, reason: "模型没有给出可解析的定价结论" };
}

/**
 * 解析 agent 给出的谷时价：单价必须为正、时段分钟必须合法、且谷时价确实低于峰时价
 * （否则说明模型看错了档位；宁可不写谷时，也不要把费用算少）。
 */
function parseOffPeakFromReply(
  raw: unknown,
  peakInput: number,
  peakOutput: number,
): { offPeak: NonNullable<Extract<PricingAgentOutcome, { ok: true }>["offPeak"]> } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const input = positiveNumber(value.inputPerMTokens ?? value.input);
  const output = positiveNumber(value.outputPerMTokens ?? value.output);
  if (input === undefined || output === undefined) return undefined;
  if (input >= peakInput || output >= peakOutput) return undefined;
  const startMinute = Number(value.startMinute);
  const endMinute = Number(value.endMinute);
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) return undefined;
  if (startMinute < 0 || startMinute > 1439 || endMinute < 0 || endMinute > 1439) return undefined;
  if (startMinute === endMinute) return undefined;
  const cachedRaw = positiveNumber(value.cachedInputPerMTokens ?? value.cachedInput);
  const cached = cachedRaw !== undefined && cachedRaw < input ? cachedRaw : undefined;
  const offsetRaw = Number(value.utcOffsetMinutes);
  return {
    offPeak: {
      inputPerMTokens: input,
      outputPerMTokens: output,
      ...(cached !== undefined ? { cachedInputPerMTokens: cached } : {}),
      startMinute,
      endMinute,
      ...(Number.isFinite(offsetRaw) && Math.abs(offsetRaw) <= 14 * 60
        ? { utcOffsetMinutes: Math.trunc(offsetRaw) }
        : {}),
    },
  };
}

export interface PricingAgentModelReply {
  text: string;
  toolCalls?: readonly ToolCall[];
}

/** 定价查询过程事件：侧栏只显示一行摘要，详情页（点侧栏那行）靠它还原全过程。 */
export type PricingAgentEvent =
  | { type: "step"; step: number; maxSteps: number }
  | { type: "tool"; step: number; toolName: string; args: Record<string, unknown> }
  | { type: "tool_result"; step: number; toolName: string; ok: boolean; preview: string }
  | { type: "reply"; step: number; preview: string }
  | { type: "done"; outcome: PricingAgentOutcome };

export interface PricingAgentRunnerOptions {
  query: PricingAgentQuery;
  /** 一次模型调用；由 CLI 注入（带 websearch 工具定义与杂活模型）。 */
  callModel: (messages: ChatMessage[], step: number) => Promise<PricingAgentModelReply>;
  /** 执行一次工具调用；只允许只读检索，返回值直接回灌给模型。 */
  runTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  /** 过程事件（步骤、工具调用、工具结果摘要、模型回复摘要、最终结论）。 */
  onEvent?: (event: PricingAgentEvent) => void;
}

/** 单行摘要：把工具结果/模型回复压成一行，供详情页快速扫读。 */
export function previewForLog(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function abortOutcome(): PricingAgentOutcome {
  return { ok: false, reason: "定价查询已取消" };
}

/**
 * 有界工具循环：模型要检索就检索，给出 JSON 就结束。
 * 达到轮数上限、被中止、或模型既不检索也不给结论时统一返回失败原因。
 */
export async function runPricingAgent(
  options: PricingAgentRunnerOptions,
): Promise<PricingAgentOutcome> {
  const maxSteps = Math.max(1, options.maxSteps ?? PRICING_AGENT_MAX_STEPS);
  const messages = buildPricingAgentMessages(options.query);
  let lastReason = "定价查询没有得出结论";
  for (let step = 1; step <= maxSteps; step += 1) {
    if (options.abortSignal?.aborted) return abortOutcome();
    options.onEvent?.({ type: "step", step, maxSteps });
    const reply = await options.callModel(messages, step);
    if (options.abortSignal?.aborted) return abortOutcome();
    const toolCalls = reply.toolCalls ?? [];
    if (toolCalls.length === 0) {
      const outcome = parsePricingAgentReply(reply.text);
      options.onEvent?.({ type: "reply", step, preview: previewForLog(reply.text) });
      options.onEvent?.({ type: "done", outcome });
      return outcome;
    }
    messages.push({
      role: "assistant",
      content: reply.text,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      })),
    });
    for (const call of toolCalls) {
      if (options.abortSignal?.aborted) return abortOutcome();
      if (!(PRICING_AGENT_TOOLS as readonly string[]).includes(call.function.name)) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `错误: 定价查询只允许 ${PRICING_AGENT_TOOLS.join(" / ")}，已拒绝调用 ${call.function.name}`,
        });
        lastReason = `模型尝试调用不允许的工具 ${call.function.name}`;
        continue;
      }
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments || "{}") as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "错误: 参数不是合法 JSON，请重新给出 query 字段",
        });
        continue;
      }
      options.onEvent?.({ type: "tool", step, toolName: call.function.name, args });
      const output = await options.runTool(call.function.name, args);
      options.onEvent?.({
        type: "tool_result",
        step,
        toolName: call.function.name,
        ok: !/^(?:错误|网络搜索失败)/.test(output.trim()),
        preview: previewForLog(output),
      });
      const bounded =
        output.length > PRICING_AGENT_TOOL_OUTPUT_LIMIT
          ? `${output.slice(0, PRICING_AGENT_TOOL_OUTPUT_LIMIT)}…（已截断）`
          : output;
      messages.push({ role: "tool", tool_call_id: call.id, content: bounded });
    }
  }
  const outcome: PricingAgentOutcome = {
    ok: false,
    reason: lastReason === "定价查询没有得出结论" ? `超过 ${maxSteps} 步仍未结论` : lastReason,
  };
  options.onEvent?.({ type: "done", outcome });
  return outcome;
}
