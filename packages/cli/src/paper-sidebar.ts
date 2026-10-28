import { bgSeq, getTheme, getThemeAppearance, getThemePreset, themeReset } from "./theme.js";

/** 纸间侧栏的纸面色。256/16 色终端由 bgSeq 统一降级，不影响其它主题。 */
export function paperSidebarEnabled(): boolean {
  return getThemePreset() === "paper";
}

function paperSidebarColor(): string {
  return getThemeAppearance() === "light" ? "#eeece5" : "#292824";
}

export function paperSidebarBg(): string {
  return bgSeq(paperSidebarColor());
}

/** 用三列相邻纸色柔化聊天/输入区与侧栏的交界，宽度保持不变。 */
export function paperSidebarTransition(): string {
  const base = getTheme().background;
  const target = paperSidebarColor();
  const source = /^#[0-9a-f]{6}$/i.test(base) ? base : target;
  const steps = [0.25, 0.5, 0.75].map((ratio) => {
    const channels = [1, 3, 5].map((offset) => {
      const from = Number.parseInt(source.slice(offset, offset + 2), 16);
      const to = Number.parseInt(target.slice(offset, offset + 2), 16);
      return Math.round(from + (to - from) * ratio)
        .toString(16)
        .padStart(2, "0");
    });
    return `${bgSeq(`#${channels.join("")}`)} `;
  });
  return `${steps.join("")}${themeReset()}`;
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
