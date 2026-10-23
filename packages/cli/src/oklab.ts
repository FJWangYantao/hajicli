/**
 * Oklab / Oklch 色彩空间工具。
 *
 * 在 sRGB 中直接做两色插值会让中间色发灰、发暗（例如紫→青会穿过脏灰），
 * 因为 sRGB 的通道数值与人眼感知亮度不成比例。Oklab 是感知均匀空间：
 * 在 Oklab 里线性插值，亮度与彩度按人眼感受均匀变化，渐变过渡自然。
 * 终端像素 Logo、状态色渐变、主题派生色都受益于此。
 */

export type Rgb = readonly [number, number, number];
export interface Oklab {
  /** 感知亮度，0 为黑，1 为白。 */
  l: number;
  /** 绿-红轴。 */
  a: number;
  /** 蓝-黄轴。 */
  b: number;
}

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 解析 #RRGGBB；非法输入返回 undefined。 */
export function parseHex(hex: string): Rgb | undefined {
  if (!HEX_PATTERN.test(hex)) return undefined;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** 格式化为小写 #rrggbb（各通道截断到 0..255）。 */
export function formatHex(rgb: Rgb): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/** sRGB 8bit 通道 → 线性光。 */
function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** 线性光 → sRGB 8bit 通道（含 gamma 编码与裁剪）。 */
function fromLinear(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return encoded * 255;
}

/** sRGB → Oklab。 */
export function rgbToOklab(rgb: Rgb): Oklab {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Oklab → sRGB（越界值被裁剪回 0..255）。 */
export function oklabToRgb(lab: Oklab): Rgb {
  const l = (lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const m = (lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const s = (lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return [fromLinear(r), fromLinear(g), fromLinear(b)];
}

/** 在 Oklab 空间按 t∈[0,1] 线性插值两个 hex 颜色。 */
export function mixHexOklab(from: string, to: string, t: number): string {
  const fromRgb = parseHex(from);
  const toRgb = parseHex(to);
  if (!fromRgb || !toRgb) return fromRgb ? from : to;

  const amount = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const start = rgbToOklab(fromRgb);
  const end = rgbToOklab(toRgb);
  return formatHex(
    oklabToRgb({
      l: start.l + (end.l - start.l) * amount,
      a: start.a + (end.a - start.a) * amount,
      b: start.b + (end.b - start.b) * amount,
    }),
  );
}

/**
 * 生成 count 段渐变（含两端）。count<=1 时只返回起点色。
 * 用于逐行/逐列的像素 Logo 着色、进度条、渐变分隔线。
 */
export function hexGradient(from: string, to: string, count: number): string[] {
  const total = Math.max(1, Math.trunc(count));
  if (total === 1) return [from];
  return Array.from({ length: total }, (_, index) => mixHexOklab(from, to, index / (total - 1)));
}
