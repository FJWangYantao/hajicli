export type ModelProviderName = "deepseek" | "volcengine";

/** 模型定位：utility 档用于压缩/摘要/标题等杂活路由，成本优先。 */
export type ModelTier = "flagship" | "balanced" | "utility";

/**
 * 谷时（off-peak）时段：以「当地分钟数」描述，避免依赖时区数据库。
 * start > end 表示窗口跨零点（例如 23:00–07:00）。
 */
export interface OffPeakWindow {
  /** 窗口起点（当地分钟，0–1439）。 */
  startMinute: number;
  /** 窗口终点（当地分钟，0–1439）。 */
  endMinute: number;
  /** 判定用的时区偏移（分钟）；缺省 480 = UTC+8（北京时间）。 */
  utcOffsetMinutes?: number;
}

/** 谷时单价（每百万 token）与其生效时段。 */
export interface OffPeakPricing {
  inputPerMTokens: number;
  outputPerMTokens: number;
  /** 谷时的缓存命中输入价；缺省沿用缓存价与输入价的关系。 */
  cachedInputPerMTokens?: number;
  window: OffPeakWindow;
}

/** 默认按北京时间判定峰谷（DeepSeek 官方谷时是 UTC 16:30–00:30 = 北京 00:30–08:30）。 */
export const DEFAULT_UTC_OFFSET_MINUTES = 480;

/** 单价（每百万 token）。用于 /cost 估算与 utility 模型路由排序，均为估算值。 */
export interface ModelPricing {
  readonly inputPerMTokens: number;
  readonly outputPerMTokens: number;
  readonly currency: "CNY" | "USD";
  /**
   * 命中缓存的输入单价（每百万 token）；缺省表示该模型没有缓存折扣，
   * 或 provider 不上报缓存命中数——两种情况都按 inputPerMTokens 计费。
   *
   * 下面各模型的缓存价按「输入价的 20%」估算。官方实际比例可能更低
   * （DeepSeek 定价页上 cache hit 约为 cache miss 的 2%），所以真实账单往往比
   * 估算更低；需要精确值就让定价 agent 查官方页，或 /cost price 手动覆盖。
   */
  readonly cachedInputPerMTokens?: number;
  /**
   * 谷时单价：命中 window 的调用按这一组价计费（官方常有「谷时五折」）。
   * 缺省表示该模型没有峰谷分档。
   */
  readonly offPeak?: OffPeakPricing;
}

/** 把「HH:MM」解析成当地分钟数；非法输入返回 undefined。 */
export function parseClockMinute(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

/** 当地分钟数格式化成「HH:MM」。 */
export function formatClockMinute(minuteOfDay: number): string {
  const safe = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/** 解析「00:30-08:30」这样的时段；第二个值可省略时区后缀，例如「00:30-08:30 UTC+8」。 */
export function parseOffPeakWindow(text: string): OffPeakWindow | undefined {
  const trimmed = text.trim();
  // 时区后缀必须显式写成 UTC+8 / GMT-5，否则 "00:30-08:30" 会被误当成 -08:30。
  const zoneMatch = /(?:^|\s)(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(trimmed);
  const withoutZone = zoneMatch ? trimmed.slice(0, zoneMatch.index).trim() : trimmed;
  const parts = withoutZone.split(/[-–~]/).map((part) => part.trim());
  if (parts.length !== 2) return undefined;
  const startMinute = parseClockMinute(parts[0]);
  const endMinute = parseClockMinute(parts[1]);
  if (startMinute === undefined || endMinute === undefined) return undefined;
  const base = {
    startMinute,
    endMinute,
    ...(zoneMatch
      ? {
          utcOffsetMinutes:
            (zoneMatch[1] === "-" ? -1 : 1) *
            (Number(zoneMatch[2]) * 60 + Number(zoneMatch[3] ?? 0)),
        }
      : {}),
  };
  return base;
}

/** 时段展示：`北京时间 00:30–08:30`。 */
export function formatOffPeakWindow(window: OffPeakWindow): string {
  const offset = window.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const zone =
    abs === 0
      ? "UTC"
      : `UTC${sign}${Math.floor(abs / 60)}${abs % 60 === 0 ? "" : `:${String(abs % 60).padStart(2, "0")}`}`;
  return `${zone} ${formatClockMinute(window.startMinute)}–${formatClockMinute(window.endMinute)}`;
}

/** 现在是否落在谷时窗口内（按窗口自带的时区偏移计算）。 */
export function isWithinOffPeak(nowMs: number, window: OffPeakWindow): boolean {
  if (!Number.isFinite(nowMs) || window.startMinute === window.endMinute) return false;
  const offset = window.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;
  const local = nowMs + offset * 60_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const minuteOfDay = Math.floor((((local % dayMs) + dayMs) % dayMs) / 60_000);
  return window.startMinute < window.endMinute
    ? minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute
    : minuteOfDay >= window.startMinute || minuteOfDay < window.endMinute;
}

export interface ModelDescriptor {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly provider: ModelProviderName;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly tier?: ModelTier;
  readonly pricing?: ModelPricing;
}

/** Provider-owned model metadata consumed by the CLI and context policy. */
export const MODEL_REGISTRY = [
  {
    value: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "快速 · 高性价比",
    provider: "deepseek",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    tier: "utility",
    pricing: {
      inputPerMTokens: 0.5,
      outputPerMTokens: 2,
      currency: "CNY",
      cachedInputPerMTokens: 0.1,
      // 官方谷时（UTC 16:30–00:30 = 北京 00:30–08:30）约为峰时五折。
      offPeak: {
        inputPerMTokens: 0.25,
        outputPerMTokens: 1,
        cachedInputPerMTokens: 0.05,
        window: { startMinute: 30, endMinute: 8 * 60 + 30, utcOffsetMinutes: 480 },
      },
    },
  },
  {
    value: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "更强 · 复杂任务",
    provider: "deepseek",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    tier: "flagship",
    pricing: {
      inputPerMTokens: 2,
      outputPerMTokens: 8,
      currency: "CNY",
      cachedInputPerMTokens: 0.4,
      offPeak: {
        inputPerMTokens: 1,
        outputPerMTokens: 4,
        cachedInputPerMTokens: 0.2,
        window: { startMinute: 30, endMinute: 8 * 60 + 30, utcOffsetMinutes: 480 },
      },
    },
  },
  {
    value: "glm-5.2",
    label: "GLM 5.2",
    description: "火山方舟 · 强力通用/代码模型",
    provider: "volcengine",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 16_384,
    tier: "flagship",
    pricing: {
      inputPerMTokens: 2,
      outputPerMTokens: 8,
      currency: "CNY",
      cachedInputPerMTokens: 0.4,
    },
  },
  {
    value: "doubao-pro-32k",
    label: "Doubao Pro 32k",
    description: "火山方舟 · 豆包大模型",
    provider: "volcengine",
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    tier: "balanced",
    pricing: {
      inputPerMTokens: 0.8,
      outputPerMTokens: 2,
      currency: "CNY",
      cachedInputPerMTokens: 0.16,
    },
  },
  {
    value: "doubao-lite-32k",
    label: "Doubao Lite 32k",
    description: "火山方舟 · 豆包轻量大模型",
    provider: "volcengine",
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    tier: "utility",
    pricing: {
      inputPerMTokens: 0.3,
      outputPerMTokens: 0.6,
      currency: "CNY",
      cachedInputPerMTokens: 0.06,
    },
  },
] as const satisfies readonly ModelDescriptor[];

export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(MODEL_REGISTRY.map((model) => [model.value, model.contextWindowTokens])),
);

export function getModelMetadata(modelValue: string): ModelDescriptor | undefined {
  return MODEL_REGISTRY.find((model) => model.value === modelValue);
}

export function getModelPricing(modelValue: string): ModelPricing | undefined {
  return getModelMetadata(modelValue)?.pricing;
}
