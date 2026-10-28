import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  persistThemeAppearance,
  persistThemePreset,
  readThemeAppearance,
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

/** 隔离 HOME/USERPROFILE 执行回调，避免测试碰到真实 ~/.haji/theme.json。 */
async function withIsolatedHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "haji-appearance-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("persisted appearance survives restarts and shares theme.json with the preset", async () => {
  await withIsolatedHome(async (home) => {
    assert.equal(readThemeAppearance(), undefined, "默认没有记住任何外观");

    persistThemeAppearance("light");
    assert.equal(readThemeAppearance(), "light");

    // 与 /theme 写的 preset 共用同一个文件，互不覆盖。
    persistThemePreset("kero");
    assert.equal(readThemeAppearance(), "light");
    const saved = JSON.parse(fs.readFileSync(path.join(home, ".haji", "theme.json"), "utf8"));
    assert.deepEqual(saved, { appearance: "light", preset: "kero" });
  });
});

test("a persisted appearance skips probing the terminal entirely", async () => {
  const input = fakeInput();
  const written = [];
  const appearance = await detectTerminalAppearance({
    input,
    output: { isTTY: true, write: (chunk) => written.push(chunk) },
    env: {},
    preferred: "light",
    timeoutMs: 500,
  });

  // 白底终端里 OSC 11 可能没人回话：有 persisted 值就不该发查询、更不该回退 dark。
  assert.equal(appearance, "light");
  assert.deepEqual(written, []);
  assert.equal(input.rawHistory.length, 0);

  // 环境变量仍是最高优先级的一次性覆盖。
  assert.equal(
    await detectTerminalAppearance({ preferred: "light", env: { HAJI_THEME_APPEARANCE: "dark" } }),
    "dark",
  );
});
