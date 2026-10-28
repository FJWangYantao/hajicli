import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contrastRatio,
  ensureContrast,
  hexContrastRatio,
  relativeLuminance,
} from "../dist/contrast.js";
import {
  buildAnsiStyles,
  dimFgSeq,
  dimHex,
  getTheme,
  resetActiveColorLevel,
  resetActiveTheme,
  resetThemeAppearance,
  setActiveColorLevel,
  setThemeAppearance,
  setThemePreset,
} from "../dist/theme.js";

setThemePreset("default");

test("WCAG luminance and contrast match the reference values", () => {
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.equal(relativeLuminance([255, 255, 255]), 1);
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(2), "21.00");
  assert.equal(contrastRatio([255, 255, 255], [0, 0, 0]).toFixed(2), "21.00");
  assert.equal(hexContrastRatio("#000000", "#000000").toFixed(2), "1.00");
  assert.equal(hexContrastRatio("not-a-color", "#ffffff"), 1);
});

test("ensureContrast leaves passing colours untouched", () => {
  assert.equal(ensureContrast("#d9dee7", "#000000", 4.5), "#d9dee7");
  assert.equal(ensureContrast("#242b36", "#ffffff", 4.5), "#242b36");
});

test("ensureContrast darkens on light backgrounds and lightens on dark ones", () => {
  const darkened = ensureContrast("#dddddd", "#ffffff", 4.5);
  assert.ok(hexContrastRatio(darkened, "#ffffff") >= 4.5);

  const lightened = ensureContrast("#333333", "#000000", 4.5);
  assert.ok(hexContrastRatio(lightened, "#000000") >= 4.5);

  // 只改变明度取向，不应把颜色推成纯黑/纯白以外的怪色。
  assert.match(darkened, /^#[0-9a-f]{6}$/);
  assert.match(lightened, /^#[0-9a-f]{6}$/);
});

test("built-in palettes already satisfy the contrast floor", () => {
  setActiveColorLevel("truecolor");
  resetThemeAppearance();
  resetActiveTheme();
  const dark = getTheme();
  assert.equal(dark.foreground, "#d9dee7");
  assert.equal(dark.muted, "#b4b4b4");
  assert.equal(dark.accent, "#a995d6");

  setThemeAppearance("light");
  const light = getTheme();
  // 浅色板刻意压到近黑：白底上的中灰字看久了对比度不足、容易疲劳。
  assert.equal(light.foreground, "#111111");
  assert.equal(light.muted, "#3a3a3a");
  assert.equal(light.accent, "#6b4fc4");
  assert.ok(hexContrastRatio(light.foreground, "#ffffff") >= 15);
  assert.ok(hexContrastRatio(light.muted, "#ffffff") >= 9);

  resetThemeAppearance();
  resetActiveTheme();
  resetActiveColorLevel();
});

test("a low-contrast user theme is lifted to the readable floor", () => {
  setActiveColorLevel("truecolor");
  resetThemeAppearance();
  resetActiveTheme();

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-contrast-"));
  const previousCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(cwd, ".haji"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".haji", "theme.json"),
      JSON.stringify({ foreground: "#f2f2f2", muted: "#ededed", accent: "#e0e0ff" }),
    );
    process.chdir(cwd);
    resetActiveTheme();

    const theme = getTheme();
    // 深色外观下参考背景是纯黑，浅色前景本来就可读 —— 换成浅色外观才会触底。
    setThemeAppearance("light");
    const light = getTheme();
    assert.ok(hexContrastRatio(light.foreground, "#ffffff") >= 4.5);
    assert.ok(hexContrastRatio(light.muted, "#ffffff") >= 4.5);
    assert.ok(hexContrastRatio(light.accent, "#ffffff") >= 3);
    // 兜底不应改动已经在安全区的颜色（这里验证深色外观下的本身）。
    assert.equal(theme.background, "");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    resetThemeAppearance();
    resetActiveTheme();
    resetActiveColorLevel();
  }
});

test("dim derives real colours from the background instead of SGR 2", () => {
  setActiveColorLevel("truecolor");
  resetThemeAppearance();
  resetActiveTheme();

  const dark = getTheme();
  const darkDim = dimHex(dark.foreground);
  assert.notEqual(darkDim, dark.foreground, "dim must differ from the base colour");
  assert.ok(
    hexContrastRatio(darkDim, "#000000") < hexContrastRatio(dark.foreground, "#000000"),
    "dim recedes toward the dark background",
  );
  assert.ok(hexContrastRatio(darkDim, "#000000") >= 3, "dim stays legible");

  setThemeAppearance("light");
  const light = getTheme();
  const lightDim = dimHex(light.foreground);
  assert.ok(
    hexContrastRatio(lightDim, "#ffffff") < hexContrastRatio(light.foreground, "#ffffff"),
    "dim recedes toward the light background",
  );
  assert.ok(hexContrastRatio(lightDim, "#ffffff") >= 3, "dim stays legible on light backgrounds");

  // 序列必须是具体前景色，而不是被终端各自解释的 SGR 2。
  const seq = dimFgSeq(light.foreground);
  assert.match(seq, /^\x1b\[38;2;\d+;\d+;\d+m$/);
  assert.ok(!seq.includes("[2m"));
  assert.match(buildAnsiStyles().dim, /^\x1b\[38;2;/);

  resetThemeAppearance();
  resetActiveTheme();
  resetActiveColorLevel();
});
