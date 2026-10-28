import { bgSeq, getThemeAppearance, getThemePreset, themeReset } from "./theme.js";

/** 纸间侧栏的纸面色。256/16 色终端由 bgSeq 统一降级，不影响其它主题。 */
export function paperSidebarEnabled(): boolean {
  return getThemePreset() === "paper";
}

export function paperSidebarBg(): string {
  return bgSeq(getThemeAppearance() === "light" ? "#e9e6dc" : "#292923");
}

/** 当前工作的表面比纸面略深一级；不引入新的语义色。 */
export function paperWorkBg(): string {
  return bgSeq(getThemeAppearance() === "light" ? "#e3e0d4" : "#333129");
}

/** 可点击行的悬停表面；低对比度模式仍保留箭头与加粗反馈。 */
export function paperHoverBg(): string {
  return bgSeq(getThemeAppearance() === "light" ? "#d9d6c9" : "#3d3a2f");
}

export function paperSidebarSpace(width: number, background = paperSidebarBg()): string {
  return `${background}${" ".repeat(Math.max(0, width))}${themeReset()}`;
}
