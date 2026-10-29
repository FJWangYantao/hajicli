import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
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

test("本地服务首次配置成功，失败不落盘且再次启动可重试", async () => {
  const bodies = [];
  let fail = true;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.writeHead(fail ? 400 : 200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        fail
          ? { error: { message: "invalid model" } }
          : { choices: [{ message: { content: "ok" } }] },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await withIsolatedPaths(async () => {
      const answers = [
        "3",
        "localtest",
        `http://127.0.0.1:${server.address().port}/v1`,
        "test-private-key",
        "test-model",
      ];
      const failed = fakeTerminal(answers);
      assert.equal((await runProviderOnboarding(failed.stream, failed.output)).configured, false);
      assert.equal(configExists(), false);
      fail = false;
      const terminal = fakeTerminal(answers);
      let output = "";
      terminal.output.on("data", (chunk) => {
        output += chunk;
      });
      assert.deepEqual(await runProviderOnboarding(terminal.stream, terminal.output), {
        configured: true,
        providerName: "localtest",
      });
      const config = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".haji", "config.json"), "utf8"),
      );
      assert.equal(config.providers.localtest.apiKey, "test-private-key");
      assert.equal(config.providers.localtest.model, "test-model");
      assert.equal(output.includes("test-private-key"), false);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[1].model, "test-model");
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

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
