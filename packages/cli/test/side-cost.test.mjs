import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DistillEngine, SubagentRunner } from "@hajicli/core";
import { CostTracker } from "../dist/cost-tracker.js";

/**
 * 主线以外的模型调用（子代理、压缩、标题、提炼、权限判定、查价）同样要进 /cost。
 * 之前只有主线回合与网页检索记账，子代理多的会话花费明显偏低。
 */
const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const readSrc = (name) => fs.readFileSync(path.join(srcDir, name), "utf8");

const usage = (prompt, completion, cached) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  ...(cached !== undefined ? { prompt_cache_hit_tokens: cached } : {}),
});

test("杂活先于主线记账：归到同一轮，问题摘要仍落在主线那条上", () => {
  const tracker = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  tracker.beginTurn();
  tracker.record("cheap", usage(300, 20), "会话标题", 1000, { provider: "deepseek" });
  tracker.record("main", usage(1000, 200), "主线回合", 2000, { turnPrompt: "修一下登录" });
  tracker.record("main", usage(1200, 100), "子代理", 3000, { provider: "deepseek" });
  const records = tracker.getRecords();
  assert.deepEqual(
    records.map((record) => record.turn),
    [1, 1, 1],
  );
  assert.equal(records[0].turnPrompt, undefined);
  assert.equal(records[1].turnPrompt, "修一下登录", "杂活不能把本轮的问题摘要位置占掉");
  assert.equal(records[2].turnPrompt, undefined);
  assert.equal(tracker.getSummary().requests, 3, "杂活请求计入总请求数");
});

test("子代理 usage 事件带上模型、渠道与缓存命中，估算值标记为未上报", async () => {
  const events = [];
  const runner = new SubagentRunner({
    cwd: process.cwd(),
    getProvider: () => ({
      async *completeStream(_messages, options) {
        options.onUsage?.(usage(900, 100, 600));
        yield '{"summary":"done"}';
      },
    }),
    getModel: (request) => request?.model || "sub-model",
    getReasoningEffort: () => "low",
    getTools: () => [],
    executeTool: async () => "",
    onEvent: (event) => events.push(event),
  });
  await runner.runResult({ description: "调研", provider: "volcengine", maxTokens: 10_000 });
  const reported = events.find((event) => event.type === "usage");
  assert.equal(reported.model, "sub-model");
  assert.equal(reported.provider, "volcengine");
  assert.equal(reported.reported, true);
  assert.equal(reported.usage.prompt_cache_hit_tokens, 600, "缓存命中要透传，否则按全价高估");

  const estimatedEvents = [];
  const estimating = new SubagentRunner({
    cwd: process.cwd(),
    getProvider: () => ({
      async *completeStream() {
        yield '{"summary":"done"}';
      },
    }),
    getModel: () => "sub-model",
    getReasoningEffort: () => "low",
    getTools: () => [],
    executeTool: async () => "",
    onEvent: (event) => estimatedEvents.push(event),
  });
  await estimating.runResult({ description: "调研", maxTokens: 10_000 });
  const estimated = estimatedEvents.find((event) => event.type === "usage");
  assert.equal(estimated.reported, false, "本地估算只用于预算，不能当账单");
  assert.equal(estimated.provider, undefined);
});

test("经验提炼的 LLM 调用经 onUsage 回报模型与用量", async () => {
  const seen = [];
  const engine = new DistillEngine({
    store: { evolveInstincts: async () => ({ reinforced: new Set() }) },
    provider: () => ({
      complete: async (_messages, options) => {
        options.onUsage?.(usage(500, 50));
        return '{"instincts":[],"memories":[]}';
      },
    }),
    model: () => "cheap-model",
    onUsage: (model, reportedUsage) => seen.push({ model, total: reportedUsage.total_tokens }),
  });
  await engine.runDistill(
    Array.from({ length: 20 }, () => ({
      ts: new Date().toISOString(),
      sessionId: "s",
      toolName: "bash",
      args: {},
      output: "执行出错",
      failed: true,
    })),
    { messages: [], cwd: ".", sessionId: "s" },
  );
  assert.deepEqual(seen, [{ model: "cheap-model", total: 550 }]);
});

test("每个杂活调用点都接上了记账", () => {
  const index = readSrc("index.ts");
  for (const purpose of ["上下文压缩", "权限判定", "经验提炼"]) {
    assert.ok(index.includes(`utilityCall("${purpose}")`), `${purpose} 走 utilityCall 记账`);
  }
  assert.match(index, /recordSideCost\(\s*"子代理"/, "子代理用量记账");
  assert.match(index, /if \(event\.reported\)/, "子代理只记 provider 上报的用量");
  assert.match(index, /recordSideCost\("经验提炼", model, usage/, "/instinct distill 记账");
  assert.match(readSrc("turn-runner.ts"), /"会话标题"/, "标题生成记账");
  assert.match(readSrc("pricing-commands.ts"), /recordSideCost\("查询单价"/, "查价 agent 记账");
});
