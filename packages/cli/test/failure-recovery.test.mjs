import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repairToolCallPairs, SessionManager } from "@hajicli/core";
import { OpenAICompatibleProvider } from "../../plugins/dist/openai-compatible.js";
import { recoveryHarness } from "./helpers/recovery-harness.mjs";

const event = (delta, finish_reason) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;

for (const failure of ["socket-reset", "early-eof"]) {
  test(`网络 ${failure} 后保存部分回复，恢复后继续`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-network-recovery-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let requests = 0;
    let nextMessages;
    let breakConnection;
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requests === 1) {
        breakConnection = () => (failure === "socket-reset" ? res.destroy() : res.end());
        res.write(event({ reasoning_content: "已确认第一步" }));
        res.write(event({ content: "已经完成的部分" }));
      } else {
        nextMessages = JSON.parse(body).messages;
        res.end(`${event({ content: "继续完成" }, "stop")}data: [DONE]\n\n`);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-only",
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      defaultModel: "test",
    });
    const wrapped = {
      async *completeStream(messages, options) {
        for await (const chunk of provider.completeStream(messages, options)) {
          yield chunk;
          // 确保终端收到正文之后才断开真实本地 HTTP 连接。
          if (requests === 1) breakConnection();
        }
      },
    };
    const manager = new SessionManager(dir);
    const first = recoveryHarness(manager, wrapped);
    let finished = 0;
    first.deps.onTurnFinished = () => finished++;
    await first.run();
    await manager.flush();
    assert.equal(finished, 0, "提前结束不能报告本轮完成");
    assert.equal(requests, 1, "已产生部分输出后不自动重放请求");
    const restored = new SessionManager(dir);
    assert.ok(restored.loadSession(manager.getCurrentSession().id));
    const partial = restored.getCurrentSession().messages.find((m) => m.role === "assistant");
    assert.equal(partial?.content, "已经完成的部分");
    assert.equal(partial?.reasoning_content, "已确认第一步");
    assert.equal(partial?.tool_calls, undefined);
    await recoveryHarness(restored, provider).run();
    await restored.flush();
    assert.ok(nextMessages.some((m) => m.content === "已经完成的部分"));
    assert.equal(restored.getCurrentSession().messages.at(-1).content, "继续完成");
  });
}

test("HTTP 503 在收到正文前自动重试且只提交一次用户输入", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-http-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* 消费请求体，允许连接复用。 */
    }
    if (++requests === 1) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`${event({ content: "重试成功" }, "stop")}data: [DONE]\n\n`);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const manager = new SessionManager(dir);
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-only",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    defaultModel: "test",
  });
  const harness = recoveryHarness(manager, provider);
  await harness.run();
  const restored = new SessionManager(dir);
  assert.ok(restored.loadSession(manager.getCurrentSession().id));
  assert.equal(requests, 2);
  assert.equal(restored.getCurrentSession().messages.filter((m) => m.role === "user").length, 1);
  assert.equal(restored.getCurrentSession().messages.at(-1).content, "重试成功");
});

for (const boundary of ["second-tool", "next-request", "turn-finished"]) {
  test(`强杀进程 ${boundary} 边界后恢复已完成进度`, { timeout: 15000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-crash-recovery-"));
    const child = fork(
      new URL("./helpers/crash-turn-child.mjs", import.meta.url),
      [dir, boundary],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill("SIGKILL");
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message),
      exited.then(() => {
        throw new Error(`子进程提前退出: ${stderr}`);
      }),
    ]);
    child.kill("SIGKILL");
    await exited;
    const restored = new SessionManager(dir);
    assert.ok(restored.loadSession(ready.id));
    const stored = restored.getCurrentSession();
    assert.ok(
      stored.messages.some((m) => m.tool_call_id === "first" && m.content === "first 已完成"),
    );
    assert.equal(stored.goal?.text, "完成两步操作");
    assert.equal(stored.usage?.lastTurnMs, 42);
    if (boundary === "turn-finished") assert.equal(stored.messages.at(-1).content, "全部完成");
    let resumedMessages;
    const harness = recoveryHarness(
      restored,
      {
        async *completeStream(messages, options) {
          options.onRequestStart?.();
          resumedMessages = structuredClone(messages);
          yield "已核实进度";
        },
      },
      async () => {
        assert.fail("恢复不能自动执行历史工具");
      },
    );
    // 模拟自动压缩先做默认配对清理，恢复结果必须在此之前补齐。
    harness.deps.hookEngine.trigger = async (name, context) => {
      if (name === "UserPromptSubmit") context.messages = repairToolCallPairs(context.messages);
    };
    await harness.run();
    await restored.flush();
    assert.ok(
      resumedMessages.some((m) => m.tool_call_id === "first" && m.content === "first 已完成"),
    );
    const second = resumedMessages.find((m) => m.tool_call_id === "second");
    assert.ok(second);
    if (boundary === "second-tool") assert.match(second.content, /状态未知/);
    else assert.equal(second.content, "second 已完成");
  });
}
