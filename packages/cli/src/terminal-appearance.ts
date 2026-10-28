import { stdin, stdout } from "node:process";
import type { ThemeAppearance } from "./theme.js";

/**
 * 终端外观探测。
 *
 * haji 默认不再绘制整屏底色（与 pi 一致），因此前景色必须跟着终端自身的
 * 明暗走：深色终端用深色调色板，浅色终端用浅色调色板，否则会出现
 * 「浅灰字压在白底上」的低可读性组合。
 *
 * 探测顺序（先快后准）：
 *   1. 显式覆盖：环境变量 HAJI_THEME_APPEARANCE=dark|light
 *   2. 用户持久化的外观（theme.json 的 `appearance`，由 `/appearance` 写入）
 *   3. COLORFGBG（rxvt / 部分终端）尾部颜色索引
 *   4. OSC 11 查询终端默认背景色（`\x1b]11;?\x07`），按相对亮度判定
 *   5. 全部失败时回退 dark（与历史行为一致）
 */

/** 单次探测的默认超时：终端通常在毫秒级回复，超时即放弃并回退。 */
const DEFAULT_QUERY_TIMEOUT_MS = 120;

/** 解析 OSC 11 回复中的颜色分量（rgb:RRRR/GGGG/BBBB 或 rgb:R/G/B），返回 0..1 归一化 sRGB。 */
function parseColorSpec(spec: string): [number, number, number] | undefined {
  const match = /^rgba?:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(spec.trim());
  if (!match) return undefined;
  const toUnit = (value: string): number => {
    const max = 16 ** value.length - 1;
    return max > 0 ? Number.parseInt(value, 16) / max : 0;
  };
  return [toUnit(match[1]), toUnit(match[2]), toUnit(match[3])];
}

/** sRGB（0..1）相对亮度，用于判断背景是深是浅。 */
function relativeLuminance(rgb: readonly [number, number, number]): number {
  const linear = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/**
 * 从终端上报的背景色判断应使用哪套调色板：
 * 浅色背景（相对亮度高）→ light，反之 → dark。
 */
export function appearanceFromBackgroundColor(
  rgb: readonly [number, number, number],
): ThemeAppearance {
  return relativeLuminance(rgb) > 0.5 ? "light" : "dark";
}

/** 最近一次 OSC 11 探测到的终端底色（#rrggbb）；没探测过或探测失败为 undefined。 */
let detectedBackground: string | undefined;

/**
 * 终端真实底色。主题背景为空（跟随终端）时，首页光晕要拿它做混色基准，
 * 否则光晕边缘会和真实底色对不上、露出一圈色块；拿不到就不画光晕。
 */
export function getDetectedTerminalBackground(): string | undefined {
  return detectedBackground;
}

/** 从一段终端输出中提取 OSC 11 回复。支持 BEL 与 ST 两种终止符。 */
export function parseOsc11Reply(value: string): ThemeAppearance | undefined {
  const match = /\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(value);
  if (!match) return undefined;
  const rgb = parseColorSpec(match[1]);
  if (!rgb) return undefined;
  detectedBackground = `#${rgb
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
  return appearanceFromBackgroundColor(rgb);
}

/** 环境变量里显式指定的外观（HAJI_THEME_APPEARANCE）；没有则 undefined。 */
function forcedAppearanceFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ThemeAppearance | undefined {
  const forced = env.HAJI_THEME_APPEARANCE?.trim().toLowerCase();
  return forced === "dark" || forced === "light" ? forced : undefined;
}

/** 从环境变量推断外观；无可用信息时返回 undefined。 */
export function detectAppearanceFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ThemeAppearance | undefined {
  const forced = forcedAppearanceFromEnv(env);
  if (forced) return forced;

  // COLORFGBG 形如 "15;0"：最后一个字段是背景的 ANSI 索引。
  const fgbg = env.COLORFGBG?.split(";").at(-1)?.trim();
  if (fgbg && /^\d{1,2}$/.test(fgbg)) {
    const index = Number(fgbg);
    if (index <= 15) return index === 7 || index === 15 ? "light" : "dark";
  }
  return undefined;
}

export interface DetectAppearanceOptions {
  /** 超时毫秒数；超时则回退到环境变量或 dark。 */
  timeoutMs?: number;
  /**
   * 用户持久化的外观（`/appearance` 写入 theme.json 的值）。
   * 有值时跳过所有启发式探测：用户已经明确告诉过我们终端底色，没必要再猜。
   */
  preferred?: ThemeAppearance;
  /** 注入 stdin（测试用）。 */
  input?: Pick<NodeJS.ReadStream, "isTTY" | "isRaw" | "setRawMode" | "resume" | "on" | "off">;
  /** 注入 stdout（测试用）。 */
  output?: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  /** 注入环境变量（测试用）。 */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 探测终端外观：先看显式设置，再向终端查询默认背景色。
 *
 * 优先级：`HAJI_THEME_APPEARANCE` 环境变量 > 用户持久化的 `appearance`
 * > COLORFGBG > OSC 11 查询 > 回退 dark。前两者都是用户的明确选择，
 * 有值时完全跳过启发式探测（探测在部分终端/ssh/tmux 组合里会失败，
 * 一旦失败回退成 dark，白底终端上就变成浅灰字压白底）。
 *
 * 查询需要临时进入 raw mode（否则行缓冲会吞掉没有换行的回复），
 * 结束后立即恢复原来的模式；整个探测是尽力而为的，任何失败都回退 dark。
 */
export async function detectTerminalAppearance(
  options: DetectAppearanceOptions = {},
): Promise<ThemeAppearance> {
  const {
    timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
    preferred,
    input = stdin,
    output = stdout,
    env = process.env,
  } = options;

  const forced = forcedAppearanceFromEnv(env);
  if (forced) return forced;
  if (preferred) return preferred;

  const fromEnv = detectAppearanceFromEnv(env);
  if (fromEnv) return fromEnv;

  if (!input.isTTY || !output.isTTY) return "dark";

  const wasRaw = Boolean(input.isRaw);
  try {
    input.setRawMode(true);
  } catch {
    return "dark";
  }
  input.resume();

  return await new Promise<ThemeAppearance>((resolve) => {
    let settled = false;
    const finish = (appearance: ThemeAppearance | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", onData);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // 恢复失败时保持原状，避免因清理动作抛错中断启动。
      }
      resolve(appearance ?? "dark");
    };

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const appearance = parseOsc11Reply(text);
      if (appearance) finish(appearance);
    };

    const timer = setTimeout(() => finish(undefined), timeoutMs);

    input.on("data", onData);
    output.write("\x1b]11;?\x07");
  });
}
