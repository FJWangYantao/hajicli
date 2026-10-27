#!/usr/bin/env node
/**
 * 并行 / 子代理 A/B 报告：读取 trace 里的 experiment_assignment、tool_batch、
 * subagent_launch 事件，按实验 arm 汇总。
 *
 * 用法：
 *   pnpm ab:report
 *   pnpm ab:report --dir ~/.haji/traces --since 2026-10-27
 *   pnpm ab:report --json
 *
 * 说明：一个进程（trace session）会同时带上多个实验的 arm；同一个 tool_batch
 * 会分别计入每个实验的对应 arm，因此各实验的批次总数应相同，差异体现在分组上。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPricingResolver, sessionMetrics } from "./ab-metrics.mjs";

function parseArgs(argv) {
  const options = { dirs: [], since: 0, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--dir") {
      const value = argv[index + 1];
      if (value) {
        options.dirs.push(value);
        index += 1;
      }
    } else if (arg === "--since") {
      const value = argv[index + 1];
      const parsed = value ? Date.parse(value) : Number.NaN;
      if (Number.isFinite(parsed)) options.since = parsed;
      index += 1;
    }
  }
  if (options.dirs.length === 0) {
    options.dirs = [
      path.join(os.homedir(), ".haji", "traces"),
      path.join(process.cwd(), ".haji", "traces"),
    ];
  }
  return options;
}

function readEvents(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 忽略正在写入的半行
    }
  }
  return events;
}

function emptyArm() {
  return {
    sessions: new Set(),
    batches: 0,
    parallelBatches: 0,
    calls: 0,
    savedMs: 0,
    wallMs: 0,
    serialMs: 0,
    subagents: 0,
    subagentResults: 0,
    subagentDurationMs: 0,
    subagentTokens: 0,
    subagentToolCalls: 0,
    okSubagents: 0,
    failedSubagents: 0,
    writeSubagents: 0,
    backgroundSubagents: 0,
    turns: 0,
    toolCalls: 0,
    redundantReads: 0,
    batchParamCalls: 0,
    requests: 0,
    utilityRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    costCny: 0,
    unpricedRequests: 0,
    assumedPricingRequests: 0,
    readCalls: 0,
    truncatedReads: 0,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  return run(options);
}

async function run(options) {
  const resolvePricing = await createPricingResolver();
  const files = [];
  for (const dir of options.dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".events.jsonl")) continue;
      files.push(path.join(dir, name));
    }
  }

  /** @type {Map<string, Map<string, ReturnType<typeof emptyArm>>>} */
  const experiments = new Map();
  const seenSessions = new Set();
  let sessionsWithAssignment = 0;
  let totalBatches = 0;
  let totalParallel = 0;
  let totalSubagents = 0;

  for (const file of files) {
    const events = readEvents(file);
    if (events.length === 0) continue;
    const assignment = events.find((event) => event.type === "experiment_assignment");
    if (!assignment) continue;
    const unitId = assignment.data?.unitId || path.basename(file);
    if (options.since && Date.parse(assignment.timestamp) < options.since) continue;
    if (seenSessions.has(unitId)) continue;
    seenSessions.add(unitId);
    sessionsWithAssignment += 1;

    const arms = assignment.data?.experiments || {};
    for (const [name, arm] of Object.entries(arms)) {
      if (!experiments.has(name)) experiments.set(name, new Map());
      const byArm = experiments.get(name);
      if (!byArm.has(arm)) byArm.set(arm, emptyArm());
      byArm.get(arm).sessions.add(unitId);
    }

    const metrics = sessionMetrics(events, { resolvePricing });
    for (const [name, arm] of Object.entries(arms)) {
      const bucket = experiments.get(name)?.get(arm);
      if (!bucket) continue;
      bucket.turns += metrics.turns;
      bucket.toolCalls += metrics.toolCalls;
      bucket.redundantReads += metrics.redundantReads;
      bucket.batchParamCalls += metrics.batchParamCalls;
      bucket.requests += metrics.requests;
      bucket.utilityRequests += metrics.utilityRequests;
      bucket.promptTokens += metrics.promptTokens;
      bucket.completionTokens += metrics.completionTokens;
      bucket.cachedPromptTokens += metrics.cachedPromptTokens;
      bucket.unpricedRequests += metrics.unpricedRequests;
      bucket.assumedPricingRequests += metrics.assumedPricingRequests;
      if (metrics.costCny !== null) bucket.costCny += metrics.costCny;
      bucket.readCalls += metrics.readCalls;
      bucket.truncatedReads += metrics.truncatedReads;
    }

    for (const event of events) {
      if (event.type === "tool_batch") {
        totalBatches += 1;
        if (event.data?.parallel) totalParallel += 1;
        for (const [name, arm] of Object.entries(arms)) {
          const bucket = experiments.get(name)?.get(arm);
          if (!bucket) continue;
          bucket.batches += 1;
          bucket.calls += Number(event.data?.size) || 0;
          if (event.data?.parallel) bucket.parallelBatches += 1;
          bucket.wallMs += Number(event.data?.wallTimeMs) || 0;
          bucket.serialMs += Number(event.data?.serialEstimateMs) || 0;
          bucket.savedMs += Number(event.data?.savedTimeMs) || 0;
        }
      } else if (event.type === "subagent_launch") {
        totalSubagents += 1;
        for (const [name, arm] of Object.entries(arms)) {
          const bucket = experiments.get(name)?.get(arm);
          if (!bucket) continue;
          bucket.subagents += 1;
          if (event.data?.access === "workspace-write") bucket.writeSubagents += 1;
          if (event.data?.background) bucket.backgroundSubagents += 1;
        }
      } else if (event.type === "subagent_result") {
        for (const [name, arm] of Object.entries(arms)) {
          const bucket = experiments.get(name)?.get(arm);
          if (!bucket) continue;
          bucket.subagentResults += 1;
          bucket.subagentDurationMs += Number(event.data?.durationMs) || 0;
          bucket.subagentTokens += Number(event.data?.totalTokens) || 0;
          bucket.subagentToolCalls += Number(event.data?.toolCalls) || 0;
          const status = String(event.data?.status || "");
          if (["verified", "awaiting_verification", "completed"].includes(status)) {
            bucket.okSubagents += 1;
          } else if (status === "failed" || status === "aborted") {
            bucket.failedSubagents += 1;
          }
        }
      }
    }
  }

  const report = {
    files: files.length,
    sessionsWithAssignment,
    totalBatches,
    totalParallelBatches: totalParallel,
    totalSubagents,
    experiments: Object.fromEntries(
      [...experiments.entries()].map(([name, byArm]) => [
        name,
        [...byArm.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([arm, bucket]) => ({
            arm,
            sessions: bucket.sessions.size,
            batches: bucket.batches,
            parallelBatches: bucket.parallelBatches,
            calls: bucket.calls,
            avgBatchSize: bucket.batches > 0 ? bucket.calls / bucket.batches : 0,
            parallelRate: bucket.batches > 0 ? bucket.parallelBatches / bucket.batches : 0,
            savedMs: bucket.savedMs,
            wallMs: bucket.wallMs,
            serialMs: bucket.serialMs,
            subagents: bucket.subagents,
            subagentResults: bucket.subagentResults,
            avgSubagentDurationMs:
              bucket.subagentResults > 0 ? bucket.subagentDurationMs / bucket.subagentResults : 0,
            avgSubagentTokens:
              bucket.subagentResults > 0 ? bucket.subagentTokens / bucket.subagentResults : 0,
            avgSubagentToolCalls:
              bucket.subagentResults > 0 ? bucket.subagentToolCalls / bucket.subagentResults : 0,
            okSubagents: bucket.okSubagents,
            failedSubagents: bucket.failedSubagents,
            writeSubagents: bucket.writeSubagents,
            backgroundSubagents: bucket.backgroundSubagents,
            turns: bucket.turns,
            toolCalls: bucket.toolCalls,
            callsPerTurn: bucket.turns > 0 ? bucket.toolCalls / bucket.turns : 0,
            redundantReads: bucket.redundantReads,
            batchParamCalls: bucket.batchParamCalls,
            requests: bucket.requests,
            utilityRequests: bucket.utilityRequests,
            requestsPerTool: bucket.toolCalls > 0 ? bucket.requests / bucket.toolCalls : 0,
            promptTokens: bucket.promptTokens,
            completionTokens: bucket.completionTokens,
            cachedPromptTokens: bucket.cachedPromptTokens,
            costCny: bucket.unpricedRequests === 0 ? bucket.costCny : null,
            unpricedRequests: bucket.unpricedRequests,
            assumedPricingRequests: bucket.assumedPricingRequests,
            readCalls: bucket.readCalls,
            truncatedReads: bucket.truncatedReads,
            truncatedRate: bucket.readCalls > 0 ? bucket.truncatedReads / bucket.readCalls : 0,
          })),
      ]),
    ),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  console.log(
    `A/B 报告：${report.sessionsWithAssignment} 个带分配的快照 / ${report.files} 个 trace 文件`,
  );
  console.log(
    `工具批 ${report.totalBatches}，并行批 ${report.totalParallelBatches}，子代理启动 ${report.totalSubagents}`,
  );
  if (report.sessionsWithAssignment === 0) {
    console.log("\n没有 experiment_assignment 事件。先运行新版本 haji（会写分配快照），");
    console.log("并用 HAJI_AB=1 或 HAJI_EXPERIMENTS=name=arm 指定实验组。");
    return;
  }
  for (const [name, rows] of Object.entries(report.experiments)) {
    console.log(`\n## ${name}`);
    console.log(
      "arm        sessions  batches  parallel  avgSize  parallelRate  saved(ms)  subagents  done  avgSec  avgTokens  avgTools  ok",
    );
    for (const row of rows) {
      console.log(
        [
          row.arm.padEnd(10),
          String(row.sessions).padStart(8),
          String(row.batches).padStart(8),
          String(row.parallelBatches).padStart(9),
          row.avgBatchSize.toFixed(2).padStart(8),
          `${(row.parallelRate * 100).toFixed(1)}%`.padStart(12),
          row.savedMs.toFixed(1).padStart(10),
          String(row.subagents).padStart(10),
          String(row.subagentResults).padStart(5),
          (row.avgSubagentDurationMs / 1000).toFixed(1).padStart(6),
          Math.round(row.avgSubagentTokens).toString().padStart(10),
          row.avgSubagentToolCalls.toFixed(1).padStart(8),
          String(row.okSubagents).padStart(9),
        ].join("  "),
      );
    }
  }

  console.log("\n## 调用效率（每回合）");
  console.log(
    "experiment        arm          sessions  turns  calls  calls/turn  dupReads  batchParam",
  );
  for (const [name, rows] of Object.entries(report.experiments)) {
    for (const row of rows) {
      console.log(
        [
          name.padEnd(16),
          row.arm.padEnd(12),
          String(row.sessions).padStart(8),
          String(row.turns).padStart(6),
          String(row.toolCalls).padStart(6),
          row.callsPerTurn.toFixed(2).padStart(10),
          String(row.redundantReads).padStart(9),
          String(row.batchParamCalls).padStart(11),
        ].join("  "),
      );
    }
  }

  console.log("\n## 请求与成本（每会话）");
  console.log(
    "experiment        arm          sessions  requests  req/tool  ptok/sess  ctok/sess  cache%  cost/sess  readTrunc",
  );
  for (const [name, rows] of Object.entries(report.experiments)) {
    for (const row of rows) {
      const sessions = row.sessions || 1;
      const cacheRate =
        row.promptTokens > 0 ? (row.cachedPromptTokens / row.promptTokens) * 100 : 0;
      console.log(
        [
          name.padEnd(16),
          row.arm.padEnd(12),
          String(row.sessions).padStart(8),
          (row.requests / sessions).toFixed(2).padStart(8),
          row.requestsPerTool.toFixed(2).padStart(9),
          Math.round(row.promptTokens / sessions)
            .toString()
            .padStart(10),
          Math.round(row.completionTokens / sessions)
            .toString()
            .padStart(10),
          `${cacheRate.toFixed(1)}%`.padStart(6),
          (row.costCny === null
            ? "n/a"
            : `¥${(row.costCny / sessions).toFixed(3)}${row.assumedPricingRequests > 0 ? "*" : ""}`
          ).padStart(9),
          `${row.truncatedReads}/${row.readCalls}`.padStart(9),
        ].join("  "),
      );
    }
  }
  console.log(
    "\n（cost 按 ~/.haji/pricing.json / 内置单价计，峰时价；* 表示部分请求的单价借用同名前缀模型。" +
      "cache% 为 0 说明 provider 没上报缓存命中，多出来的上下文按全价计。）",
  );
}

await main();
