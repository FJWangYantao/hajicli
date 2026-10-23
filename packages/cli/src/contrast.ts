import { formatHex, parseHex, type Rgb } from "./oklab.js";

/**
 * WCAG 对比度工具。
 *
 * 背景交给终端之后，一个隐患是「用户自定义主题色 × 未知终端底色」可能对比不足
 * （典型：深色主题的浅灰正文落到白底上）。这里提供标准的 WCAG 2.x 相对亮度与
 * 对比度计算，以及把颜色朝黑/白推到达标的最小改动版本，供主题加载时做可读性兜底。
 */

/** sRGB 8bit 通道 → 线性光。 */
function linearize(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度（0 = 黑，1 = 白）。 */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

/** 两个 RGB 颜色之间的 WCAG 对比度（1 ~ 21）。 */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 两个 hex 颜色之间的 WCAG 对比度；非法输入返回 1（不影响调用方判定）。 */
export function hexContrastRatio(first: string, second: string): number {
  const a = parseHex(first);
  const b = parseHex(second);
  if (!a || !b) return 1;
  return contrastRatio(a, b);
}

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/**
 * 让前景色在指定背景上达到最小对比度：朝纯黑或纯白混合，取达标所需的最小比例。
 *
 * - 已达标时原样返回（内置主题不受影响）；
 * - 背景偏亮时向黑推、背景偏暗时向白推，保证一定可达 21:1；
 * - 二分 20 次，结果与输入在同一色相方向，仅改变明度取向。
 */
export function ensureContrast(hex: string, against: string, minRatio: number): string {
  const base = parseHex(hex);
  const background = parseHex(against);
  if (!base || !background) return hex;

  const target = relativeLuminance(background) > 0.18 ? BLACK : WHITE;
  if (contrastRatio(base, background) >= minRatio) return hex;

  // 比较时用最终会输出的 8bit 值（formatHex 会四舍五入），否则可能收敛到
  // 临界值而输出时又差一点点，对对比度刚好不达标。
  const passes = (amount: number): boolean => {
    const candidate = parseHex(formatHex(blend(base, target, amount)));
    return candidate !== undefined && contrastRatio(candidate, background) >= minRatio;
  };

  let low = 0;
  let high = 1;
  for (let step = 0; step < 20; step += 1) {
    const middle = (low + high) / 2;
    if (passes(middle)) high = middle;
    else low = middle;
  }
  if (passes(high)) return formatHex(blend(base, target, high));
  // 理论上纯黑/纯白总能达标（21:1）；保留一个确定可达的兵底。
  return formatHex(target);
}
