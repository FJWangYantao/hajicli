import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * TUI 主题模块。
 *
 * haji 的终端界面使用本模块定义的主题，并按终端能力降级为 truecolor、
 * 256 色、16 色或无色输出。所有 SGR 重置点统一使用 {@link themeReset}
 * （有色模式下重置后立即恢复主题前景与背景），保证渲染过程中主题背景
 * 属性不被清除。
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

/** 终端颜色能力，从完全无色到 24-bit 真彩色。 */
export type ColorLevel = 'mono' | 'ansi16' | 'ansi256' | 'truecolor';

/**
 * 纯函数检测终端颜色能力。显式的无色请求（非 TTY / NO_COLOR / TERM=dumb）
 * 优先于任何终端能力标记。win32 一律按 truecolor 处理（详见下方分支），
 * 其余平台依据 WT_SESSION/COLORTERM/TERM 等环境变量推断。
 */
export function detectColorLevel(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
  _platform?: NodeJS.Platform
): ColorLevel {
  if (!isTTY || Object.prototype.hasOwnProperty.call(env, 'NO_COLOR')) return 'mono';
  if (env.TERM?.toLowerCase() === 'dumb') return 'mono';

  const colorTerm = env.COLORTERM?.toLowerCase();
  // win32 一律按 truecolor 处理：现代 Windows 控制台支持 24-bit VT，但
  // shells/launchers 不总是保留 WT_SESSION/COLORTERM；若回退 ANSI 16，深色
  // 主题背景会被映射到终端配色里的 "black"，往往比预期亮得多。老 conhost
  // 不解析 24-bit SGR 时会自行量化/降级渲染，乱码风险不高于既有 ANSI 16 回退。
  if (_platform === 'win32' || env.WT_SESSION || colorTerm === 'truecolor' || colorTerm === '24bit') {
    return 'truecolor';
  }
  if (env.TERM?.toLowerCase().includes('256color') || colorTerm?.includes('256color')) {
    return 'ansi256';
  }
  return 'ansi16';
}

let activeColorLevel: ColorLevel | undefined;

/** 获取当前颜色能力；首次访问时根据进程环境检测。 */
export function getColorLevel(): ColorLevel {
  if (!activeColorLevel) {
    activeColorLevel = detectColorLevel(process.env, Boolean(process.stdout.isTTY), process.platform);
  }
  return activeColorLevel;
}

/** 显式注入颜色能力，主要用于测试。 */
export function setActiveColorLevel(level: ColorLevel): void {
  activeColorLevel = level;
}

/** 清除颜色能力注入，下次访问时重新检测。 */
export function resetActiveColorLevel(): void {
  activeColorLevel = undefined;
}

/** 与主题注入命名兼容的简写别名。 */
export const setColorLevel = setActiveColorLevel;
export const resetColorLevel = resetActiveColorLevel;

/** 内置默认主题：HAJI 轨迹台，低干扰深色表面 + 克制紫色强调。 */
const DEFAULT_THEME: Theme = {
  background: '#101318',
  userMsgBg: '#171b22',
  foreground: '#d9dee7',
  accent: '#a995d6',
  muted: '#8f98a5',
  red: '#e07a7a',
  green: '#78b892',
  yellow: '#d6a85f',
  blue: '#82aadd',
  magenta: '#b8a1df',
  cyan: '#7dcfff',
  brightGreen: '#91c7a6',
  brightYellow: '#e2bb78',
  brightBlue: '#9ab8e6',
  brightCyan: '#9edcff'
};

/** Theme 接口的所有合法键，用于配置合并时过滤未知字段。 */
const THEME_KEYS = Object.keys(DEFAULT_THEME) as readonly (keyof Theme)[];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const ANSI16_PALETTE: readonly [number, number, number][] = [
  [0x00, 0x00, 0x00],
  [0x80, 0x00, 0x00],
  [0x00, 0x80, 0x00],
  [0x80, 0x80, 0x00],
  [0x00, 0x00, 0x80],
  [0x80, 0x00, 0x80],
  [0x00, 0x80, 0x80],
  [0xc0, 0xc0, 0xc0],
  [0x80, 0x80, 0x80],
  [0xff, 0x00, 0x00],
  [0x00, 0xff, 0x00],
  [0xff, 0xff, 0x00],
  [0x00, 0x00, 0xff],
  [0xff, 0x00, 0xff],
  [0x00, 0xff, 0xff],
  [0xff, 0xff, 0xff]
];

/** 将 #RRGGBB 解析为 [r, g, b]；非法时返回 undefined。 */
function hexToRgb(hex: string): [number, number, number] | undefined {
  if (!HEX_RE.test(hex)) return undefined;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.min(23, Math.round((r - 8) / 10));
  }
  const red = Math.round((r / 255) * 5);
  const green = Math.round((g / 255) * 5);
  const blue = Math.round((b / 255) * 5);
  return 16 + (36 * red) + (6 * green) + blue;
}

function rgbToAnsi16(r: number, g: number, b: number): number {
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ANSI16_PALETTE.length; index += 1) {
    const [pr, pg, pb] = ANSI16_PALETTE[index];
    const distance = ((r - pr) ** 2) + ((g - pg) ** 2) + ((b - pb) ** 2);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function ansi16Code(index: number, background: boolean): number {
  if (index < 8) return (background ? 40 : 30) + index;
  return (background ? 100 : 90) + (index - 8);
}

/** 按当前颜色能力生成前景色 SGR；无色模式返回空串。 */
export function fgSeq(hex: string): string {
  const level = getColorLevel();
  if (level === 'mono') return '';
  const rgb = hexToRgb(hex);
  if (!rgb) return '\x1b[39m';
  if (level === 'truecolor') return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (level === 'ansi256') return `\x1b[38;5;${rgbToAnsi256(...rgb)}m`;
  return `\x1b[${ansi16Code(rgbToAnsi16(...rgb), false)}m`;
}

/** 按当前颜色能力生成背景色 SGR；无色模式返回空串。 */
export function bgSeq(hex: string): string {
  const level = getColorLevel();
  if (level === 'mono') return '';
  const rgb = hexToRgb(hex);
  if (!rgb) return '\x1b[49m';
  if (level === 'truecolor') return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (level === 'ansi256') return `\x1b[48;5;${rgbToAnsi256(...rgb)}m`;
  return `\x1b[${ansi16Code(rgbToAnsi16(...rgb), true)}m`;
}

/** 粗体 SGR 序列。 */
const BOLD = '\x1b[1m';

function styleSeq(sequence: string): string {
  return getColorLevel() === 'mono' ? '' : sequence;
}

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
  if (getColorLevel() === 'mono') return '';
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
  if (getColorLevel() === 'mono') return '';
  const theme = getTheme();
  return `\x1b[0m${fgSeq(theme.foreground)}${bgSeq(theme.background)}`;
}

/** 主题退出序列：恢复终端默认前景与背景。 */
export function themeExit(): string {
  return getColorLevel() === 'mono' ? '' : '\x1b[0m';
}

function paintText(text: string, color: string, bold = false): string {
  if (getColorLevel() === 'mono') return text;
  return `${bold ? BOLD : ''}${fgSeq(color)}${text}${themeReset()}`;
}

/**
 * 主题化颜色工具集，与 index.ts 历史的 `colors` 对象形态兼容，
 * 便于直接替换。所有方法均在收尾调用 {@link themeReset} 恢复主题背景。
 */
export const paint = {
  accent: (text: string): string => paintText(text, getTheme().accent),
  boldAccent: (text: string): string => paintText(text, getTheme().accent, true),
  green: (text: string): string => paintText(text, getTheme().green),
  boldGreen: (text: string): string => paintText(text, getTheme().green, true),
  yellow: (text: string): string => paintText(text, getTheme().yellow),
  boldYellow: (text: string): string => paintText(text, getTheme().yellow, true),
  red: (text: string): string => paintText(text, getTheme().red),
  boldRed: (text: string): string => paintText(text, getTheme().red, true),
  blue: (text: string): string => paintText(text, getTheme().blue),
  boldBlue: (text: string): string => paintText(text, getTheme().blue, true),
  muted: (text: string): string => paintText(text, getTheme().muted),
  cyan: (text: string): string => paintText(text, getTheme().cyan),
  bold: (text: string): string => getColorLevel() === 'mono' ? text : `${BOLD}${text}${themeReset()}`,
  userMsg: (text: string): string => {
    const lines = text.split('\n');
    if (getColorLevel() === 'mono') {
      return lines.map((line, idx) => idx === 0 ? ` ❯ ${line}` : `   ${line}`).join('\n');
    }
    const theme = getTheme();
    const accent = fgSeq(theme.accent);
    const bg = bgSeq(theme.userMsgBg);
    // 整行背景填充：每行前置 bg，行尾用激活背景的 \x1b[K 清到行尾实现整行填满。
    // 首行用 accent 色 ❯ 前缀，续行用 3 空格缩进对齐 "❯ "。
    // 每行用 themeReset() 收尾，避免背景泄漏到后续渲染（wrapAnsi 跨行时会保留 bg 作为 activeStyle）。
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
  if (!bg) return row;
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
  const enabled = getColorLevel() !== 'mono';
  return {
    reset: themeReset(),
    bold: styleSeq(BOLD),
    dim: enabled ? '\x1b[2m' : '',
    italic: enabled ? '\x1b[3m' : '',
    underline: enabled ? '\x1b[4m' : '',
    strikethrough: enabled ? '\x1b[9m' : '',
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
