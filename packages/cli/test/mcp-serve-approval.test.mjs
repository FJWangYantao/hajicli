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

/** 按最后一条用户消息里的关键词决定假模型的回应。 */
const TOOL_CALLS = {
  BASH: { name: "bash", args: { command: "touch made-by-driver.txt" } },
  PROTECT: {
    name: "write",
    args: { path: ".haji/permissions.json", content: '{"allow":[]}\n' },
  },
};

async function startFakeModel() {
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
    if (last?.role === "tool") {
      res.end(`${sse({ content: `工具结果：${String(last.content)}` }, "stop")}data: [DONE]\n\n`);
      return;
    }
    const key = Object.keys(TOOL_CALLS).find((name) => userText.includes(name));
    if (payload.tools && key) {
      const call = TOOL_CALLS[key];
      const toolCall = {
        index: 0,
        id: `call_${Date.now()}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      };
      res.end(`${sse({ tool_calls: [toolCall] })}${sse({}, "tool_calls")}data: [DONE]\n\n`);
      return;
    }
    res.end(`${sse({ content: "你好，我是假模型。" }, "stop")}data: [DONE]\n\n`);
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
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

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
    await body(serve, sandbox);
    assert.deepEqual(serve.nonJson, [], "stdout 只能是 JSON-RPC 帧");
    assert.equal(await serve.close(), 0, `stdin 关闭后应正常退出，stderr：${serve.stderrText()}`);
  } finally {
    await serve.close();
    model.close();
    fs.rmSync(sandbox.root, { recursive: true, force: true });
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
