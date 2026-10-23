import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  appearanceFromBackgroundColor,
  detectAppearanceFromEnv,
  detectTerminalAppearance,
  parseOsc11Reply,
} from "../dist/terminal-appearance.js";
import {
  bgSeq,
  fgSeq,
  getTheme,
  resetActiveColorLevel,
  resetActiveTheme,
  resetThemeAppearance,
  setActiveColorLevel,
  setThemeAppearance,
  themeBg,
  themeReset,
} from "../dist/theme.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ST = `${ESC}\\`;

setActiveColorLevel("truecolor");
resetThemeAppearance();

/** 构造一个可注入的伪 stdin：记录 raw mode 与写入的查询。 */
function fakeInput() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.resume = () => input;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
    input.rawHistory.push(mode);
    return input;
  };
  input.rawHistory = [];
  return input;
}

test("terminal appearance follows the reported background luminance", () => {
  assert.equal(appearanceFromBackgroundColor([1, 1, 1]), "light");
  assert.equal(appearanceFromBackgroundColor([0, 0, 0]), "dark");
  assert.equal(appearanceFromBackgroundColor([0.94, 0.94, 0.94]), "light");
});

test("OSC 11 replies are parsed for both BEL and ST terminators", () => {
  assert.equal(parseOsc11Reply(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`), "light");
  assert.equal(parseOsc11Reply(`${ESC}]11;rgb:1e1e/1e1e/1e1e${ST}`), "dark");
  assert.equal(parseOsc11Reply(`${ESC}]11;rgb:00/00/00${BEL}`), "dark");
  assert.equal(parseOsc11Reply("no reply here"), undefined);
});

test("environment overrides win over querying the terminal", () => {
  assert.equal(detectAppearanceFromEnv({ HAJI_THEME_APPEARANCE: "Light" }), "light");
  assert.equal(detectAppearanceFromEnv({ COLORFGBG: "0;15" }), "light");
  assert.equal(detectAppearanceFromEnv({ COLORFGBG: "15;0" }), "dark");
  assert.equal(detectAppearanceFromEnv({}), undefined);
});

test("detection writes OSC 11 once, restores raw mode, and returns the reply", async () => {
  const input = fakeInput();
  const written = [];
  const pending = detectTerminalAppearance({
    input,
    output: { isTTY: true, write: (chunk) => written.push(chunk) },
    env: {},
    timeoutMs: 500,
  });

  assert.equal(written[0], `${ESC}]11;?${BEL}`);
  assert.equal(input.isRaw, true);
  input.emit("data", Buffer.from(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`));

  assert.equal(await pending, "light");
  assert.equal(input.isRaw, false);
  assert.equal(input.rawHistory.at(-1), false);
});

test("detection falls back to dark on timeout and on non-TTY input", async () => {
  const input = fakeInput();
  const started = Date.now();
  const appearance = await detectTerminalAppearance({
    input,
    output: { isTTY: true, write: () => {} },
    env: {},
    timeoutMs: 30,
  });
  assert.equal(appearance, "dark");
  assert.ok(Date.now() - started < 1_000);
  assert.equal(input.isRaw, false);

  assert.equal(
    await detectTerminalAppearance({ input: { isTTY: false }, output: { isTTY: false }, env: {} }),
    "dark",
  );
});

test("background defaults to the terminal default colour, not a painted hex", () => {
  resetThemeAppearance();
  resetActiveTheme();
  assert.equal(getTheme().background, "");
  assert.equal(bgSeq(""), `${ESC}[49m`);
  assert.equal(themeBg(), `${ESC}[49m`);
  assert.equal(themeReset(), `${ESC}[0m${fgSeq(getTheme().foreground)}${ESC}[49m`);
});

test("switching appearance swaps the palette but keeps the terminal background", () => {
  resetThemeAppearance();
  const darkForeground = getTheme().foreground;
  assert.equal(setThemeAppearance("light"), true);
  const light = getTheme();
  assert.notEqual(light.foreground, darkForeground);
  assert.equal(light.background, "");
  assert.equal(bgSeq(light.background), `${ESC}[49m`);

  assert.equal(setThemeAppearance("light"), false, "no-op when appearance is unchanged");

  resetThemeAppearance();
  resetActiveColorLevel();
});
