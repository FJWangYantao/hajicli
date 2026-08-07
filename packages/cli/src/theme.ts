import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * TUI 主题模块。
 *
 * haji 的终端界面不再跟随终端模拟器的主题：进入交互界面后，背景色、
 * 前景色与各类强调色都由本模块定义的 24-bit 真彩色主题控制，并通过
 * 配置文件覆盖。所有 SGR 重置点统一使用 {@link themeReset}（重置后立即
 * 恢复主题前景与背景），保证渲染过程中主题背景属性不被清除。
 *
 * 配置分两级（与 provider 配置一致）：
 *   - 用户级：~/.haji/theme.json      （跨项目共用）
 *   - 项目级：<cwd>/.haji/theme.json  （覆盖用户级同名字段）
 * 任一级缺失或字段非法时回退到内置默认主题。
 */

/** 主题颜色键：均为 #RRGGBB 格式的 hex 字符串。 */
export interface Theme {
  /** TUI 主背景色。 */
  background: string;
  /** 用户消息行的整行背景色（略亮于 background，形成色块卡片）。 */
  userMsgBg: string;
  /** 默认前景（正文）色。 */
  foreground: string;
  /** 主强调色（Logo、提示符、选中态等）。 */
  accent: string;
  /** 次要/弱化文本色（边框、注释、未激活项）。 */
  muted: string;
  /** 语义色：错误 / 警告 / 成功 / 信息。 */
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  /** 亮色变体，用于代码高亮等需要更高对比的场景。 */
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightCyan: string;
}

/** 内置默认主题：深色背景 + 紫色强调（GitHub Dark 风格调色）。 */
const DEFAULT_THEME: Theme = {
  background: '#0d1117',
  userMsgBg: '#1c2128',
  foreground: '#c9d1d9',
  accent: '#a371f7',
  muted: '#6e7681',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#f2cc60',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#6cb6ff',
  brightCyan: '#39c5cf'
};

/** Theme 接口的所有合法键，用于配置合并时过滤未知字段。 */
const THEME_KEYS = Object.keys(DEFAULT_THEME) as readonly (keyof Theme)[];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** 将 #RRGGBB 解析为 [r, g, b]；非法时返回 undefined。 */
function hexToRgb(hex: string): [number, number, number] | undefined {
  if (!HEX_RE.test(hex)) return undefined;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

/** 24-bit 前景色 SGR 序列。非法颜色回退到默认前景（39）。 */
export function fgSeq(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '\x1b[39m';
}

/** 24-bit 背景色 SGR 序列。非法颜色回退到默认背景（49）。 */
export function bgSeq(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgb ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '\x1b[49m';
}

/** 粗体 SGR 序列。 */
const BOLD = '\x1b[1m';

function userThemeConfigPath(): string {
  return path.join(os.homedir(), '.haji', 'theme.json');
}

function projectThemeConfigPath(): string {
  return path.join(process.cwd(), '.haji', 'theme.json');
}

/** 读取单个主题文件，仅保留合法 hex 字段；文件缺失/损坏返回空对象。 */
function readThemeFile(filePath: string): Partial<Theme> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const source = parsed as Record<string, unknown>;
    const result: Partial<Theme> = {};
    for (const key of THEME_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && HEX_RE.test(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 加载并合并主题：项目级覆盖用户级，再覆盖内置默认。
 * 始终返回一个完整的 Theme 对象（所有字段均有值）。
 */
export function loadTheme(): Theme {
  const merged: Theme = { ...DEFAULT_THEME };
  const user = readThemeFile(userThemeConfigPath());
  const project = readThemeFile(projectThemeConfigPath());
  for (const key of THEME_KEYS) {
    const override = project[key] ?? user[key];
    if (override) merged[key] = override;
  }
  return merged;
}

/** 当前激活主题（模块级单例，首次访问时加载一次）。 */
let activeTheme: Theme | undefined;

/**
 * 获取当前激活主题；尚未加载时自动加载一次。
 * 测试可通过 {@link setActiveTheme} 注入固定主题。
 */
export function getTheme(): Theme {
  if (!activeTheme) activeTheme = loadTheme();
  return activeTheme;
}

/** 显式设置激活主题（主要用于测试与未来运行时切换）。 */
export function setActiveTheme(theme: Theme): void {
  activeTheme = theme;
}

/** 重置激活主题，下次 {@link getTheme} 重新从配置加载。 */
export function resetActiveTheme(): void {
  activeTheme = undefined;
}

/**
 * 主题重置序列：先 `\x1b[0m` 清除全部 SGR 属性，再立即恢复主题前景与背景。
 * 用于所有颜色函数的收尾，保证渲染过程中主题背景属性不被清除。
 */
export function themeReset(): string {
  const theme = getTheme();
  return `\x1b[0m${fgSeq(theme.foreground)}${bgSeq(theme.background)}`;
}

/** 仅主题背景色序列（用于清行前注入，确保 `\x1b[2K` 清出主题背景）。 */
export function themeBg(): string {
  return bgSeq(getTheme().background);
}

/** 仅主题前景色序列。 */
export function themeFg(): string {
  return fgSeq(getTheme().foreground);
}

/** 主题进入序列：设置前景与背景（用于进入 alt screen 后填充整屏）。 */
export function themeEnter(): string {
  const theme = getTheme();
  return `\x1b[0m${fgSeq(theme.foreground)}${bgSeq(theme.background)}`;
}

/** 主题退出序列：恢复终端默认前景与背景。 */
export function themeExit(): string {
  return '\x1b[0m';
}

/**
 * 主题化颜色工具集，与 index.ts 历史的 `colors` 对象形态兼容，
 * 便于直接替换。所有方法均在收尾调用 {@link themeReset} 恢复主题背景。
 */
export const paint = {
  accent: (text: string): string => `${fgSeq(getTheme().accent)}${text}${themeReset()}`,
  boldAccent: (text: string): string => `${BOLD}${fgSeq(getTheme().accent)}${text}${themeReset()}`,
  green: (text: string): string => `${fgSeq(getTheme().green)}${text}${themeReset()}`,
  boldGreen: (text: string): string => `${BOLD}${fgSeq(getTheme().green)}${text}${themeReset()}`,
  yellow: (text: string): string => `${fgSeq(getTheme().yellow)}${text}${themeReset()}`,
  boldYellow: (text: string): string => `${BOLD}${fgSeq(getTheme().yellow)}${text}${themeReset()}`,
  red: (text: string): string => `${fgSeq(getTheme().red)}${text}${themeReset()}`,
  boldRed: (text: string): string => `${BOLD}${fgSeq(getTheme().red)}${text}${themeReset()}`,
  blue: (text: string): string => `${fgSeq(getTheme().blue)}${text}${themeReset()}`,
  boldBlue: (text: string): string => `${BOLD}${fgSeq(getTheme().blue)}${text}${themeReset()}`,
  muted: (text: string): string => `${fgSeq(getTheme().muted)}${text}${themeReset()}`,
  cyan: (text: string): string => `${fgSeq(getTheme().cyan)}${text}${themeReset()}`,
  bold: (text: string): string => `${BOLD}${text}${themeReset()}`,
  userMsg: (text: string): string => {
    const theme = getTheme();
    const accent = fgSeq(theme.accent);
    const bg = bgSeq(theme.userMsgBg);
    // 整行背景填充：每行前置 bg，行尾用激活背景的 \x1b[K 清到行尾实现整行填满。
    // 首行用 accent 色 ❯ 前缀，续行用 3 空格缩进对齐 "❯ "。
    // 每行用 themeReset() 收尾，避免背景泄漏到后续渲染（wrapAnsi 跨行时会保留 bg 作为 activeStyle）。
    const lines = text.split('\n');
    return lines.map((line, idx) =>
      idx === 0
        ? `${bg}${BOLD}${accent} ❯ ${themeReset()}${bg}${line}\x1b[K${themeReset()}`
        : `${bg}   ${line}\x1b[K${themeReset()}`
    ).join('\n');
  }
};

/**
 * 用户消息背景色 SGR（供渲染层识别用户消息行）。模块级缓存，主题不变时复用。
 */
let cachedUserMsgBgSeq = '';
function userMsgBgSeq(): string {
  const seq = bgSeq(getTheme().userMsgBg);
  if (!cachedUserMsgBgSeq || cachedUserMsgBgSeq !== seq) cachedUserMsgBgSeq = seq;
  return cachedUserMsgBgSeq;
}

/**
 * 渲染层后处理：若某 chat 行带用户消息背景色（说明是用户消息的某一行），
 * 但行尾缺少 `\x1b[K`（软换行的中间行），则在最后一个 SGR reset 前补一个，
 * 使整行右侧也被用户消息背景填满（实现完整的色块卡片）。
 *
 * 非 userMsg 行原样返回。已带 `\x1b[K` 的行不重复补。
 */
export function fillUserMsgRowEol(row: string): string {
  const bg = userMsgBgSeq();
  if (!row.includes(bg)) return row;
  if (row.includes('\x1b[K')) return row;
  const lastReset = row.lastIndexOf('\x1b[0m');
  if (lastReset === -1) return `${row}\x1b[K`;
  return `${row.slice(0, lastReset)}\x1b[K${row.slice(lastReset)}`;
}

/**
 * 构建一个 24-bit 真彩色的 ANSI 样式字典，结构与 markdown-renderer
 * 历史的 `ANSI` 字典一致，便于将其 16 色映射直接替换为主题前景色。
 * `reset` 使用 {@link themeReset} 以恢复主题背景。
 */
export function buildAnsiStyles(): {
  reset: string;
  bold: string;
  dim: string;
  italic: string;
  underline: string;
  strikethrough: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  gray: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightCyan: string;
} {
  const theme = getTheme();
  return {
    reset: themeReset(),
    bold: BOLD,
    dim: '\x1b[2m',
    italic: '\x1b[3m',
    underline: '\x1b[4m',
    strikethrough: '\x1b[9m',
    red: fgSeq(theme.red),
    green: fgSeq(theme.green),
    yellow: fgSeq(theme.yellow),
    blue: fgSeq(theme.blue),
    magenta: fgSeq(theme.magenta),
    cyan: fgSeq(theme.cyan),
    white: fgSeq(theme.foreground),
    gray: fgSeq(theme.muted),
    brightGreen: fgSeq(theme.brightGreen),
    brightYellow: fgSeq(theme.brightYellow),
    brightBlue: fgSeq(theme.brightBlue),
    brightCyan: fgSeq(theme.brightCyan)
  };
}
