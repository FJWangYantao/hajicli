import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runProviderOnboarding } from "../dist/onboarding.js";

/** 隔离 HOME/USERPROFILE，向导写盘只落在临时目录（不碰真实 ~/.haji）。 */
function withIsolatedPaths(run) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "haji-onboarding-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return Promise.resolve(run()).finally(() => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

/**
 * 构造“按提示逐个喂答案”的假终端：readline 会丢弃无人等待的行，
 * 因此监听输出流里的提问（均以中文冒号结尾），出现一问喂一答。
 */
function fakeTerminal(answers) {
  const stream = new PassThrough();
  const output = new PassThrough();
  let index = 0;
  output.on("data", (chunk) => {
    if (!String(chunk).includes("：")) return;
    if (index >= answers.length) return;
    const answer = answers[index];
    index += 1;
    setImmediate(() => stream.write(`${answer}\n`));
  });
  return { stream, output };
}

function configExists() {
  return fs.existsSync(path.join(os.homedir(), ".haji", "config.json"));
}

test("onboarding aborts cleanly when the user skips the wizard", async () => {
  await withIsolatedPaths(async () => {
    const { stream, output } = fakeTerminal([""]);
    const outcome = await runProviderOnboarding(stream, output);
    assert.equal(outcome.configured, false);
    assert.equal(configExists(), false);
  });
});

test("onboarding rejects an invalid provider choice without touching config", async () => {
  await withIsolatedPaths(async () => {
    const { stream, output } = fakeTerminal(["9"]);
    const outcome = await runProviderOnboarding(stream, output);
    assert.equal(outcome.configured, false);
    assert.equal(configExists(), false);
  });
});

test("onboarding exits without network when the custom base URL is invalid", async () => {
  await withIsolatedPaths(async () => {
    const { stream, output } = fakeTerminal(["3", "demo", "not-a-url"]);
    const outcome = await runProviderOnboarding(stream, output);
    assert.equal(outcome.configured, false);
    assert.equal(configExists(), false);
  });
});

test("onboarding stops when the API key is left empty", async () => {
  await withIsolatedPaths(async () => {
    const { stream, output } = fakeTerminal(["1", ""]);
    const outcome = await runProviderOnboarding(stream, output);
    assert.equal(outcome.configured, false);
    assert.equal(configExists(), false);
  });
});

test("onboarding requires at least one custom model name", async () => {
  await withIsolatedPaths(async () => {
    const { stream, output } = fakeTerminal([
      "3",
      "demo",
      "https://api.example.com/v1",
      "sk-test",
      "",
    ]);
    const outcome = await runProviderOnboarding(stream, output);
    assert.equal(outcome.configured, false);
    assert.equal(configExists(), false);
  });
});

test("index.ts keeps headless exit(1) and gates the wizard on interactive TTY", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /runProviderOnboarding\(process\.stdin\)/);
  assert.match(source, /if \(headlessRequest \|\| !process\.stdin\.isTTY\)/);
  assert.match(source, /if \(!onboarding\.configured\) process\.exit\(1\)/);
  // 向导完成后重读配置并继续正常启动。
  assert.match(source, /providerConfig = loadProviderConfig\(\)/);
});
