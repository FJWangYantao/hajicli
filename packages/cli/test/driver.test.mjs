import assert from "node:assert/strict";
import test from "node:test";
import { buildPatch, handleMessage, TOOL_DEFINITIONS } from "../dist/driver/mcp.js";
import { DriverServer } from "../dist/driver/server.js";
import { isServeCommand, parseServeArgs } from "../dist/serve-args.js";

function createFakeHost(overrides = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const host = {
    async runTurn(text) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(text);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        ok: true,
        text: `echo:${text}`,
        sessionId: "s1",
        model: "test-model",
        permissionMode: "default",
        toolCalls: 0,
        durationMs: 10,
      };
    },
    status: () => ({
      sessionId: "s1",
      sessionTitle: "会话",
      model: "test-model",
      provider: "test",
      effort: "medium",
      permissionMode: "default",
      cwd: "/tmp",
      running: false,
      messageCount: 1,
    }),
    adjust: async (patch) => ({ applied: patch, errors: [] }),
    cancel: () => true,
    close: async () => {},
    ...overrides,
  };
  return { host, calls, getMaxActive: () => maxActive };
}

function createServer(options = {}, overrides = {}) {
  const fake = createFakeHost(overrides);
  const server = new DriverServer(fake.host, {
    waitMs: 1000,
    approval: "ask",
    ...options,
  });
  return { server, ...fake };
}

function callTool(server, name, args = {}) {
  return handleMessage(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function parseContent(response) {
  return JSON.parse(response.result.content[0].text);
}

test("mcp-serve 参数解析", () => {
  assert.equal(isServeCommand(["mcp-serve"]), true);
  assert.equal(isServeCommand(["--mcp-serve"]), true);
  assert.equal(isServeCommand(["-p", "hi"]), false);
  assert.equal(parseServeArgs(["-p", "hi"]).request, undefined);

  const defaults = parseServeArgs(["mcp-serve"]).request;
  assert.equal(defaults.approval, "ask");
  assert.equal(defaults.waitMs, 25_000);
  assert.equal(defaults.cwd, undefined);

  const custom = parseServeArgs([
    "mcp-serve",
    "--cwd",
    "/repo",
    "--approval",
    "auto",
    "--wait-ms",
    "5000",
  ]).request;
  assert.equal(custom.cwd, "/repo");
  assert.equal(custom.approval, "auto");
  assert.equal(custom.waitMs, 5000);

  assert.match(parseServeArgs(["mcp-serve", "--approval", "yolo"]).error, /ask 或 auto/);
  assert.match(parseServeArgs(["mcp-serve", "--wait-ms", "0"]).error, /毫秒数/);
  assert.match(parseServeArgs(["mcp-serve", "--bogus"]).error, /未知/);
});

test("initialize 回显受支持的协议版本", async () => {
  const { server } = createServer();
  const response = await handleMessage(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hermes" } },
  });
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.equal(response.result.serverInfo.name, "haji");
  assert.deepEqual(response.result.capabilities.tools, { listChanged: false });
});

test("initialize 遇到未知版本回退到最新", async () => {
  const { server } = createServer();
  const response = await handleMessage(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  });
  assert.equal(response.result.protocolVersion, "2025-06-18");
});

test("通知类消息不回包", async () => {
  const { server } = createServer();
  const response = await handleMessage(server, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(response, undefined);
});

test("tools/list 暴露全部 haji_* 工具", async () => {
  const { server } = createServer();
  const response = await handleMessage(server, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(
    names,
    TOOL_DEFINITIONS.map((tool) => tool.name),
  );
  for (const name of [
    "haji_status",
    "haji_send",
    "haji_wait",
    "haji_events",
    "haji_adjust",
    "haji_cancel",
    "haji_approve",
  ]) {
    assert.ok(names.includes(name), `缺少工具 ${name}`);
  }
});

test("未知方法返回 -32601", async () => {
  const { server } = createServer();
  const response = await handleMessage(server, { jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.equal(response.error.code, -32601);
});

test("haji_send 跑完直接返回结果", async () => {
  const { server, calls } = createServer();
  const response = await callTool(server, "haji_send", { text: "改一下 README" });
  const payload = parseContent(response);
  assert.equal(payload.status, "done");
  assert.equal(payload.result.text, "echo:改一下 README");
  assert.equal(payload.result.ok, true);
  assert.deepEqual(calls, ["改一下 README"]);
});

test("haji_send 空文本报错", async () => {
  const { server } = createServer();
  const response = await callTool(server, "haji_send", { text: "   " });
  assert.equal(response.result.isError, true);
});

test("haji_send 超时返回 running + taskId", async () => {
  const { server } = createServer(
    { waitMs: 100 },
    {
      runTurn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          ok: true,
          text: "慢",
          sessionId: "s1",
          model: "m",
          permissionMode: "default",
          toolCalls: 0,
          durationMs: 300,
        };
      },
    },
  );
  const response = await callTool(server, "haji_send", { text: "慢任务" });
  const payload = parseContent(response);
  assert.equal(payload.status, "running");
  assert.match(payload.taskId, /^t\d+$/);
  assert.equal(server.running, true);
  // 等它真正跑完，避免用例结束时还有悬挂定时器。
  await server.wait(0, 1000);
  assert.equal(server.running, false);
});

test("多个 haji_send 串行执行，不并发跑同一工作区", async () => {
  const { server, calls, getMaxActive } = createServer();
  const [a, b] = await Promise.all([
    callTool(server, "haji_send", { text: "第一个" }),
    callTool(server, "haji_send", { text: "第二个" }),
  ]);
  assert.equal(parseContent(a).status, "done");
  assert.equal(parseContent(b).status, "done");
  assert.deepEqual(calls, ["第一个", "第二个"]);
  assert.equal(getMaxActive(), 1);
});

test("haji_events 按 seq 增量返回并可续拉", async () => {
  const { server } = createServer();
  await callTool(server, "haji_send", { text: "hi" });

  const first = parseContent(await callTool(server, "haji_events", { sinceSeq: 0 }));
  assert.ok(first.events.length > 0);
  assert.equal(first.lastSeq, server.lastSeq);
  const types = first.events.map((event) => event.type);
  assert.ok(types.includes("turn_start"));
  assert.ok(types.includes("turn_end"));

  const second = parseContent(await callTool(server, "haji_events", { sinceSeq: first.lastSeq }));
  assert.equal(second.events.length, 0);
  assert.equal(second.truncated, false);
});

test("事件 seq 单调递增且 turn_end 带用量", async () => {
  const { server } = createServer();
  await callTool(server, "haji_send", { text: "hi" });
  const events = server.history(0).events;
  for (let index = 1; index < events.length; index++) {
    assert.ok(events[index].seq > events[index - 1].seq);
  }
  const end = events.find((event) => event.type === "turn_end");
  assert.equal(end.ok, true);
  assert.equal(end.text, "echo:hi");
  assert.equal(end.model, "test-model");
});

test("haji_wait 在回合结束时提前返回", async () => {
  const { server } = createServer();
  const pending = server.send("跑一个任务", 1000);
  const waited = await server.wait(0, 1000);
  assert.ok(waited.events.some((event) => event.type === "turn_end"));
  assert.equal(waited.running, false);
  await pending;
});

test("selection_request 挂起，haji_approve 后恢复", async () => {
  const { server } = createServer();
  const pending = server.requestSelection({
    title: "需要授权 · 主 Agent 请求运行命令",
    items: [
      { value: "once", label: "仅本次允许" },
      { value: "deny", label: "拒绝" },
    ],
    selectedValue: "once",
  });

  const request = server.history(0).events.find((event) => event.type === "selection_request");
  assert.ok(request, "应发出 selection_request 事件");
  assert.equal(request.title, "需要授权 · 主 Agent 请求运行命令");

  const approved = parseContent(
    await callTool(server, "haji_approve", { requestId: request.requestId, value: "deny" }),
  );
  assert.equal(approved.accepted, true);

  const answer = await pending;
  assert.equal(answer.value, "deny");
  assert.deepEqual(server.pendingSelectionIds(), []);
});

test("approval=auto 直接采用默认选项且不发事件", async () => {
  const { server } = createServer({ approval: "auto" });
  const answer = await server.requestSelection({
    title: "需要授权",
    items: [{ value: "once", label: "允许" }],
    selectedValue: "once",
  });
  assert.equal(answer.value, "once");
  assert.equal(
    server.history(0).events.some((event) => event.type === "selection_request"),
    false,
  );
});

test("haji_approve 对不存在的请求返回 accepted=false", async () => {
  const { server } = createServer();
  const payload = parseContent(
    await callTool(server, "haji_approve", { requestId: "p404", value: "once" }),
  );
  assert.equal(payload.accepted, false);
});

test("haji_adjust 校验并下发补丁", async () => {
  const { server } = createServer();
  const ok = parseContent(
    await callTool(server, "haji_adjust", {
      model: "deepseek-chat",
      effort: "high",
      permissionMode: "accept-edit",
    }),
  );
  assert.deepEqual(ok.applied, {
    model: "deepseek-chat",
    effort: "high",
    permissionMode: "accept-edit",
  });

  const bad = await callTool(server, "haji_adjust", { effort: "turbo" });
  assert.equal(bad.result.isError, true);
});

test("buildPatch 拒绝非法枚举值", () => {
  assert.deepEqual(buildPatch({ plan: true }).patch, { plan: true });
  assert.equal(buildPatch({ permissionMode: "root" }).errors.length, 1);
  assert.equal(buildPatch({ thinkingVisible: "yes" }).errors.length, 1);
});

test("haji_status 合并运行时状态", async () => {
  const { server } = createServer();
  const status = parseContent(await callTool(server, "haji_status"));
  assert.equal(status.sessionId, "s1");
  assert.equal(status.running, false);
  assert.equal(typeof status.lastSeq, "number");
  assert.deepEqual(status.pendingSelections, []);
});

test("haji_cancel 转发到 host", async () => {
  const { server } = createServer();
  const payload = parseContent(await callTool(server, "haji_cancel"));
  assert.equal(payload.cancelled, true);
});

test("关闭时释放挂起的选择请求", async () => {
  const { server } = createServer();
  const pending = server.requestSelection({
    title: "需要授权",
    items: [{ value: "once", label: "允许" }],
    selectedValue: "once",
  });
  await server.close();
  const answer = await pending;
  assert.equal(answer.value, "once");
  assert.deepEqual(server.pendingSelectionIds(), []);
});

const PERMISSION_CARD = {
  title: "需要授权",
  items: [
    { value: "once", label: "允许" },
    { value: "deny", label: "拒绝" },
    { value: "deny-reason", label: "拒绝并说明…" },
  ],
  selectedValue: "once",
  fallbackValue: "deny",
  autoValue: "once",
};

test("授权卡片超时按 fallbackValue（拒绝）处理，而不是界面默认项", async () => {
  const { server } = createServer({ selectionTimeoutMs: 20 });
  // 服务端计时器是 unref 的，测试里另挂一个保活计时器，免得事件循环提前退出。
  const keepAlive = setTimeout(() => {}, 1000);
  const answer = await server
    .requestSelection(PERMISSION_CARD)
    .finally(() => clearTimeout(keepAlive));
  assert.equal(answer.value, "deny");
  const events = server.history(0).events;
  const request = events.find((event) => event.type === "selection_request");
  assert.equal(request.default.value, "deny", "事件里的 default 应如实告知兜底值");
  const resolved = events.find((event) => event.type === "selection_resolved");
  assert.equal(resolved.timedOut, true);
  assert.equal(resolved.value, "deny");
});

test("关闭服务时挂起的授权卡片按拒绝结案", async () => {
  const { server } = createServer();
  const pending = server.requestSelection(PERMISSION_CARD);
  await server.close();
  assert.equal((await pending).value, "deny");
});

test("approval=auto 只采用 autoValue；没声明的请求按 fallbackValue 拒绝", async () => {
  const { server } = createServer({ approval: "auto" });
  assert.equal((await server.requestSelection(PERMISSION_CARD)).value, "once");
  const escalation = await server.requestSelection({
    title: "Agent 申请 · 加入工作区根",
    items: [
      { value: "approve", label: "批准" },
      { value: "deny", label: "拒绝" },
    ],
    fallbackValue: "deny",
  });
  assert.equal(escalation.value, "deny", "提级申请不能被 auto 自动批准");
});

test("haji_approve 校验选项值，并把 reason 交给调用方", async () => {
  const { server } = createServer();
  const pending = server.requestSelection(PERMISSION_CARD);
  const request = server.history(0).events.find((event) => event.type === "selection_request");

  const bad = await callTool(server, "haji_approve", { requestId: request.requestId, value: "y" });
  assert.equal(bad.result.isError, true);
  assert.equal(parseContent(bad).accepted, false);
  assert.deepEqual(server.pendingSelectionIds(), [request.requestId], "非法值不应结案");

  const badSecondary = parseContent(
    await callTool(server, "haji_approve", {
      requestId: request.requestId,
      value: "once",
      secondaryValue: "global",
    }),
  );
  assert.equal(badSecondary.accepted, false, "没有 secondary 的请求不接受 secondaryValue");

  const ok = parseContent(
    await callTool(server, "haji_approve", {
      requestId: request.requestId,
      value: "deny-reason",
      reason: "  先跑测试  ",
    }),
  );
  assert.equal(ok.accepted, true);
  assert.deepEqual(await pending, { value: "deny-reason", reason: "先跑测试" });
});
