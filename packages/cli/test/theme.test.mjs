import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { hexContrastRatio } from "../dist/contrast.js";
import { buildAgentPanelRows } from "../dist/terminal-input.js";
import { buildStatusBarRow } from "../dist/terminal-panels.js";
import {
  bgSeq,
  buildAnsiStyles,
  detectColorLevel,
  diffToneBg,
  faintHex,
  fgSeq,
  getColorLevel,
  getTheme,
  getThemePreset,
  listThemePresets,
  paint,
  resetActiveColorLevel,
  resetActiveTheme,
  resetThemeAppearance,
  resetThemePreset,
  setActiveColorLevel,
  setActiveTheme,
  setColorLevel,
  setThemeAppearance,
  setThemePreset,
  softAccentHex,
  THEME_PRESET_NAMES,
  themeBg,
  themeEnter,
  themeExit,
  themeFg,
  themeReset,
} from "../dist/theme.js";

const FIXED_THEME = {
  background: "#000000",
  userMsgBg: "#202020",
  userMsgFg: "#f2f2f2",
  foreground: "#ffffff",
  accent: "#ff00ff",
  muted: "#808080",
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
  blue: "#0000ff",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  brightGreen: "#00ff00",
  brightYellow: "#ffff00",
  brightBlue: "#0000ff",
  brightCyan: "#00ffff",
};

afterEach(() => {
  resetActiveColorLevel();
  resetActiveTheme();
  setThemePreset("default");
  resetThemeAppearance();
});

test("detectColorLevel honors explicit mono conditions before color capabilities", () => {
  assert.equal(detectColorLevel({ WT_SESSION: "1" }, false, "win32"), "mono");
  assert.equal(detectColorLevel({ NO_COLOR: "", WT_SESSION: "1" }, true, "win32"), "mono");
  assert.equal(detectColorLevel({ TERM: "DuMb", COLORTERM: "truecolor" }, true, "linux"), "mono");
  assert.equal(detectColorLevel({ TERM: "dumb" }, true, "win32"), "mono");
});

test("detectColorLevel detects truecolor, 256 color and ordinary TTY levels", () => {
  assert.equal(detectColorLevel({}, true, "win32"), "truecolor");
  assert.equal(detectColorLevel({ WT_SESSION: "1" }, true, "win32"), "truecolor");
  assert.equal(detectColorLevel({ COLORTERM: "TRUECOLOR" }, true, "linux"), "truecolor");
  assert.equal(detectColorLevel({ COLORTERM: "24bit" }, true, "linux"), "truecolor");
  assert.equal(detectColorLevel({ TERM: "xterm-256color" }, true, "linux"), "ansi256");
  assert.equal(detectColorLevel({ TERM: "xterm" }, true, "linux"), "ansi16");
});

test("truecolor sequences preserve exact RGB values", () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel("truecolor");

  assert.equal(fgSeq("#123456"), "\x1b[38;2;18;52;86m");
  assert.equal(bgSeq("#123456"), "\x1b[48;2;18;52;86m");
  assert.match(themeEnter(), /^\x1b\[0m\x1b\[38;2;/);
  assert.match(themeReset(), /^\x1b\[0m\x1b\[38;2;/);
});

test("ansi256 sequences map RGB values to the xterm palette", () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel("ansi256");

  assert.equal(fgSeq("#ff0000"), "\x1b[38;5;196m");
  assert.equal(bgSeq("#000000"), "\x1b[48;5;16m");
  assert.equal(fgSeq("#f8f8f8"), "\x1b[38;5;231m");
  // 近中性灰走 24 级灰阶，不进色立方（否则 #aab3c0 会量化成 175,215,215 的青灰）
  assert.equal(fgSeq("#aab3c0"), "\x1b[38;5;249m");
  assert.equal(fgSeq("#d9dee7"), "\x1b[38;5;253m");
  assert.match(paint.accent("HAJI"), /^\x1b\[38;5;201mHAJI/);
});

test("ansi256 keeps hue and chroma instead of rounding each channel into the cube", () => {
  setActiveColorLevel("ansi256");

  // 浅色板的绿不能量化成青灰（逐通道取整给 66 = 95,135,135），洋红不能变粉。
  assert.equal(fgSeq("#1d7a4d"), "\x1b[38;5;29m");
  assert.equal(fgSeq("#8a3aa5"), "\x1b[38;5;91m");
  // 深色板的蓝与强调紫不能再撞成同一格（旧实现都是 146）。
  assert.equal(fgSeq("#82aadd"), "\x1b[38;5;110m");
  assert.equal(fgSeq("#a995d6"), "\x1b[38;5;140m");
});

test("ansi256 diff tints stay inside their semantic hue family", () => {
  setActiveColorLevel("ansi256");

  setThemeAppearance("light");
  // 浅底：淡红/淡绿，而不是两边都被压回灰阶（254/255）。
  assert.equal(diffToneBg("red"), "\x1b[48;5;224m");
  // 浅色板绿的色相夹在色块的绿与青之间，色条必须留在绿区而不是淡青。
  assert.equal(diffToneBg("green"), "\x1b[48;5;194m");

  setThemeAppearance("dark");
  assert.equal(diffToneBg("red"), "\x1b[48;5;52m");
  assert.equal(diffToneBg("green"), "\x1b[48;5;22m");
});

test("ansi16 sequences use standard and bright SGR colors", () => {
  setActiveTheme(FIXED_THEME);
  setColorLevel("ansi16");

  assert.equal(getColorLevel(), "ansi16");
  assert.equal(fgSeq("#ff0000"), "\x1b[91m");
  assert.equal(bgSeq("#000000"), "\x1b[40m");
  assert.match(paint.boldAccent("HAJI"), /^\x1b\[1m\x1b\[95mHAJI/);
});

test("ansi16 degradation buckets by hue so semantic colors survive pastel themes", () => {
  setActiveTheme(FIXED_THEME);
  setColorLevel("ansi16");

  // 低饱和粉彩不能被吸到灰阶——diff 的红删绿增在 16 色终端里必须还能分开。
  assert.equal(fgSeq("#e07a7a"), "\x1b[91m"); // 主题红（粉彩）→ 红系
  assert.equal(fgSeq("#78b892"), "\x1b[92m"); // 主题绿（粉彩）→ 绿系
  assert.equal(fgSeq("#7dcfff"), "\x1b[96m"); // 天青（hue≈202）→ 青系而非蓝系
  assert.equal(fgSeq("#82aadd"), "\x1b[94m"); // 主题蓝（hue≈214）→ 蓝系
  // 近中性走灰阶，亮度决定档位。
  assert.equal(fgSeq("#141414"), "\x1b[30m");
  assert.equal(fgSeq("#6a7480"), "\x1b[90m");
  assert.equal(fgSeq("#c8ced6"), "\x1b[37m");
  assert.equal(fgSeq("#f2f5f8"), "\x1b[97m");
});

test("mono mode removes ANSI while preserving readable user prefixes", () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel("mono");

  assert.equal(fgSeq("#ff0000"), "");
  assert.equal(bgSeq("#000000"), "");
  assert.equal(themeFg(), "");
  assert.equal(themeBg(), "");
  assert.equal(themeEnter(), "");
  assert.equal(themeReset(), "");
  assert.equal(themeExit(), "");
  assert.equal(paint.boldAccent("HAJI"), "HAJI");
  assert.equal(paint.userMsg("第一行\n第二行"), " ❯ 第一行\n   第二行");

  const styles = buildAnsiStyles();
  assert.ok(Object.values(styles).every((value) => value === ""));
});

test("sent user messages use their own foreground and bold body text", () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel("truecolor");

  const output = paint.userMsg("第一行\n第二行");
  const userText = `\x1b[1m${fgSeq(FIXED_THEME.userMsgFg)}`;
  assert.ok(output.includes(`${bgSeq(FIXED_THEME.userMsgBg)}${userText}第一行`));
  assert.ok(output.includes(`${bgSeq(FIXED_THEME.userMsgBg)}${userText}   第二行`));
});

test("terminal UI color sequences follow runtime color-level changes", () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel("truecolor");
  const item = {
    id: "agent-1",
    role: "reviewer",
    status: "running",
    startedAt: Date.now(),
    totalTokens: 0,
  };

  assert.match(buildAgentPanelRows([item], 80).join("\n"), /\x1b\[/u);
  setActiveColorLevel("mono");
  assert.doesNotMatch(buildAgentPanelRows([item], 80).join("\n"), /\x1b\[/u);
});

test("faint and soft accent tiers sit below their base color but stay readable", () => {
  const light = {
    ...FIXED_THEME,
    background: "#ffffff",
    foreground: "#242b36",
    muted: "#5b6472",
    accent: "#6b4fc4",
  };
  setActiveTheme(light);
  const faint = hexContrastRatio(faintHex(), "#ffffff");
  assert.ok(faint >= 3, `faint contrast ${faint}`);
  assert.ok(faint < hexContrastRatio(light.muted, "#ffffff"), "faint is lighter than muted");
  const soft = hexContrastRatio(softAccentHex(), "#ffffff");
  assert.ok(soft >= 3, `soft accent contrast ${soft}`);
  assert.ok(soft < hexContrastRatio(light.accent, "#ffffff"), "soft accent is lighter than accent");
});

test("status lines color only the icon, and the status bar keeps one accent", () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel("truecolor");
  const line = paint.okLine("done");
  assert.ok(line.startsWith(`\x1b[1m${fgSeq(FIXED_THEME.green)}✓`));
  assert.ok(line.endsWith(`${themeReset()} done`), "text after the icon keeps the theme color");

  const row = buildStatusBarRow(
    {
      permissionMode: "auto",
      usedTokens: 13_000,
      maxTokens: 1_000_000,
      modelName: "deepseek-v4.1-flash",
      providerName: "workbuddy",
      reasoningEffort: "medium",
      currentPath: "/tmp/project",
    },
    120,
  );
  assert.ok(row.includes(`${fgSeq(FIXED_THEME.accent)}[自动]`));
  assert.ok(row.includes(`${fgSeq(FIXED_THEME.muted)}workbuddy`));
  assert.ok(!row.includes(fgSeq(FIXED_THEME.cyan)), "no cyan left in the status bar");
});

test("theme presets resolve to distinct palettes under one appearance", () => {
  resetThemePreset();
  setActiveColorLevel("truecolor");
  setThemePreset("default");
  const defaultTheme = getTheme();
  setThemePreset("kero");
  const keroTheme = getTheme();
  assert.notEqual(defaultTheme.accent, keroTheme.accent);
  assert.notEqual(defaultTheme.foreground, keroTheme.foreground);
  assert.equal(getThemePreset(), "kero");
});

test("re-selecting the active preset reports no change", () => {
  resetThemePreset();
  setThemePreset("default");
  assert.equal(setThemePreset("default"), false);
  assert.equal(setThemePreset("kero"), true);
});

test("theme preset list exposes the registered presets", () => {
  const names = listThemePresets().map((preset) => preset.name);
  assert.deepEqual(names, [...THEME_PRESET_NAMES]);
  assert.ok(names.includes("default"));
  assert.ok(names.includes("kero"));
  assert.ok(names.includes("paper"));
});

test("paper preset matches the warm paper prototype in light appearance", () => {
  resetThemePreset();
  setActiveColorLevel("truecolor");
  setThemePreset("paper");
  setThemeAppearance("light");
  const theme = getTheme();
  assert.equal(theme.background, "#f5f3ee");
  assert.equal(theme.foreground, "#45433e");
  assert.equal(theme.accent, "#697750");
  assert.equal(theme.userMsgBg, "#ebe6dc");
});
