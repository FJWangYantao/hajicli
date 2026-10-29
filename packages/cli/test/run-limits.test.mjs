import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseHeadlessArgs } from "../dist/headless.js";
import { evaluateRunLimits, parseRunLimitValue } from "../dist/run-limits.js";
import { parseServeArgs } from "../dist/serve-args.js";

/**
 * 无人值守硬上限：-p 与 mcp-serve 的 --max-cost / --max-turns。
 * e2e 用一个永远要求再调一次工具、且每次上报 100 万 prompt token 的假模型，确认闸真的会停。
 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("limit flags parse for -p and mcp-serve, and are rejected elsewhere", () => {
  assert.deepEqual(
    parseHeadlessArgs(["-p", "x", "--max-cost", "1.5", "--max-turns", "3"]).request?.limits,
    {
      maxCostCny: 1.5,
      maxTurns: 3,
    },
  );
  assert.equal(parseHeadlessArgs(["-p", "x"]).request?.limits, undefined);
  assert.match(parseHeadlessArgs(["-p", "x", "--max-cost", "0"]).error, /大于 0/);
  assert.match(parseHeadlessArgs(["-p", "x", "--max-turns", "2.5"]).error, /整数/);
  assert.match(parseHeadlessArgs(["-p", "x", "--max-turns"]).error, /整数/);
  // 交互会话里静默忽略会让人以为有闸。
  assert.match(parseHeadlessArgs(["--max-cost", "1"]).error, /只在无头模式/);
  // mcp-serve 自己解析，headless 不抢着报错。
  assert.deepEqual(parseHeadlessArgs(["mcp-serve", "--max-cost", "1"]), {});
  assert.deepEqual(parseServeArgs(["mcp-serve", "--max-turns", "5"]).request?.limits, {
    maxTurns: 5,
  });
  assert.equal(parseServeArgs(["mcp-serve"]).request?.limits, undefined);
  assert.match(parseServeArgs(["mcp-serve", "--max-cost", "abc"]).error, /--max-cost/);
  assert.ok("error" in parseRunLimitValue("--max-turns", "--max-cost"));
});

test("evaluateRunLimits checks cost before turns and only fires at the threshold", () => {
  const limits = { maxCostCny: 1, maxTurns: 2 };
  assert.equal(evaluateRunLimits(limits, { requestsThisTurn: 1, costCny: 0.99 }), undefined);
  assert.equal(evaluateRunLimits(limits, { requestsThisTurn: 2, costCny: 0 })?.kind, "max_turns");
  const both = evaluateRunLimits(limits, { requestsThisTurn: 5, costCny: 1 });
  assert.equal(both?.kind, "max_cost");
  assert.match(both.message, /费用上限 ¥1\.00/);
});

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

/** 每次请求都回一个 bash 工具调用，并在末尾上报 usage（100 万 prompt token ≈ 几元）。 */
async function startLoopingModel() {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!payload.tools) {
      res.end(
        `${sse({ choices: [{ index: 0, delta: { content: "标题" }, finish_reason: "stop" }] })}data: [DONE]\n\n`,
      );
      return;
    }
    requests += 1;
    const toolCall = {
      index: 0,
      id: `call_${requests}`,
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: `echo step ${requests}` }) },
    };
    res.end(
      sse({ choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }] }) +
        sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        sse({
          choices: [],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 10, total_tokens: 1_000_010 },
        }) +
        "data: [DONE]\n\n",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    get requests() {
      return requests;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function sandboxEnv(baseUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-run-limits-"));
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
  return { cwd, env };
}

function runHeadless(baseUrl, args) {
  const { cwd, env } = sandboxEnv(baseUrl);
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const HEADLESS_BASE = ["--permission-mode", "bypass-permissions", "--output-format", "json"];

test("e2e: -p --max-turns stops the agent loop and exits 1", async () => {
  const model = await startLoopingModel();
  try {
    const result = await runHeadless(model.baseUrl, [
      "-p",
      "go",
      "--max-turns",
      "2",
      ...HEADLESS_BASE,
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(model.requests, 2);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, false);
    assert.equal(json.stopReason, "max_turns");
    assert.equal(json.toolCalls, 2);
  } finally {
    model.close();
  }
});

test("e2e: -p --max-cost stops before the request that would exceed the budget", async () => {
  const model = await startLoopingModel();
  try {
    const result = await runHeadless(model.baseUrl, [
      "-p",
      "go",
      "--max-cost",
      "0.5",
      ...HEADLESS_BASE,
    ]);
    assert.equal(result.code, 1, result.stderr);
    // 第一次请求就花掉 >¥0.5，第二次请求前被拦下。
    assert.equal(model.requests, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.stopReason, "max_cost");
    assert.ok(json.usage.estimatedCostCny >= 0.5);
  } finally {
    model.close();
  }
});

test("e2e: mcp-serve --max-cost stops the turn and refuses later haji_send", async () => {
  const model = await startLoopingModel();
  const { cwd, env } = sandboxEnv(model.baseUrl);
  const child = spawn(
    process.execPath,
    [cliEntry, "mcp-serve", "--approval", "auto", "--max-cost", "0.5", "--max-turns", "50"],
    { cwd, env },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const tool = async (name, args) => {
    const reply = await call("tools/call", { name, arguments: args });
    return JSON.parse(reply.result.content[0].text);
  };
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    await tool("haji_adjust", { permissionMode: "bypass-permissions" });
    const first = await tool("haji_send", { text: "go", waitMs: 30_000 });
    assert.equal(first.status, "done", JSON.stringify(first) + stderr);
    assert.equal(first.result.ok, false);
    assert.equal(first.result.stopReason, "max_cost");
    assert.equal(model.requests, 1);

    const second = await tool("haji_send", { text: "again", waitMs: 30_000 });
    assert.equal(second.result.ok, false);
    assert.equal(second.result.stopReason, "max_cost");
    assert.match(second.result.error, /费用上限/);
    assert.equal(model.requests, 1, "no request may be sent once the budget is spent");
  } finally {
    child.stdin.end();
    child.kill();
    model.close();
  }
});
