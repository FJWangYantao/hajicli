import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * mcp-serve 真回合端到端：假 DeepSeek（SSE）+ 真子进程 + 按 id 配对的 JSON-RPC。
 * 覆盖授权卡片在驱动模式下的几条关键路径——stdin 是协议通道，任何读输入框的分支都会把协议搞坏。
 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;

/**
 * 按最后一条用户消息里的关键词决定假模型的回应。
 * Plan 流程：PLAN → taskcreate(finalize) → 审阅要求 → 方案正文 → 审批；
 * 修改意见到达后再出一版计划（t2），批准后的工作流通知直接收尾。
 */
const TOOL_CALLS = {
  BASH: { name: "bash", args: { command: "touch made-by-driver.txt" } },
  PROTECT: {
    name: "write",
    args: { path: ".haji/permissions.json", content: '{"allow":[]}\n' },
  },
};

const textReply = (res, text) => res.end(`${sse({ content: text }, "stop")}data: [DONE]\n\n`);

const toolReply = (res, name, args) => {
  const toolCall = {
    index: 0,
    id: `call_${Date.now()}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
  res.end(`${sse({ tool_calls: [toolCall] })}${sse({}, "tool_calls")}data: [DONE]\n\n`);
};

async function startFakeModel() {
  /** 每次带工具的请求里最后一条用户消息（断言修改意见确实送到了模型）。 */
  const userTexts = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    const messages = payload.messages ?? [];
    const last = messages.at(-1);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const userText =
      typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
    if (userText.includes("FAIL")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request from fake model" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (payload.tools) userTexts.push(userText);
    if (last?.role === "tool") {
      textReply(res, `工具结果：${String(last.content)}`);
      return;
    }
    if (payload.tools && last?.role === "user") {
      if (userText.includes("[系统计划审阅要求]")) {
        textReply(res, "方案：先改登录逻辑，再跑测试验证。");
        return;
      }
      if (userText.includes("[系统工作流通知]")) {
        textReply(res, "已按计划执行完毕。");
        return;
      }
      if (userText.includes("[计划修改意见]")) {
        toolReply(res, "taskcreate", { id: "t2", content: "补回归测试", finalize: true });
        return;
      }
      if (userText.includes("PLAN")) {
        toolReply(res, "taskcreate", {
          title: "改登录",
          id: "t1",
          content: "改登录逻辑",
          finalize: true,
        });
        return;
      }
    }
    const key = Object.keys(TOOL_CALLS).find((name) => userText.includes(name));
    if (payload.tools && key) {
      toolReply(res, TOOL_CALLS[key].name, TOOL_CALLS[key].args);
      return;
    }
    textReply(res, "你好，我是假模型。");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    userTexts,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function makeSandbox(baseUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-serve-approval-"));
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
  return { root, cwd, env };
}

/** 起 mcp-serve，返回按 id 配对的 call()；非 JSON 的 stdout 行收进 nonJson（应恒为空）。 */
function startServe(sandbox, args = []) {
  const child = spawn(process.execPath, [cliEntry, "mcp-serve", ...args], {
    cwd: sandbox.cwd,
    env: sandbox.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const nonJson = [];
  const pending = new Map();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      nonJson.push(line);
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));

  let nextId = 1;
  const rpc = (method, params = {}, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`${method} 超时；非 JSON 输出：${nonJson.join(" | ")}；stderr：${stderr}`),
        );
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name, args = {}, timeoutMs) => {
    const response = await rpc("tools/call", { name, arguments: args }, timeoutMs);
    return JSON.parse(response.result.content[0].text);
  };
  const seenSelections = new Set();
  /** 下一条还没处理过的 selection_request（事件可能早于 haji_send 回包，所以从头扫）。 */
  const nextSelection = async () => {
    for (let i = 0; i < 80; i++) {
      const { events } = await call("haji_events", { sinceSeq: 0, limit: 500 });
      const request = events.find(
        (event) => event.type === "selection_request" && !seenSelections.has(event.requestId),
      );
      if (request) {
        seenSelections.add(request.requestId);
        return request;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("没有等到 selection_request");
  };
  const waitTurnEnd = async (taskId) => {
    for (let i = 0; i < 20; i++) {
      const { events } = await call("haji_events", { sinceSeq: 0, limit: 500 });
      const end = events.find((event) => event.type === "turn_end" && event.taskId === taskId);
      if (end) return end;
      await call("haji_wait", { timeoutMs: 1000 });
    }
    throw new Error(`回合 ${taskId} 没有结束`);
  };

  return {
    rpc,
    call,
    nextSelection,
    waitTurnEnd,
    nonJson,
    stderrText: () => stderr,
    async close() {
      child.stdin.end();
      let timer;
      const code = await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 15_000);
        }),
      ]).finally(() => clearTimeout(timer));
      rl.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return code;
    },
  };
}

async function withServe(args, body) {
  const model = await startFakeModel();
  const sandbox = makeSandbox(model.baseUrl);
  const serve = startServe(sandbox, args);
  try {
    await serve.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "haji-test", version: "0.0.0" },
    });
    // 全新 HOME 的默认档不一定会弹授权卡，统一切到 default。
    await serve.call("haji_adjust", { permissionMode: "default" });
    await body(serve, sandbox, model);
    assert.deepEqual(serve.nonJson, [], "stdout 只能是 JSON-RPC 帧");
    assert.equal(await serve.close(), 0, `stdin 关闭后应正常退出，stderr：${serve.stderrText()}`);
  } finally {
    await serve.close();
    model.close();
    await fs.promises.rm(sandbox.root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

test("mcp-serve ask：批准执行、拒绝并说明经 reason 回传，toolCalls 只计本回合", async () => {
  await withServe([], async (serve, sandbox) => {
    const target = path.join(sandbox.cwd, "made-by-driver.txt");

    const first = await serve.call("haji_send", { text: "BASH 建个文件", waitMs: 0 });
    const card = await serve.nextSelection();
    assert.deepEqual(
      card.items.map((item) => item.value),
      ["once", "session", "always", "deny", "deny-reason"],
    );
    assert.equal(card.default.value, "deny", "无人回复的兜底必须是拒绝");

    const invalid = await serve.call("haji_approve", { requestId: card.requestId, value: "yes" });
    assert.equal(invalid.accepted, false, "未知选项值不能结案（否则会落到放行分支）");

    const approved = await serve.call("haji_approve", { requestId: card.requestId, value: "once" });
    assert.equal(approved.accepted, true);
    const firstEnd = await serve.waitTurnEnd(first.taskId);
    assert.equal(firstEnd.ok, true);
    assert.equal(firstEnd.toolCalls, 1);
    assert.ok(fs.existsSync(target), "批准后命令应真正执行");
    fs.rmSync(target);

    const second = await serve.call("haji_send", { text: "BASH 再建一次", waitMs: 0 });
    const card2 = await serve.nextSelection();
    const denied = await serve.call("haji_approve", {
      requestId: card2.requestId,
      value: "deny-reason",
      reason: "先读 README 再动手",
    });
    assert.equal(denied.accepted, true);
    const secondEnd = await serve.waitTurnEnd(second.taskId);
    assert.equal(secondEnd.toolCalls, 1, "第二回合只调了一次工具，不能把历史累加进来");
    assert.match(secondEnd.text, /用户说明：先读 README 再动手/, "拒绝原因应回传给模型");
    assert.equal(fs.existsSync(target), false, "拒绝后不应执行");

    // 协议没被输入框吞掉：后续请求照常回包。
    const status = await serve.call("haji_status", {}, 5000);
    assert.equal(status.running, false);
    assert.deepEqual(status.pendingSelections, []);
  });
});

test("mcp-serve auto：普通授权放行本次，受保护目标一律拒绝", async () => {
  await withServe(["--approval", "auto"], async (serve, sandbox) => {
    const plain = await serve.call("haji_send", { text: "BASH 建个文件", waitMs: 15_000 });
    assert.equal(plain.status, "done");
    assert.ok(fs.existsSync(path.join(sandbox.cwd, "made-by-driver.txt")));

    const guarded = await serve.call("haji_send", { text: "PROTECT 改授权", waitMs: 15_000 });
    assert.equal(guarded.status, "done");
    assert.match(guarded.result.text, /受保护目标/);
    assert.equal(
      fs.existsSync(path.join(sandbox.cwd, ".haji", "permissions.json")),
      false,
      "--approval auto 不能替客户端放行受保护目标",
    );
  });
});

test("mcp-serve：模型请求失败时 turn 结果 ok=false", async () => {
  await withServe([], async (serve) => {
    const sent = await serve.call("haji_send", { text: "FAIL 请求", waitMs: 15_000 });
    assert.equal(sent.status, "done");
    assert.equal(sent.result.ok, false);
  });
});

test("mcp-serve ask：计划审批——修改意见经 reason 送回模型，再批准后切到 [默认] 执行", async () => {
  await withServe([], async (serve, _sandbox, model) => {
    await serve.call("haji_adjust", { permissionMode: "plan" });
    const sent = await serve.call("haji_send", { text: "PLAN 改一下登录", waitMs: 0 });

    const review = await serve.nextSelection();
    assert.deepEqual(
      review.items.map((item) => item.value),
      ["auto", "manual", "no"],
    );
    assert.equal(review.default.value, "no", "无人回复时留在计划模式，不能默认批准");
    const revise = await serve.call("haji_approve", {
      requestId: review.requestId,
      value: "no",
      reason: "加上回归测试",
    });
    assert.equal(revise.accepted, true);

    // 修改意见在本回合内直接送给模型，模型改完计划后再次请求审批。
    const second = await serve.nextSelection();
    assert.ok(
      model.userTexts.some((text) => text.includes("[计划修改意见] 加上回归测试")),
      "修改意见应作为用户消息送到模型",
    );
    const approved = await serve.call("haji_approve", {
      requestId: second.requestId,
      value: "manual",
    });
    assert.equal(approved.accepted, true);

    const end = await serve.waitTurnEnd(sent.taskId);
    assert.equal(end.ok, true);
    assert.match(end.text, /已按计划执行完毕/);
    assert.equal(
      (await serve.call("haji_status")).permissionMode,
      "default",
      "manual 批准切到 [默认]",
    );
  });
});

test("mcp-serve auto：计划自动批准只切到 [默认]，不替客户端提到 [自动]", async () => {
  await withServe(["--approval", "auto"], async (serve) => {
    await serve.call("haji_adjust", { permissionMode: "plan" });
    const sent = await serve.call("haji_send", { text: "PLAN 改一下登录", waitMs: 15_000 });
    assert.equal(sent.status, "done");
    assert.match(sent.result.text, /已按计划执行完毕/);
    assert.equal(sent.result.permissionMode, "default");
  });
});

test("examples/mcp-serve-client.mjs 按策略回复授权卡与计划审批", async () => {
  const model = await startFakeModel();
  const sandbox = makeSandbox(model.baseUrl);
  const example = fileURLToPath(new URL("../../../examples/mcp-serve-client.mjs", import.meta.url));
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [example, "--mode", "default", ...args], {
        cwd: sandbox.cwd,
        env: { ...sandbox.env, HAJI_BIN: cliEntry },
      });
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
        reject(new Error(`示例客户端超时；stderr：${stderr}`));
      }, 30_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  try {
    const target = path.join(sandbox.cwd, "made-by-driver.txt");
    const denied = await run(["BASH 建个文件"]);
    assert.equal(denied.code, 0, denied.stderr);
    assert.match(denied.stdout, /客户端策略未放行/, "默认策略拒绝并说明，理由回传给模型");
    assert.equal(fs.existsSync(target), false);

    const allowed = await run(["--yes", "BASH 建个文件"]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.ok(fs.existsSync(target), "--yes 时仅本次允许");

    const planned = await run(["--plan", "PLAN 改一下登录"]);
    assert.equal(planned.code, 0, planned.stderr);
    assert.match(planned.stdout, /已按计划执行完毕/);
  } finally {
    model.close();
    await fs.promises.rm(sandbox.root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
