#!/usr/bin/env node
/**
 * haji mcp-serve 最小客户端示例：派一个任务、跟进进度、按策略回复授权卡，零依赖。
 *
 *   node examples/mcp-serve-client.mjs [--cwd <目录>] [--mode <权限档>] [--yes] [--plan] "<任务>"
 *
 * - --mode 先切权限档（plan / default / accept-edit / auto / bypass-permissions）；
 *   不给就沿用用户偏好，全新环境是 auto（由安全分类器判定，多数操作不会弹卡）。
 * - 默认对授权卡回「拒绝并说明」（理由会回传给模型）；加 --yes 改为「仅本次允许」。
 * - --plan 先切到 Plan 档：模型出计划后，本示例选「批准，逐步审批」。
 * - HAJI_BIN 指定 haji 入口（默认 PATH 里的 haji；以 .js 结尾时用当前 node 运行）。
 * - 退出码：回合 ok 为 0，否则 1。
 *
 * 外部 Agent（Hermes 等）走的是同一套调用顺序，只是由它的模型决定何时调哪个工具。
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
};
const option = (name) => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const [, value] = argv.splice(index, 2);
  return value;
};
const autoYes = flag("--yes");
const planFirst = flag("--plan");
const cwd = option("--cwd");
const mode = option("--mode");
const task = argv.join(" ").trim();
if (!task) {
  console.error(
    '用法：node examples/mcp-serve-client.mjs [--cwd <目录>] [--mode <权限档>] [--yes] [--plan] "<任务>"',
  );
  process.exit(2);
}

// ── 1. 起 haji mcp-serve，按 JSON-RPC id 配对回包 ─────────────────────────
const bin = process.env.HAJI_BIN || "haji";
const serveArgs = ["mcp-serve", ...(cwd ? ["--cwd", cwd] : [])];
const child = bin.endsWith(".js")
  ? spawn(process.execPath, [bin, ...serveArgs], { stdio: ["pipe", "pipe", "inherit"] })
  : spawn(bin, serveArgs, { stdio: ["pipe", "pipe", "inherit"] });
const exited = new Promise((resolve) => child.on("exit", resolve));
const pending = new Map();
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line); // stdout 只会有协议帧
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
let nextId = 1;
const rpc = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
/** 调一个 haji_* 工具，返回解析后的 JSON；isError 时抛错。 */
const call = async (name, args = {}) => {
  const response = await rpc("tools/call", { name, arguments: args });
  const payload = JSON.parse(response.result.content[0].text);
  if (response.result.isError) throw new Error(`${name} 失败：${JSON.stringify(payload)}`);
  return payload;
};

// ── 2. 授权策略：看卡片里有哪些选项再决定 ────────────────────────────────
function decide(card) {
  const values = new Set(card.items.map((item) => item.value));
  if (values.has("manual")) return { value: "manual" }; // 计划审批：批准但逐步审批
  if (values.has("once")) {
    return autoYes
      ? { value: "once" }
      : { value: "deny-reason", reason: "客户端策略未放行该操作，请换只读方式完成或说明必要性。" };
  }
  return { value: card.default.value }; // 其他选择：采用服务端声明的兜底值
}

// ── 3. 派活 → 跟进 → 收尾 ─────────────────────────────────────────────
async function main() {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "haji-example-client", version: "0.1.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  if (mode) await call("haji_adjust", { permissionMode: mode });
  if (planFirst) await call("haji_adjust", { plan: true });

  const sent = await call("haji_send", { text: task, waitMs: 2000 });
  if (sent.status === "done") return sent.result;

  // running 时 lastSeq 停在回合开始前：从它等，能看到本回合所有事件（含早到的授权卡）。
  let cursor = sent.lastSeq;
  for (;;) {
    const batch = await call("haji_wait", { sinceSeq: cursor, timeoutMs: 60_000 });
    cursor = batch.lastSeq;
    for (const event of batch.events) {
      if (event.type === "tool_start") console.error(`→ ${event.name} ${event.args ?? ""}`);
      if (event.type === "tool_end") console.error(`${event.ok ? "✓" : "✕"} ${event.name}`);
      if (event.type === "selection_request") {
        const answer = decide(event);
        console.error(`? ${event.title} → ${answer.value}`);
        await call("haji_approve", { requestId: event.requestId, ...answer });
      }
      if (event.type === "turn_end" && event.taskId === sent.taskId) return event;
    }
  }
}

let exitCode = 1;
try {
  const result = await main();
  process.stdout.write(`${result.text ?? ""}\n`);
  exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  child.stdin.end(); // 关闭 stdin，haji 正常收尾退出
  await exited;
}
process.exit(exitCode);
