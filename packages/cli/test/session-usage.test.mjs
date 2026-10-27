import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@hajicli/core";

import { CostTracker } from "../dist/cost-tracker.js";

const MESSAGES = [
  { role: "system", content: "系统提示" },
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好，有什么可以帮你？" },
];

const USAGE = {
  costRecords: [
    {
      model: "deepseek-chat",
      purpose: "主线回合",
      at: 1_700_000_000_000,
      promptTokens: 120,
      cachedPromptTokens: 20,
      completionTokens: 30,
    },
  ],
  compactionCount: 2,
  lastTurnMs: 4321,
};

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "haji-session-usage-"));
}

test("会话用量随会话文件落盘，loadSession 后能还原", async () => {
  const dir = makeTempDir();
  const writer = new SessionManager(dir);
  const id = writer.getCurrentSession().id;

  writer.saveCurrentSession(MESSAGES);
  writer.setUsage(USAGE);
  // 消息没变、只有用量变了，也必须写盘（/compact 后会走到这里）。
  writer.saveCurrentSession(MESSAGES);
  await writer.flush();

  const loaded = new SessionManager(dir).loadSession(id);
  assert.ok(loaded);
  assert.deepEqual(loaded.usage, USAGE);
});

test("老会话文件没有 usage 字段时按缺省处理，不报错", async () => {
  const dir = makeTempDir();
  const writer = new SessionManager(dir);
  const id = writer.getCurrentSession().id;
  writer.saveCurrentSession(MESSAGES);
  await writer.flush();

  const filePath = path.join(dir, `session_${id}.json`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.usage;
  fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");

  const loaded = new SessionManager(dir).loadSession(id);
  assert.ok(loaded);
  assert.equal(loaded.usage, undefined);
});

test("新会话不继承上一个会话的用量", () => {
  const dir = makeTempDir();
  const manager = new SessionManager(dir);
  manager.saveCurrentSession(MESSAGES);
  manager.setUsage(USAGE);
  const previousId = manager.getCurrentSession().id;
  const fresh = manager.startNewSession();
  assert.equal(fresh.usage, undefined);
  assert.notEqual(fresh.id, previousId);
});

test("CostTracker 能把会话记账装回来，清空后归零", () => {
  const tracker = new CostTracker(() => undefined);
  assert.equal(tracker.getSummary().requests, 0);

  tracker.loadRecords([
    {
      model: "deepseek-chat",
      purpose: "主线回合",
      at: 1_700_000_000_000,
      promptTokens: 100,
      // provider 上报的命中数可能大于输入数：装载时夹逼，别让费用算成负数。
      cachedPromptTokens: 200,
      completionTokens: 10,
    },
  ]);
  const summary = tracker.getSummary();
  assert.equal(summary.requests, 1);
  assert.equal(summary.promptTokens, 100);
  assert.equal(summary.cachedPromptTokens, 100);
  assert.equal(tracker.getRecords().length, 1);

  tracker.loadRecords(undefined);
  assert.equal(tracker.getSummary().requests, 0);
  assert.equal(tracker.getSummary().promptTokens, 0);
});

// /resume 与 /clear 的侧栏同步是 index.ts 里注入的实现，这里守着接线不被改回去。
const sessionCommandSource = fs.readFileSync(
  new URL("../src/session-commands.ts", import.meta.url),
  "utf8",
);
const indexSource = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("/resume 恢复历史会话后把用量同步到侧栏，/clear 归零", () => {
  assert.match(sessionCommandSource, /ctx\.applySessionUsage\(loaded\.usage\)/);
  assert.match(sessionCommandSource, /ctx\.applySessionUsage\(undefined\)/);
});

test("applySessionUsage 真的把费用明细灌回 CostTracker", () => {
  assert.match(indexSource, /costTracker\.loadRecords\(usage\?\.costRecords\)/);
  assert.match(indexSource, /ui\.setSessionMetrics\(/);
});

test("setSearchDirs 跨目录发现会话，loadSession 命中后主目录跟着切换", async () => {
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  const writer = new SessionManager(dirA);
  const id = writer.getCurrentSession().id;
  writer.saveCurrentSession(MESSAGES, "跨树会话");
  await writer.flush();

  // 另一棵树里的进程：把 dirA 并进检索范围后能看到并装载它。
  const reader = new SessionManager(dirB);
  reader.setSearchDirs([dirA]);
  assert.deepEqual(
    reader.listSessions().map((s) => s.title),
    ["跨树会话"],
  );
  assert.equal(path.resolve(reader.locateSessionDir(id) ?? ""), path.resolve(dirA));

  const loaded = reader.loadSession(id);
  assert.ok(loaded);
  // 主目录切到会话原目录：后续保存写回原处，不会在两棵树里各存一份。
  assert.equal(path.resolve(reader.getSessionsDir()), path.resolve(dirA));
  reader.saveCurrentSession([...MESSAGES, { role: "user", content: "继续" }]);
  await reader.flush();
  assert.ok(fs.readdirSync(dirA).some((file) => file.startsWith("session_")));
  const forked = fs
    .readdirSync(dirB)
    .filter((file) => file.startsWith("session_") && file.endsWith(".json"));
  assert.deepEqual(forked, [], "不应在旧主目录分叉出新会话文件");
});

test("同一会话 id 出现在多个目录时按 updatedAt 取最新", () => {
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  const id = "11111111-2222-3333-4444-555555555555";
  const copies = [
    [dirA, "旧副本", "2025-01-01T00:00:00.000Z"],
    [dirB, "新副本", "2025-06-01T00:00:00.000Z"],
  ];
  for (const [dir, title, updatedAt] of copies) {
    fs.writeFileSync(
      path.join(dir, `session_${id}.json`),
      JSON.stringify({
        id,
        title,
        createdAt: updatedAt,
        updatedAt,
        messages: MESSAGES,
      }),
    );
  }
  const mgr = new SessionManager(dirA);
  mgr.setSearchDirs([dirB]);
  const list = mgr.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "新副本");
});

test("扩展记账字段（耗时/推理 token/用户问题）随会话文件落盘并原样读回", async () => {
  const dir = makeTempDir();
  const writer = new SessionManager(dir);
  const id = writer.getCurrentSession().id;

  const tracker = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  tracker.beginTurn("帮我看看返回按钮为什么点不到");
  tracker.record(
    "deepseek-chat",
    { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    "主线回合",
    1_700_000_000_000,
    {
      durationMs: 4200,
      reasoningTokens: 820,
      turnPrompt: "帮我看看返回按钮为什么点不到",
    },
  );
  tracker.record(
    "deepseek-chat",
    { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
    "标题生成",
    1_700_000_001_000,
    {
      durationMs: 300,
      reasoningTokens: 0,
    },
  );

  writer.saveCurrentSession(MESSAGES);
  writer.setUsage({ costRecords: tracker.getRecords(), compactionCount: 0, lastTurnMs: 4500 });
  writer.saveCurrentSession(MESSAGES);
  await writer.flush();

  // 落盘文件里必须真的带着这几个字段，而不是只活在内存里。
  const raw = JSON.parse(fs.readFileSync(path.join(dir, `session_${id}.json`), "utf8"));
  assert.equal(raw.usage.costRecords[0].durationMs, 4200);
  assert.equal(raw.usage.costRecords[0].reasoningTokens, 820);
  assert.equal(raw.usage.costRecords[0].turnPrompt, "帮我看看返回按钮为什么点不到");
  assert.equal(raw.usage.costRecords[1].turnPrompt, undefined, "同一轮后续请求不重复存问题");

  // /resume 路径：重新加载后交给 tracker，页面就能显示真实耗时。
  const loaded = new SessionManager(dir).loadSession(id);
  const restored = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  restored.loadRecords(loaded.usage.costRecords);
  const details = restored.getRequestDetails();
  assert.equal(details[0].durationMs, 4200);
  assert.equal(details[0].reasoningTokens, 820);
  assert.equal(details[0].turnPrompt, "帮我看看返回按钮为什么点不到");
  assert.equal(details[1].durationMs, 300);
});
