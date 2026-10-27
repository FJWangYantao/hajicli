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
  };
}

/**
 * 单会话指标：回合数、工具调用数、重复读取次数、使用批量参数的调用数。
 * 重复读取按「路径 + 区间参数」判定，同一区间读第二次即计一次。
 */
function collectSessionMetrics(events) {
  let turns = 0;
  let toolCalls = 0;
  let redundantReads = 0;
  let batchParamCalls = 0;
  const seenReads = new Set();
  for (const event of events) {
    if (event.type === "user_input") {
      turns += 1;
      continue;
    }
    if (event.type !== "tool_execution") continue;
    toolCalls += 1;
    const name = String(event.data?.name || "").toLowerCase();
    const args = event.data?.arguments;
    if (name === "read" && args && typeof args === "object") {
      const batch = Array.isArray(args.paths);
      if (batch) batchParamCalls += 1;
      const requests = batch ? args.paths : [args];
      for (const request of requests) {
        if (!request) continue;
        const key =
          typeof request === "string"
            ? request
            : [
                request.path ?? "",
                request.startLine ?? "",
                request.endLine ?? "",
                request.limit ?? "",
                request.aroundLine ?? "",
              ].join("|");
        if (seenReads.has(key)) redundantReads += 1;
        else seenReads.add(key);
      }
    } else if (name === "grep" && Array.isArray(args?.queries)) {
      batchParamCalls += 1;
    } else if (name === "global" && Array.isArray(args?.patterns)) {
      batchParamCalls += 1;
    }
  }
  return { turns, toolCalls, redundantReads, batchParamCalls };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
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

    const metrics = collectSessionMetrics(events);
    for (const [name, arm] of Object.entries(arms)) {
      const bucket = experiments.get(name)?.get(arm);
      if (!bucket) continue;
      bucket.turns += metrics.turns;
      bucket.toolCalls += metrics.toolCalls;
      bucket.redundantReads += metrics.redundantReads;
      bucket.batchParamCalls += metrics.batchParamCalls;
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
}

main();
