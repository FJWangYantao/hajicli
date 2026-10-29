import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * haji -p 的退出码：回合成功 0，模型请求失败 1（CI 靠退出码判失败，不能只看 JSON 里的 ok）。
 * 用假 DeepSeek（SSE）跑真实子进程；子进程必须异步起，spawnSync 会把同进程的假服务堵死。
 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function startFakeModel() {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body || "{}").messages ?? [];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (String(lastUser?.content ?? "").includes("FAIL")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request from fake model" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = { choices: [{ index: 0, delta: { content: "好的。" }, finish_reason: "stop" }] };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function runHeadless(baseUrl, args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-headless-exit-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DEEPSEEK_API_KEY: "sk-fake-for-test",
    DEEPSEEK_BASE_URL: baseUrl,
    HAJI_POST_EDIT_VERIFY: "0",
  };
  delete env.VOLC_API_KEY;
  delete env.ARK_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`-p 超时；stderr：${stderr}`));
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      fs.rmSync(root, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

test("-p 回合成功退出码 0，模型请求失败退出码 1（JSON 与文本模式一致）", async () => {
  const model = await startFakeModel();
  try {
    const okJson = await runHeadless(model.baseUrl, ["-p", "你好", "--output-format", "json"]);
    assert.equal(okJson.code, 0, okJson.stderr);
    assert.equal(JSON.parse(okJson.stdout).ok, true);

    const failJson = await runHeadless(model.baseUrl, ["-p", "FAIL", "--output-format", "json"]);
    assert.equal(failJson.code, 1, "ok:false 时退出码必须非 0");
    assert.equal(JSON.parse(failJson.stdout).ok, false);

    const failText = await runHeadless(model.baseUrl, ["-p", "FAIL"]);
    assert.equal(failText.code, 1);
  } finally {
    model.close();
  }
});
