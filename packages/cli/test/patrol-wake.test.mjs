import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isPatrolWakeEventName,
  normalizePatrolLimits,
  PatrolStore,
  parseWakePayload,
} from "@hajicli/core";
import { PatrolService } from "../dist/patrol/service.js";
import { createSmeeWakeSource } from "../dist/patrol/wake.js";

const REPO = "owner/repo";

function tmpDir(prefix = "haji-patrol-wake-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- 载荷解析 ----

test("parseWakePayload：smee 把 header 平铺在顶层", () => {
  const raw = JSON.stringify({
    query: {},
    body: {
      action: "synchronize",
      pull_request: { number: 7 },
      repository: { full_name: REPO },
    },
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-1",
  });
  const event = parseWakePayload(raw, "2026-01-01T00:00:00.000Z");
  assert.equal(event.event, "pull_request");
  assert.equal(event.action, "synchronize");
  assert.equal(event.prNumber, 7);
  assert.equal(event.repo, REPO);
  assert.equal(event.deliveryId, "delivery-1");
  assert.equal(event.receivedAt, "2026-01-01T00:00:00.000Z");
});

test("parseWakePayload：{headers, body} 信封与大写 header 也认", () => {
  const raw = JSON.stringify({
    headers: { "X-GitHub-Event": "pull_request_review", "X-GitHub-Delivery": "d-2" },
    body: { action: "submitted", pull_request: { number: 12 } },
  });
  const event = parseWakePayload(raw);
  assert.equal(event.event, "pull_request_review");
  assert.equal(event.action, "submitted");
  assert.equal(event.prNumber, 12);
  assert.equal(event.deliveryId, "d-2");
});

test("parseWakePayload：PR 编号从 check_suite / issue_comment 的各自位置取", () => {
  const check = parseWakePayload(
    JSON.stringify({
      body: { action: "completed", check_suite: { pull_requests: [{ number: 31 }] } },
      "x-github-event": "check_suite",
    }),
  );
  assert.equal(check.prNumber, 31);

  const comment = parseWakePayload(
    JSON.stringify({
      body: { action: "created", issue: { number: 44 }, comment: { id: 1 } },
      "x-github-event": "issue_comment",
    }),
  );
  assert.equal(comment.prNumber, 44);
});

test("parseWakePayload：不相关事件 / 缺 header / 坏 JSON 都返回 undefined", () => {
  assert.equal(
    parseWakePayload(JSON.stringify({ body: {}, "x-github-event": "star" })),
    undefined,
    "白名单外的事件不该唤醒巡检",
  );
  assert.equal(parseWakePayload(JSON.stringify({ body: {} })), undefined);
  assert.equal(parseWakePayload("{not json"), undefined);
  assert.equal(parseWakePayload("[]"), undefined);
});

test("isPatrolWakeEventName：覆盖巡检关心的五类事件", () => {
  for (const name of [
    "pull_request",
    "pull_request_review",
    "check_suite",
    "workflow_run",
    "issue_comment",
  ]) {
    assert.equal(isPatrolWakeEventName(name), true, name);
  }
  assert.equal(isPatrolWakeEventName("push"), false);
  assert.equal(isPatrolWakeEventName("star"), false);
});

// ---- SSE 唤醒源 ----

/** 极简 SSE 服务：连上后回 `event: ready`，之后由测试逐条 push。 */
async function sseServer() {
  const clients = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("event: ready\n\n");
    clients.add(res);
    res.on("close", () => clients.delete(res));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/events`,
    /** 等到至少一个客户端连上，避免测试在连接建立前 push。 */
    async connected() {
      for (let i = 0; i < 200; i += 1) {
        if (clients.size > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("SSE 客户端没有连上");
    },
    push(payload) {
      for (const res of clients) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    async close() {
      for (const res of clients) res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function pullRequestPayload(deliveryId, number = 9) {
  return {
    query: {},
    body: { action: "opened", pull_request: { number }, repository: { full_name: REPO } },
    "x-github-event": "pull_request",
    "x-github-delivery": deliveryId,
  };
}

test("唤醒源：事件到达即返回，不等超时", async () => {
  const server = await sseServer();
  const wake = createSmeeWakeSource(server.url);
  const controller = new AbortController();
  try {
    const pending = wake.wait(controller.signal, 5_000);
    await server.connected();
    const startedAt = Date.now();
    server.push(pullRequestPayload("d-1"));
    const event = await pending;
    assert.equal(event.event, "pull_request");
    assert.equal(event.prNumber, 9);
    assert.ok(Date.now() - startedAt < 1_000, "应当被事件唤醒，而不是等满 5s 超时");
  } finally {
    wake.close();
    await server.close();
  }
});

test("唤醒源：没有事件时按超时返回 null", async () => {
  const server = await sseServer();
  const wake = createSmeeWakeSource(server.url);
  const controller = new AbortController();
  try {
    const startedAt = Date.now();
    const event = await wake.wait(controller.signal, 80);
    const elapsed = Date.now() - startedAt;
    assert.equal(event, null);
    assert.ok(elapsed >= 60, `应按超时返回（实际 ${elapsed}ms）`);
  } finally {
    wake.close();
    await server.close();
  }
});

test("唤醒源：同一 deliveryId 重投只唤醒一次", async () => {
  const server = await sseServer();
  const wake = createSmeeWakeSource(server.url);
  const controller = new AbortController();
  try {
    const first = wake.wait(controller.signal, 5_000);
    await server.connected();
    server.push(pullRequestPayload("d-same"));
    assert.equal((await first).deliveryId, "d-same");

    server.push(pullRequestPayload("d-same"));
    assert.equal(await wake.wait(controller.signal, 120), null, "重投应被去重，不重复唤醒");
  } finally {
    wake.close();
    await server.close();
  }
});

test("唤醒源：白名单外的事件不唤醒", async () => {
  const server = await sseServer();
  const wake = createSmeeWakeSource(server.url);
  const controller = new AbortController();
  try {
    const pending = wake.wait(controller.signal, 150);
    await server.connected();
    server.push({ query: {}, body: { action: "created" }, "x-github-event": "star" });
    assert.equal(await pending, null, "star 事件不该叫醒巡检");
  } finally {
    wake.close();
    await server.close();
  }
});

test("唤醒源：close 之后 wait 立即返回 null", async () => {
  const server = await sseServer();
  const wake = createSmeeWakeSource(server.url);
  const controller = new AbortController();
  try {
    wake.close();
    assert.equal(await wake.wait(controller.signal, 5_000), null);
  } finally {
    await server.close();
  }
});

test("唤醒源：中止信号也能结束等待", async () => {
  const server = await sseServer();
  const wake = createSmeeWakeSource(server.url);
  const controller = new AbortController();
  try {
    const pending = wake.wait(controller.signal, 5_000);
    controller.abort();
    assert.equal(await pending, null);
  } finally {
    wake.close();
    await server.close();
  }
});

// ---- runLoop 接入 ----

function countingForge() {
  const forge = {
    repo: REPO,
    calls: 0,
    async listOpenPullRequests() {
      forge.calls += 1;
      return [];
    },
    async getPullRequest() {
      return null;
    },
    async listCheckRuns() {
      return [];
    },
    async getDiff() {
      return "";
    },
    async postStatusComment() {},
    async merge() {
      return { merged: true };
    },
    async close() {},
  };
  return forge;
}

const idleRunners = {
  review: async () => ({ verdict: "pass", findings: [], summary: "" }),
  fix: async () => ({ status: "failed", summary: "" }),
  adjudicate: async () => ({
    verdict: "terminate",
    reasons: [],
    rejectedFindingIds: [],
    orders: [],
    acceptance: [],
    summary: "",
  }),
};

function buildService(forge, pollIntervalMs) {
  const cwd = tmpDir();
  return new PatrolService({
    cwd,
    store: new PatrolStore(path.join(cwd, ".haji", "patrol")),
    adapter: forge,
    runners: idleRunners,
    config: {
      repo: REPO,
      requiredChecks: [],
      trustedApps: ["github-actions"],
      limits: normalizePatrolLimits(),
      pollIntervalMs,
    },
  });
}

test("runLoop：空闲退避被唤醒事件提前打断", async () => {
  const forge = countingForge();
  const service = buildService(forge, 5_000);
  const controller = new AbortController();
  let woke = 0;
  const wake = {
    url: "fake://wake",
    async wait() {
      // 第一次立刻给事件，之后按「短超时」返回 null，模拟通道空闲。
      if (woke === 0) {
        woke += 1;
        return { event: "pull_request", action: "opened", prNumber: 9, receivedAt: "" };
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      return null;
    },
    close() {},
  };
  const loop = service.runLoop(controller.signal, { idleBackoffCapMs: 5_000, wake });
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await loop;
  // 纯轮询在 5s 间隔下 200ms 内只会有 1 次；被唤醒后应明显更多。
  assert.ok(forge.calls >= 3, `唤醒后应立即复查（实际 ${forge.calls} 次）`);
});

test("runLoop：没有唤醒源时保持纯轮询", async () => {
  const forge = countingForge();
  const service = buildService(forge, 5_000);
  const controller = new AbortController();
  const loop = service.runLoop(controller.signal, { idleBackoffCapMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await loop;
  assert.equal(forge.calls, 1, "5s 间隔下 200ms 内只该跑一轮");
});

test("runLoop：唤醒源抛错时退回轮询，不中断巡检", async () => {
  const forge = countingForge();
  const service = buildService(forge, 50);
  const controller = new AbortController();
  const wake = {
    url: "fake://broken",
    async wait() {
      throw new Error("通道炸了");
    },
    close() {},
  };
  const loop = service.runLoop(controller.signal, { idleBackoffCapMs: 50, wake });
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await loop;
  assert.ok(forge.calls >= 2, "唤醒源故障必须退化为轮询继续干活");
});
