import assert from "node:assert/strict";
import test from "node:test";

import { CostTracker, truncateTurnPrompt } from "../dist/cost-tracker.js";

/**
 * 扩展记账字段（durationMs / reasoningTokens / turnPrompt）：
 * 写入、按轮只落一次、会话文件往返，以及老会话缺字段时的表现。
 */
const AT = Date.parse("2025-01-02T03:04:05Z");

function usage(prompt, completion, cached = 0) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_cache_hit_tokens: cached } : {}),
  };
}

test("record 写入耗时/推理 token；用户问题只落在每轮第一条记录上", () => {
  const tracker = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  tracker.beginTurn("帮我看看返回按钮为什么点不到");
  tracker.record("m", usage(1000, 200), "主线回合", AT, {
    durationMs: 4200,
    reasoningTokens: 820,
    turnPrompt: "帮我看看返回按钮为什么点不到",
  });
  tracker.record("m", usage(1200, 300), "主线回合", AT + 1000, {
    durationMs: 1500,
    reasoningTokens: 100,
    turnPrompt: "帮我看看返回按钮为什么点不到",
  });

  const records = tracker.getRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].durationMs, 4200);
  assert.equal(records[0].reasoningTokens, 820);
  assert.equal(records[0].turnPrompt, "帮我看看返回按钮为什么点不到");
  assert.equal(records[1].durationMs, 1500);
  assert.equal(records[1].reasoningTokens, 100);
  assert.equal(records[1].turnPrompt, undefined, "同一轮的第二条不重复存问题");
  assert.equal(records[0].turn, records[1].turn, "两条属于同一轮");
});

test("第二轮的第一条又带上新的用户问题", () => {
  const tracker = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  tracker.beginTurn("第一个问题");
  tracker.record("m", usage(1000, 200), "主线回合", AT, { turnPrompt: "第一个问题" });
  tracker.beginTurn("第二个问题");
  tracker.record("m", usage(1000, 200), "主线回合", AT + 5000, { turnPrompt: "第二个问题" });
  const records = tracker.getRecords();
  assert.equal(records[0].turnPrompt, "第一个问题");
  assert.equal(records[1].turnPrompt, "第二个问题");
  assert.equal(records[1].turn, 2);
});

test("getRequestDetails 透传新字段，缺失时保持 undefined（页面显示 —）", () => {
  const tracker = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  tracker.beginTurn("问题");
  tracker.record("m", usage(1000, 200), "主线回合", AT, {
    durationMs: 900,
    reasoningTokens: 40,
    turnPrompt: "问题",
  });
  tracker.record("m", usage(1000, 200), "标题生成", AT + 10);

  const details = tracker.getRequestDetails();
  assert.equal(details[0].durationMs, 900);
  assert.equal(details[0].reasoningTokens, 40);
  assert.equal(details[0].turnPrompt, "问题");
  assert.equal(details[1].durationMs, undefined, "没传就是缺省，不能变成 0");
  assert.equal(details[1].reasoningTokens, undefined);
  assert.equal(details[1].turnPrompt, undefined);
});

test("会话文件往返：新字段写进去、读回来还在", () => {
  const tracker = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  tracker.beginTurn("往返测试\n第二行");
  tracker.record("m", usage(1000, 200), "主线回合", AT, {
    durationMs: 2500,
    reasoningTokens: 300,
    turnPrompt: "往返测试\n第二行",
  });
  const saved = tracker.getRecords();

  const restored = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  restored.loadRecords(saved);
  const records = restored.getRecords();
  assert.equal(records[0].durationMs, 2500);
  assert.equal(records[0].reasoningTokens, 300);
  assert.equal(records[0].turnPrompt, "往返测试 第二行", "压成单行存");
});

test("老会话（没有新字段）读回来不报错，页面据此显示 —", () => {
  const tracker = new CostTracker(() => ({ inputPerMTokens: 2, outputPerMTokens: 8 }));
  tracker.loadRecords([
    {
      model: "m",
      purpose: "主线回合",
      turn: 3,
      at: AT,
      promptTokens: 1000,
      cachedPromptTokens: 0,
      completionTokens: 200,
    },
  ]);
  const detail = tracker.getRequestDetails()[0];
  assert.equal(detail.turn, 3);
  assert.equal(detail.durationMs, undefined);
  assert.equal(detail.reasoningTokens, undefined);
  assert.equal(detail.turnPrompt, undefined);
});

test("truncateTurnPrompt 压单行并截断，空串不产生问题文本", () => {
  assert.equal(truncateTurnPrompt("  多行\n文本\t带空白  "), "多行 文本 带空白");
  const long = "问".repeat(200);
  const cut = truncateTurnPrompt(long, 20);
  assert.equal([...cut].length, 20, "长度上限含省略号");
  assert.ok(cut.endsWith("…"));
  assert.equal(truncateTurnPrompt("   "), "");
});
