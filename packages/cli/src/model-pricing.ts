import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatOffPeakWindow,
  getModelPricing,
  isWithinOffPeak,
  type ModelPricing,
  type OffPeakPricing,
  type OffPeakWindow,
} from "@hajicli/plugins";

/**
 * 模型定价覆盖表：~/.haji/pricing.json。
 *
 * 内置注册表只覆盖少数官方模型；自定义 provider / ~/.haji/models.json 里登记的
 * 新模型都没有单价，`/cost` 只能统计 tokens。这个文件让用户（或后台定价 agent）
 * 给任意模型补一份单价，费用统计立刻按新单价重算——历史记录不落金额，
 * 所以补价后本会话已发生的调用也会一起被算出来。
 *
 * 优先级：内置注册表 > 覆盖表。内置单价是发布时校准过的，不应被本地文件悄悄改掉。
 */
export interface PricingOverrideEntry {
  /** 输入单价（元 / 百万 token）。 */
  inputPerMTokens: number;
  /** 输出单价（元 / 百万 token）。 */
  outputPerMTokens: number;
  /** 命中缓存的输入单价（元 / 百万 token）；不填表示无缓存折扣。 */
  cachedInputPerMTokens?: number;
  /** 谷时单价与生效时段；不填表示该模型不分峰谷。 */
  offPeak?: OffPeakPricing;
  /** 来源说明：手动录入或后台 agent 查到的出处链接。 */
  source?: string;
  /** 写入时间（ISO）。 */
  updatedAt?: string;
}

export type PricingTable = Record<string, PricingOverrideEntry>;

/** 覆盖表路径；HAJI_PRICING_PATH 供测试与多账号隔离使用。 */
export function pricingOverridesPath(): string {
  const override = process.env.HAJI_PRICING_PATH?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".haji", "pricing.json");
}

/** 合法单价：有限正数。0 或负数视为无效，避免把费用算成免费。 */
export function isValidPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 校验谷时配置：单价必须为正，时段分钟必须在 0–1439 且起止不同。 */
export function normalizeOffPeak(raw: unknown): OffPeakPricing | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!isValidPrice(value.inputPerMTokens) || !isValidPrice(value.outputPerMTokens))
    return undefined;
  const windowRaw = value.window as Record<string, unknown> | undefined;
  const startMinute = Number(windowRaw?.startMinute);
  const endMinute = Number(windowRaw?.endMinute);
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) return undefined;
  if (startMinute < 0 || startMinute > 1439 || endMinute < 0 || endMinute > 1439) return undefined;
  if (startMinute === endMinute) return undefined;
  const offsetRaw = Number(windowRaw?.utcOffsetMinutes);
  const window: OffPeakWindow = {
    startMinute,
    endMinute,
    ...(Number.isFinite(offsetRaw) && Math.abs(offsetRaw) <= 14 * 60
      ? { utcOffsetMinutes: Math.trunc(offsetRaw) }
      : {}),
  };
  return {
    inputPerMTokens: value.inputPerMTokens,
    outputPerMTokens: value.outputPerMTokens,
    ...(isValidPrice(value.cachedInputPerMTokens)
      ? { cachedInputPerMTokens: value.cachedInputPerMTokens }
      : {}),
    window,
  };
}

function normalizeEntry(raw: unknown): PricingOverrideEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  if (!isValidPrice(entry.inputPerMTokens) || !isValidPrice(entry.outputPerMTokens))
    return undefined;
  return {
    inputPerMTokens: entry.inputPerMTokens,
    outputPerMTokens: entry.outputPerMTokens,
    ...(isValidPrice(entry.cachedInputPerMTokens)
      ? { cachedInputPerMTokens: entry.cachedInputPerMTokens }
      : {}),
    ...(normalizeOffPeak(entry.offPeak) ? { offPeak: normalizeOffPeak(entry.offPeak) } : {}),
    ...(typeof entry.source === "string" && entry.source.trim()
      ? { source: entry.source.trim() }
      : {}),
    ...(typeof entry.updatedAt === "string" && entry.updatedAt.trim()
      ? { updatedAt: entry.updatedAt.trim() }
      : {}),
  };
}

let loadCache: { mtimeMs: number; table: PricingTable } | undefined;

/** 读取覆盖表（文件缺失/损坏/结构非法一律回空表；按 mtime 缓存避免高频读盘）。 */
export function loadPricingOverrides(): PricingTable {
  const filePath = pricingOverridesPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    loadCache = undefined;
    return {};
  }
  if (loadCache && loadCache.mtimeMs === mtimeMs) return loadCache.table;
  const table: PricingTable = {};
  try {
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text) as { models?: unknown };
    const models = parsed?.models;
    if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const [model, value] of Object.entries(models as Record<string, unknown>)) {
        const key = model.trim();
        if (!key) continue;
        const entry = normalizeEntry(value);
        if (entry) table[key] = entry;
      }
    }
  } catch {
    // 损坏文件按空表处理：宁可显示“未定价”，也不要让费用算出错误的数。
    loadCache = undefined;
    return {};
  }
  loadCache = { mtimeMs, table };
  return table;
}

function writePricingTable(table: PricingTable): { ok: boolean; error?: string } {
  const filePath = pricingOverridesPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const sorted: PricingTable = {};
    for (const key of Object.keys(table).sort()) sorted[key] = table[key];
    fs.writeFileSync(filePath, JSON.stringify({ models: sorted }, null, 2), "utf8");
    loadCache = undefined;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 写入/更新一个模型的单价。 */
export function savePricingOverride(
  model: string,
  entry: {
    inputPerMTokens: number;
    outputPerMTokens: number;
    /** 命中缓存的输入单价；不填表示该模型没有缓存折扣。 */
    cachedInputPerMTokens?: number;
    /** 谷时单价与时段；不填表示不分峰谷。 */
    offPeak?: OffPeakPricing;
    source?: string;
  },
): { ok: boolean; error?: string } {
  const key = model.trim();
  if (!key) return { ok: false, error: "模型名不能为空" };
  if (!isValidPrice(entry.inputPerMTokens) || !isValidPrice(entry.outputPerMTokens)) {
    return { ok: false, error: "单价必须是大于 0 的数字（元 / 百万 token）" };
  }
  const table = loadPricingOverrides();
  table[key] = {
    inputPerMTokens: entry.inputPerMTokens,
    outputPerMTokens: entry.outputPerMTokens,
    ...(isValidPrice(entry.cachedInputPerMTokens)
      ? { cachedInputPerMTokens: entry.cachedInputPerMTokens }
      : {}),
    ...(normalizeOffPeak(entry.offPeak) ? { offPeak: normalizeOffPeak(entry.offPeak) } : {}),
    ...(entry.source?.trim() ? { source: entry.source.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  return writePricingTable(table);
}

/** 删除某个模型的单价覆盖；返回是否真的删掉了。 */
export function removePricingOverride(model: string): boolean {
  const key = model.trim();
  const table = loadPricingOverrides();
  if (!(key in table)) return false;
  delete table[key];
  return writePricingTable(table).ok;
}

/**
 * 解析模型单价：内置注册表优先，其次本地覆盖表。
 * 返回 undefined 表示这个模型仍然没有可用单价（费用只能统计 tokens）。
 */
export function resolveModelPricing(model: string): ModelPricing | undefined {
  const builtin = getModelPricing(model);
  if (builtin) return builtin;
  const entry = loadPricingOverrides()[model];
  if (!entry) return undefined;
  return {
    inputPerMTokens: entry.inputPerMTokens,
    outputPerMTokens: entry.outputPerMTokens,
    currency: "CNY",
    ...(entry.cachedInputPerMTokens !== undefined
      ? { cachedInputPerMTokens: entry.cachedInputPerMTokens }
      : {}),
    ...(entry.offPeak ? { offPeak: entry.offPeak } : {}),
  };
}

/**
 * 单价展示：`¥2 / ¥8 每 M（缓存 ¥0.4）`，有谷时价时再追加
 * `；谷时 ¥1 / ¥4（工作日 00:00–09:00、12:00–14:00、18:00–24:00；周末全天）`。
 */
export function formatPricingLabel(pricing: ModelPricing): string {
  const trim = (value: number): string => String(Number(value.toFixed(4)));
  const base = `¥${trim(pricing.inputPerMTokens)} / ¥${trim(pricing.outputPerMTokens)} 每 M`;
  const cache =
    pricing.cachedInputPerMTokens !== undefined
      ? `（缓存 ¥${trim(pricing.cachedInputPerMTokens)}）`
      : "";
  const offPeak = pricing.offPeak
    ? `；谷时 ¥${trim(pricing.offPeak.inputPerMTokens)} / ¥${trim(pricing.offPeak.outputPerMTokens)}（${pricing.offPeak.label ?? formatOffPeakWindow(pricing.offPeak.window)}）`
    : "";
  return `${base}${cache}${offPeak}`;
}

/** 现在这个时刻该模型走峰价还是谷价（详情页与手动配置回显用）。 */
export function describeCurrentTier(model: string, now = Date.now()): "peak" | "offPeak" | "flat" {
  const pricing = resolveModelPricing(model);
  if (!pricing) return "flat";
  if (!pricing.offPeak) return "flat";
  return isWithinOffPeak(now, pricing.offPeak.window) ? "offPeak" : "peak";
}

/** 该模型的单价来自哪里：内置注册表 / 本地覆盖 / 无。 */
export function pricingOrigin(model: string): "builtin" | "override" | "none" {
  if (getModelPricing(model)) return "builtin";
  return model in loadPricingOverrides() ? "override" : "none";
}

/** 手动输入的单价格式：接受 "2"、"2.5"、"¥2" 这类写法。 */
export function parsePriceInput(text: string): number | undefined {
  const cleaned = text
    .trim()
    .replace(/^[¥￥$]/, "")
    .replace(/元$/, "")
    .trim();
  if (!cleaned) return undefined;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * 定价查询失败缓存：~/.haji/pricing-agent-cache.json。
 *
 * 成功的定价本身已经落在 pricing.json（等于永久缓存）；这里只记「查过但没查到」的结论，
 * 免得对同一个中转模型反复烧请求。默认 24 小时内不再自动重试。
 */
export interface PricingLookupAttempt {
  /** 最近一次查询的时间（ISO）。 */
  at: string;
  /** 失败原因；成功时为空（成功不需要记在这里）。 */
  reason: string;
}

export const PRICING_LOOKUP_RETRY_MS = 24 * 60 * 60 * 1000;

export function pricingAgentCachePath(): string {
  const override = process.env.HAJI_PRICING_AGENT_CACHE_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(path.dirname(pricingOverridesPath()), "pricing-agent-cache.json");
}

let attemptCache: { mtimeMs: number; table: Record<string, PricingLookupAttempt> } | undefined;

export function loadPricingAttempts(): Record<string, PricingLookupAttempt> {
  const filePath = pricingAgentCachePath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    attemptCache = undefined;
    return {};
  }
  if (attemptCache && attemptCache.mtimeMs === mtimeMs) return attemptCache.table;
  const table: Record<string, PricingLookupAttempt> = {};
  try {
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text) as { attempts?: unknown };
    if (
      parsed?.attempts &&
      typeof parsed.attempts === "object" &&
      !Array.isArray(parsed.attempts)
    ) {
      for (const [model, value] of Object.entries(parsed.attempts as Record<string, unknown>)) {
        const entry = value as { at?: unknown; reason?: unknown };
        if (typeof entry?.at !== "string" || typeof entry?.reason !== "string") continue;
        table[model] = { at: entry.at, reason: entry.reason };
      }
    }
  } catch {
    attemptCache = undefined;
    return {};
  }
  attemptCache = { mtimeMs, table };
  return table;
}

function writePricingAttempts(table: Record<string, PricingLookupAttempt>): void {
  const filePath = pricingAgentCachePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ attempts: table }, null, 2), "utf8");
  } catch {
    // 缓存写失败不影响主流程：最坏结果是下次再查一遍。
  } finally {
    attemptCache = undefined;
  }
}

/** 记一次失败的查询（成功时清掉记录）。 */
export function recordPricingAttempt(model: string, reason: string | undefined): void {
  const key = model.trim();
  if (!key) return;
  const table = { ...loadPricingAttempts() };
  if (reason === undefined) {
    if (!(key in table)) return;
    delete table[key];
    writePricingAttempts(table);
    return;
  }
  table[key] = { at: new Date().toISOString(), reason };
  writePricingAttempts(table);
}

/**
 * 最近一次失败是否还在重试窗口内；返回原因（含「多久之前」）表示不要重复查询。
 * 查询成功后应将记录清空：recordPricingAttempt(model, undefined)。
 */
export function recentPricingFailure(
  model: string,
  now = Date.now(),
  windowMs = PRICING_LOOKUP_RETRY_MS,
): string | undefined {
  const entry = loadPricingAttempts()[model.trim()];
  if (!entry) return undefined;
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at) || now - at >= windowMs) return undefined;
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  const ago = minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
  return `${ago}查询失败（${entry.reason}）`;
}
