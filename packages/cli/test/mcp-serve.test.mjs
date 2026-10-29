import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** dist 入口按测试文件位置解析，兼容从仓库根或包目录发起的 node --test。 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** 隔离的 HOME + 工作目录：不读用户真实配置，也不往真实仓库写会话。 */
function makeSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // 只给假 key：驱动服务启动不校验 key，但缺 key 会走配置向导分支。
  env.DEEPSEEK_API_KEY = "sk-fake-for-test";
  delete env.VOLC_API_KEY;
  delete env.ARK_API_KEY;
  return { root, home, cwd, env };
}

/**
 * 起一个 `haji mcp-serve` 子进程，按行收 stdout 的 JSON-RPC 回包。
 * 返回 { send, next, stdoutLines, stderr, exited }，由调用方决定何时关 stdin。
 */
function startServe(args, sandbox) {
  const child = spawn(process.execPath, [cliEntry, "mcp-serve", ...args], {
    cwd: sandbox.cwd,
    env: sandbox.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines = [];
  const waiters = [];
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else stdoutLines.push(line);
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

  /** 取下一行 stdout（先看已缓冲的，再等新的）。 */
  const next = (timeoutMs = 20_000) => {
    const buffered = stdoutLines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待 stdout 超时，已收到：${stdoutLines.join("\n")}`)),
        timeoutMs,
      );
      waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  };

  return {
    child,
    send,
    next,
    exited,
    stdoutLines,
    stderrText: () => stderr,
    async close() {
      child.stdin.end();
      let timer;
      const result = await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("进程未在超时内退出")), 20_000);
        }),
      ]).finally(() => clearTimeout(timer));
      rl.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return result;
    },
  };
}

const initializeMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "haji-test", version: "0.0.0" },
  },
};

test("haji mcp-serve 端到端：initialize 与 tools/list 走 stdio 回包", async () => {
  const sandbox = makeSandbox("haji-mcp-serve-");
  const serve = startServe(["--cwd", sandbox.cwd], sandbox);
  try {
    serve.send(initializeMessage);
    const initLine = await serve.next();
    const init = JSON.parse(initLine);
    assert.equal(init.jsonrpc, "2.0");
    assert.equal(init.id, 1);
    assert.equal(init.result?.serverInfo?.name, "haji", "应回 MCP 握手，而不是打印首页 Logo");
    assert.ok(init.result?.capabilities?.tools, "应声明 tools 能力");
    // stdout 只能是协议帧：首页 Logo 的块字符不应出现在任何一行里。
    assert.doesNotMatch(initLine, /█|╔|HAJI/, "stdout 不应混入首页 Logo");

    serve.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = JSON.parse(await serve.next()).result.tools;
    const names = tools.map((tool) => tool.name);
    assert.deepEqual(
      names,
      [
        "haji_status",
        "haji_send",
        "haji_wait",
        "haji_events",
        "haji_adjust",
        "haji_cancel",
        "haji_approve",
      ],
      "工具面应完整暴露",
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} 应带 object 入参 schema`);
    }

    // stdin 关闭即视为客户端断开：进程正常退出，不残留后台服务。
    const { code } = await serve.close();
    assert.equal(code, 0, `正常断开应以 0 退出，stderr：${serve.stderrText()}`);
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("haji mcp-serve 拒绝未知参数并以 1 退出", async () => {
  const sandbox = makeSandbox("haji-mcp-serve-bad-");
  const serve = startServe(["--bogus"], sandbox);
  try {
    const { code } = await serve.exited;
    assert.equal(code, 1);
    assert.match(serve.stderrText(), /未知的 mcp-serve 参数/);
    assert.equal(serve.stdoutLines.length, 0, "参数错误时不应输出协议帧");
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("haji mcp-serve --cwd 指向不存在的目录时报错退出", async () => {
  const sandbox = makeSandbox("haji-mcp-serve-cwd-");
  const missing = path.join(sandbox.root, "missing-dir");
  const serve = startServe(["--cwd", missing], sandbox);
  try {
    const { code } = await serve.exited;
    assert.equal(code, 1);
    assert.match(serve.stderrText(), /无法切换到工作目录/);
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});
