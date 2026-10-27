import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionMetrics } from "../../../scripts/ab-metrics.mjs";

function writeSession(
  dir,
  id,
  experiments,
  batches,
  subagents = [],
  subagentResults = [],
  toolCalls = [],
  llmCalls = [],
) {
  const lines = [
    JSON.stringify({
      type: "experiment_assignment",
      timestamp: "2026-10-27T00:00:00.000Z",
      data: { timestamp: "2026-10-27T00:00:00.000Z", unitId: id, experiments },
    }),
    ...llmCalls.map((call, index) =>
      JSON.stringify({
        type: "llm_call",
        timestamp: `2026-10-27T00:00:0${index}.500Z`,
        data: { timestamp: `2026-10-27T00:00:0${index}.500Z`, ...call },
      }),
    ),
    ...batches.map((batch, index) =>
      JSON.stringify({
        type: "tool_batch",
        timestamp: `2026-10-27T00:00:0${index + 1}.000Z`,
        data: { timestamp: `2026-10-27T00:00:0${index + 1}.000Z`, ...batch },
      }),
    ),
    ...subagents.map((subagent, index) =>
      JSON.stringify({
        type: "subagent_launch",
        timestamp: `2026-10-27T00:00:1${index}.000Z`,
        data: { timestamp: `2026-10-27T00:00:1${index}.000Z`, ...subagent },
      }),
    ),
    ...subagentResults.map((result, index) =>
      JSON.stringify({
        type: "subagent_result",
        timestamp: `2026-10-27T00:00:2${index}.000Z`,
        data: { timestamp: `2026-10-27T00:00:2${index}.000Z`, ...result },
      }),
    ),
    JSON.stringify({
      type: "user_input",
      timestamp: "2026-10-27T00:00:30.000Z",
      content: "任务",
    }),
    ...toolCalls.map((call, index) =>
      JSON.stringify({
        type: "tool_execution",
        timestamp: `2026-10-27T00:00:3${index}.000Z`,
        data: { timestamp: `2026-10-27T00:00:3${index}.000Z`, ...call },
      }),
    ),
  ];
  fs.writeFileSync(path.join(dir, `session_${id}.events.jsonl`), `${lines.join("\n")}\n`);
}

test("ab-report groups tool batches and subagents by experiment arm", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-ab-report-"));
  const pricingPath = path.join(dir, "pricing.json");
  fs.writeFileSync(
    pricingPath,
    JSON.stringify({
      models: {
        "test-model": { inputPerMTokens: 1, outputPerMTokens: 2, cachedInputPerMTokens: 0.5 },
      },
    }),
  );
  try {
    writeSession(dir, "control-1", { parallel_prompt: "control", parallel_max: "3" }, [
      {
        size: 2,
        names: ["read", "read"],
        parallel: true,
        wallTimeMs: 10,
        serialEstimateMs: 20,
        savedTimeMs: 10,
      },
    ]);
    writeSession(
      dir,
      "treatment-1",
      { parallel_prompt: "batch", parallel_max: "5" },
      [
        {
          size: 4,
          names: ["read", "grep", "global", "read"],
          parallel: true,
          wallTimeMs: 15,
          serialEstimateMs: 45,
          savedTimeMs: 30,
        },
      ],
      [{ agentId: "sub-1", role: "research", access: "readonly", background: false }],
      [
        {
          agentId: "sub-1",
          status: "verified",
          durationMs: 5000,
          totalTokens: 1000,
          toolCalls: 2,
        },
      ],
      [
        {
          name: "read",
          arguments: { paths: ["a.ts", "b.ts"] },
          output: "line\nnextStartLine=41",
        },
        { name: "read", arguments: { paths: ["a.ts", "b.ts"] } },
        { name: "grep", arguments: { queries: ["foo", "bar"] } },
        { name: "global", arguments: { patterns: ["x", "y"] } },
      ],
      [
        {
          model: "test-model",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "任务" },
          ],
          // provider 归一化后只写 prompt_cache_hit_tokens；另外两个字段在 trace 里
          // 通常存在但恒为 0，必须验证不会因为 `??` 命中 0 而丢掉命中数。
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_cache_hit_tokens: 200,
            cache_read_input_tokens: 0,
            cached_tokens: 0,
          },
        },
        {
          model: "test-model",
          messages: [{ role: "user", content: "起个标题" }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        },
      ],
    );
    const output = execFileSync(
      process.execPath,
      ["scripts/ab-report.mjs", "--dir", dir, "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, HAJI_PRICING_PATH: pricingPath },
      },
    );
    const report = JSON.parse(output);
    assert.equal(report.sessionsWithAssignment, 2);
    assert.equal(report.totalBatches, 2);
    const promptRows = report.experiments.parallel_prompt;
    const control = promptRows.find((row) => row.arm === "control");
    const treatment = promptRows.find((row) => row.arm === "batch");
    assert.equal(control.sessions, 1);
    assert.equal(control.avgBatchSize, 2);
    assert.equal(treatment.sessions, 1);
    assert.equal(treatment.avgBatchSize, 4);
    assert.equal(treatment.savedMs, 30);
    assert.equal(treatment.subagents, 1);
    assert.equal(treatment.subagentResults, 1);
    assert.equal(treatment.avgSubagentDurationMs, 5000);
    assert.equal(treatment.avgSubagentTokens, 1000);
    assert.equal(treatment.avgSubagentToolCalls, 2);
    assert.equal(treatment.okSubagents, 1);
    assert.equal(treatment.turns, 1);
    assert.equal(treatment.toolCalls, 4);
    assert.equal(treatment.callsPerTurn, 4);
    // 第二次读同一区间（a.ts、b.ts 各一次）算 2 次重复读取。
    assert.equal(treatment.redundantReads, 2);
    assert.equal(treatment.batchParamCalls, 4);
    assert.equal(control.toolCalls, 0);
    // 模型请求数含杂活（标题生成）调用，且与工具调用数不是一回事。
    assert.equal(treatment.requests, 2);
    assert.equal(treatment.utilityRequests, 1);
    assert.equal(treatment.requestsPerTool, 0.5);
    assert.equal(treatment.promptTokens, 1050);
    assert.equal(treatment.completionTokens, 110);
    assert.equal(treatment.cachedPromptTokens, 200);
    assert.equal(treatment.readCalls, 2);
    assert.equal(treatment.truncatedReads, 1);
    assert.equal(treatment.truncatedRate, 0.5);
    assert.equal(treatment.unpricedRequests, 0);
    assert.ok(Math.abs(treatment.costCny - 0.00117) < 1e-9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionMetrics counts cache hits from prompt_cache_hit_tokens", () => {
  const pricing = {
    inputPerMTokens: 1,
    outputPerMTokens: 2,
    cachedInputPerMTokens: 0.5,
  };
  const resolvePricing = () => ({ pricing, assumed: false });
  const llmCall = (usage) => ({
    type: "llm_call",
    timestamp: "2026-10-27T00:00:00.000Z",
    data: { timestamp: "2026-10-27T00:00:00.000Z", model: "test-model", usage },
  });

  // 归一化字段优先：另外两个旧字段存在且为 0，不能被 `??` 抢先命中。
  const normalized = sessionMetrics(
    [
      llmCall({
        prompt_tokens: 1_000,
        completion_tokens: 100,
        prompt_cache_hit_tokens: 800,
        cache_read_input_tokens: 0,
        cached_tokens: 0,
      }),
    ],
    { resolvePricing },
  );
  assert.equal(normalized.cachedPromptTokens, 800);
  // 未命中 200 × 1 + 命中 800 × 0.5 + 输出 100 × 2 = 800（单位：百万分之一元）
  assert.ok(Math.abs(normalized.costCny - 0.0008) < 1e-12);

  // 老 trace / 其他 provider 只给旧字段时仍要能统计（向后兼容）。
  const legacy = sessionMetrics(
    [
      llmCall({
        prompt_tokens: 1_000,
        completion_tokens: 100,
        cache_read_input_tokens: 800,
      }),
    ],
    { resolvePricing },
  );
  assert.equal(legacy.cachedPromptTokens, 800);
  assert.ok(Math.abs(legacy.costCny - 0.0008) < 1e-12);

  // 命中数不超过 prompt_tokens（防御异常上报）。
  const clamped = sessionMetrics(
    [
      llmCall({
        prompt_tokens: 100,
        completion_tokens: 0,
        prompt_cache_hit_tokens: 500,
      }),
    ],
    { resolvePricing },
  );
  assert.equal(clamped.cachedPromptTokens, 500);
  assert.ok(Math.abs(clamped.costCny - 0.00005) < 1e-12);
});
