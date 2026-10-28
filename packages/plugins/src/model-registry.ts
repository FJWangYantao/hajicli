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
  /**
   * 只在这些星期生效（0 = 周日 … 6 = 周六）；缺省为每天。
   * 用于「工作日按 A 时段、周末全天」这类官方分档。
   */
  weekdays?: readonly number[];
}

/** 谷时单价（每百万 token）与其生效时段。 */
export interface OffPeakPricing {
  inputPerMTokens: number;
  outputPerMTokens: number;
  /** 谷时的缓存命中输入价；缺省沿用缓存价与输入价的关系。 */
  cachedInputPerMTokens?: number;
  /** 谷时时段：单个窗口，或一组不连续的窗口（官方常按多段打折）。 */
  window: OffPeakWindow | readonly OffPeakWindow[];
  /** 时段的人类可读描述；缺省按 window 自动拼接。 */
  label?: string;
}

/** 默认按北京时间判定峰谷（DeepSeek 官方以北京时间为准）。 */
export const DEFAULT_UTC_OFFSET_MINUTES = 480;

/**
 * DeepSeek 官方谷时：除北京时间周一至周五 09:00–12:00、14:00–18:00 外的所有时段，
 * 含周末全天（2026-08-23 起周六日全天谷时）。
 *
 * 刻意只按星期判定、不接法定节假日日历：官方公告的口径是「周六、周日全天按低谷计费」，
 * 没有提法定节假日或调休上班日。按公告字面，国庆这类工作日假期仍有峰时、调休上班的
 * 周六仍是全天谷时；在官方明确前不要自行套国务院放假安排，否则会低估费用。
 */
const DEEPSEEK_OFF_PEAK_WINDOWS: readonly OffPeakWindow[] = [
  // 工作日：00:00–09:00、12:00–14:00、18:00–24:00
  { startMinute: 0, endMinute: 9 * 60, utcOffsetMinutes: 480, weekdays: [1, 2, 3, 4, 5] },
  { startMinute: 12 * 60, endMinute: 14 * 60, utcOffsetMinutes: 480, weekdays: [1, 2, 3, 4, 5] },
  { startMinute: 18 * 60, endMinute: 0, utcOffsetMinutes: 480, weekdays: [1, 2, 3, 4, 5] },
  // 周末：全天（拆成两段，避免与「start === end 表示空窗口」的约定冲突）
  { startMinute: 0, endMinute: 12 * 60, utcOffsetMinutes: 480, weekdays: [0, 6] },
  { startMinute: 12 * 60, endMinute: 0, utcOffsetMinutes: 480, weekdays: [0, 6] },
];

const DEEPSEEK_OFF_PEAK_LABEL = "工作日 00:00–09:00、12:00–14:00、18:00–24:00；周末全天";

/** 单价（每百万 token）。用于 /cost 估算与 utility 模型路由排序，均为估算值。 */
export interface ModelPricing {
  readonly inputPerMTokens: number;
  readonly outputPerMTokens: number;
  readonly currency: "CNY" | "USD";
  /**
   * 命中缓存的输入单价（每百万 token）；缺省表示该模型没有缓存折扣，
   * 或 provider 不上报缓存命中数——两种情况都按 inputPerMTokens 计费。
   *
   * DeepSeek 官方缓存价是输入价的 2%（如 flash 命中 ¥0.04 / 未命中 ¥2），
   * 不要按「20%」估——那是早前的错误口径。
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

function formatUtcOffset(offset: number): string {
  if (offset === 0) return "UTC";
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 === 0 ? "" : `:${String(abs % 60).padStart(2, "0")}`}`;
}

function isWindowList(
  window: OffPeakWindow | readonly OffPeakWindow[],
): window is readonly OffPeakWindow[] {
  return Array.isArray(window);
}

/** 时段展示：`UTC+8 00:30–08:30`；多段用「、」连接。 */
export function formatOffPeakWindow(window: OffPeakWindow | readonly OffPeakWindow[]): string {
  if (isWindowList(window)) {
    const list = window;
    if (list.length === 0) return "";
    const zone = formatUtcOffset(list[0].utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES);
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const item of list) {
      const text = `${formatClockMinute(item.startMinute)}–${formatClockMinute(item.endMinute)}`;
      if (seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
    }
    return `${zone} ${parts.join("、")}`;
  }
  const offset = window.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;
  return `${formatUtcOffset(offset)} ${formatClockMinute(window.startMinute)}–${formatClockMinute(window.endMinute)}`;
}

/** 现在是否落在谷时窗口内（按窗口自带的时区偏移计算；支持多段与星期过滤）。 */
export function isWithinOffPeak(
  nowMs: number,
  window: OffPeakWindow | readonly OffPeakWindow[],
): boolean {
  const windows = isWindowList(window) ? window : [window];
  return windows.some((item) => isWithinSingleOffPeak(nowMs, item));
}

function isWithinSingleOffPeak(nowMs: number, window: OffPeakWindow): boolean {
  if (!Number.isFinite(nowMs) || window.startMinute === window.endMinute) return false;
  const offset = window.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;
  const local = nowMs + offset * 60_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const minuteOfDay = Math.floor((((local % dayMs) + dayMs) % dayMs) / 60_000);
  if (window.weekdays && window.weekdays.length > 0) {
    const weekday = new Date(local).getUTCDay();
    if (!window.weekdays.includes(weekday)) return false;
  }
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
      // 官方人民币高峰价：缓存命中 0.04 / 未命中 2 / 输出 8（每百万 token）。
      inputPerMTokens: 2,
      outputPerMTokens: 8,
      currency: "CNY",
      cachedInputPerMTokens: 0.04,
      // 谷时五折；法定节假日未建模（按工作日算，会略微高估费用）。
      offPeak: {
        inputPerMTokens: 1,
        outputPerMTokens: 4,
        cachedInputPerMTokens: 0.02,
        window: DEEPSEEK_OFF_PEAK_WINDOWS,
        label: DEEPSEEK_OFF_PEAK_LABEL,
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
      // 官方人民币高峰价：缓存命中 0.3 / 未命中 9 / 输出 27（每百万 token）。
      inputPerMTokens: 9,
      outputPerMTokens: 27,
      currency: "CNY",
      cachedInputPerMTokens: 0.3,
      offPeak: {
        inputPerMTokens: 4.5,
        outputPerMTokens: 13.5,
        cachedInputPerMTokens: 0.15,
        window: DEEPSEEK_OFF_PEAK_WINDOWS,
        label: DEEPSEEK_OFF_PEAK_LABEL,
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
