/**
 * Kero 2.1.13 设计令牌（design tokens）——从 Kero 源码逐值提取。
 *
 * 来源：github.com/egoist/kero @ 55e41ee（MIT）+ github.com/egoist/mygo @ 818f07e（MIT）。
 * 提取自 design/kero/reference/theme.go（应用调色板、终端主题、背景渐变）与
 * hosts_color.go（主机色）。许可证文件见 reference/LICENSE-kero、LICENSE-mygo。
 *
 * 用法：直接 import 本模块，把 keroDark / keroLight 喂给 theme.ts 的 Theme
 * 结构（字段已按 haji 的 Theme 接口映射，见 design/kero/README.md 的映射表）；
 * 或把字段抄进 ~/.haji/theme.json / .haji/theme.json 做项目级主题。
 */

/** haji Theme 结构的 Kero 深色映射（darkPalette + darkTermTheme 合成）。 */
export const keroDark = {
	/** 深色卡片底（Kero 终端面板的 card）。想要 rex 洗墙底可用 "#17141f"。 */
	background: "#232328",
	/** 用户消息卡片底 = card 上叠 chip rgba(255,255,255,0.07)（35·0.93+255·0.07≈50）。 */
	userMsgBg: "#323237",
	/** darkTermTheme 前景。 */
	foreground: "#e6e6ea",
	/** darkPalette.accent。 */
	accent: "#6b93ff",
	/** darkPalette.textMuted（项目头、时间）。 */
	muted: "#a9a9b4",
	// 语义色 = darkTermTheme 的 ANSI 1..6
	red: "#ff6b64",
	green: "#4fd17a",
	yellow: "#f2c14e",
	blue: "#6b9bff",
	magenta: "#d07cf0",
	cyan: "#4cc9e0",
	// 亮色变体 = darkTermTheme 的 ANSI 9,10,11,14
	brightGreen: "#74e397",
	brightYellow: "#ffd479",
	brightBlue: "#8fb3ff",
	brightCyan: "#7fdcec",
} as const;

/** haji Theme 结构的 Kero 浅色映射（lightPalette + lightTermTheme 合成）。 */
export const keroLight = {
	/** 浅色卡片底。想要 rex 洗墙底可用 "#ebe0f3"。 */
	background: "#ffffff",
	/** = #ffffff 上叠 chip rgba(0,0,0,0.045)（255·0.955≈244）。 */
	userMsgBg: "#f4f4f4",
	/** lightTermTheme 前景。 */
	foreground: "#1d1d1f",
	/** lightPalette.accent。 */
	accent: "#3b6cf6",
	/** lightPalette.textMuted。 */
	muted: "#6e6e78",
	red: "#d3302f",
	green: "#22863a",
	yellow: "#b08800",
	blue: "#2f5bd8",
	magenta: "#a033c4",
	cyan: "#0f8199",
	brightGreen: "#2fa84f",
	brightYellow: "#d4a017",
	brightBlue: "#3b82f6",
	brightCyan: "#14a3bf",
} as const;

/** Kero 内置终端主题（"kero"）的完整 ANSI 16 色，注释原文："Apple's system colors, a little deeper in the light." */
export const keroTermPalette = {
	dark: [
		"#3a3a40", "#ff6b64", "#4fd17a", "#f2c14e", "#6b9bff", "#d07cf0", "#4cc9e0", "#c9c9cf",
		"#6c6c78", "#ff8a84", "#74e397", "#ffd479", "#8fb3ff", "#e09cf7", "#7fdcec", "#f5f5f7",
	],
	light: [
		"#1d1d1f", "#d3302f", "#22863a", "#b08800", "#2f5bd8", "#a033c4", "#0f8199", "#8e8e93",
		"#5f5f66", "#ef4444", "#2fa84f", "#d4a017", "#3b82f6", "#c04ee0", "#14a3bf", "#b4b4bb",
	],
	/** 选区/光标辅助色。 */
	darkSelection: "#2f4170",
	lightSelection: "#cfdcfb",
} as const;

/** Kero 五个窗口背景（washTable）：180° 主体渐变 + 225° 辉光，Oklab 插值（haji 的 oklab.hexGradient 同款色彩科学）。 */
export const keroWashes = {
	rex: {
		/** UI 显示名是 "Petal"（旧名 petal 有迁移）。注释原文：粉薰衣草在上、玫瑰右上、奶油黄在下。 */
		light: ["#ebe0f3", "#f3e7f1", "#f7eee4", "#f6efcf"],
		lightGlow: "rgba(247,220,241,0.75)",
		dark: ["#17141f", "#191620", "#1b1916"],
		darkGlow: "rgba(120,70,120,0.22)",
	},
	mist: {
		light: ["#e3e9f4", "#ebeff6", "#f1f2f3", "#f2f1ec"],
		lightGlow: "rgba(210,225,248,0.75)",
		dark: ["#12151b", "#14171d", "#17181b"],
		darkGlow: "rgba(70,100,150,0.22)",
	},
	meadow: {
		light: ["#e2eee5", "#ebf2e7", "#f3f2e2", "#f5f0d6"],
		lightGlow: "rgba(214,240,222,0.75)",
		dark: ["#111814", "#141a16", "#181a14"],
		darkGlow: "rgba(70,130,95,0.2)",
	},
	dusk: {
		light: ["#e4dbf3", "#efdeee", "#f6e3dc", "#f7e6cf"],
		lightGlow: "rgba(246,206,222,0.8)",
		dark: ["#191321", "#1e161e", "#221a17"],
		darkGlow: "rgba(150,80,110,0.25)",
	},
	plain: {
		light: ["#eceef4", "#eceef4"],
		lightGlow: "rgba(0,0,0,0)",
		dark: ["#141418", "#141418"],
		darkGlow: "rgba(0,0,0,0)",
	},
} as const;

/** 主机标签色（侧栏区分不同主机）：8 色相 × 浅/深两档。auto 规则 = FNV-1a(小写主机名) % 8。 */
export const keroHostColors = {
	red: ["#d9453b", "#ff7a70"],
	orange: ["#dc6a1f", "#ff9d5c"],
	amber: ["#b8860b", "#f2c14e"],
	green: ["#3a8f47", "#6fd27c"],
	teal: ["#13897b", "#4fd1c0"],
	blue: ["#3b6cf6", "#7b9fff"],
	purple: ["#8257e6", "#b493ff"],
	pink: ["#cf4c7c", "#f58fb5"],
} as const;

/** 语义状态色（浅/深）：attention="needs you"（agent 要你批准）、done、danger。 */
export const keroSemantic = {
	light: {
		attention: "#c27b0f",
		attentionSoft: "rgba(232,154,40,0.13)",
		done: "#1d1d1f",
		onDone: "#ffffff",
		danger: "#d93a35",
		overlay: "rgba(10,10,30,0.12)",
	},
	dark: {
		attention: "#f0a33a",
		attentionSoft: "rgba(240,163,58,0.15)",
		done: "#ececf0",
		onDone: "#161618",
		danger: "#ff6961",
		overlay: "rgba(0,0,0,0.35)",
	},
} as const;

/** 完整应用调色板见 reference/theme.go（30+ 语义字段全带设计注释）。 */
