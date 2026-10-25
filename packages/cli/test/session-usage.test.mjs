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
