#!/usr/bin/env node
/**
 * 从 trace 抽取「每会话」实验指标，便于把 A/B 结果落盘成可复现的数据文件。
 *
 * 用法：
 *   node scripts/ab-extract.mjs --experiment tool_batching --since 2026-10-27T07:41:00Z
 *   node scripts/ab-extract.mjs --experiment scope_discipline --json > out.json
 *   node scripts/ab-extract.mjs --experiment tool_batching --since A --until B   # 只看某一轮
 *
 * 与 `pnpm ab:report` 的区别：report 只做 arm 级聚合，这里保留每个会话的原始计数，
 * 方便事后做配对分析、复核结论，或者换一种聚合口径。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    dirs: [],
    experiment: undefined,
    since: 0,
    until: 0,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--experiment") {
      options.experiment = argv[index + 1];
      index += 1;
    } else if (arg === "--until") {
      const value = argv[index + 1];
      const parsed = value ? Date.parse(value) : Number.NaN;
      if (Number.isFinite(parsed)) options.until = parsed;
      index += 1;
    } else if (arg === "--since") {
      const value = argv[index + 1];
      const parsed = value ? Date.parse(value) : Number.NaN;
      if (Number.isFinite(parsed)) options.since = parsed;
      index += 1;
    } else if (arg === "--dir") {
      const value = argv[index + 1];
      if (value) {
        options.dirs.push(value);
        index += 1;
      }
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

/** 会话墙钟来自 meta.json（startTime/endTime）。 */
function readMetaDurations(dirs) {
  const durations = new Map();
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".meta.json")) continue;
      const id = name.replace(/^session_/, "").replace(/\.meta\.json$/, "");
      try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (value.startTime && value.endTime) {
          durations.set(id, Date.parse(value.endTime) - Date.parse(value.startTime));
        }
      } catch {
        // 忽略半写入
      }
    }
  }
  return durations;
}

function sessionMetrics(events) {
  const toolCounts = {};
  let redundantReads = 0;
  let batchParamCalls = 0;
  const seenReads = new Set();
  let turns = 0;
  let subagents = 0;
  for (const event of events) {
    if (event.type === "user_input") {
      turns += 1;
      continue;
    }
    if (event.type !== "tool_execution") continue;
    const name = String(event.data?.name || "");
    toolCounts[name] = (toolCounts[name] || 0) + 1;
    if (name === "subagent") subagents += 1;
    const args = event.data?.arguments;
    if (name === "read" && args && typeof args === "object") {
      const batch = Array.isArray(args.paths);
      if (batch) batchParamCalls += 1;
      for (const request of batch ? args.paths : [args]) {
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
  const toolCalls = Object.values(toolCounts).reduce((sum, value) => sum + value, 0);
  return { turns, toolCalls, toolCounts, redundantReads, batchParamCalls, subagents };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const durations = readMetaDurations(options.dirs);
  const sessions = [];
  const seen = new Set();

  for (const dir of options.dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".events.jsonl")) continue;
      const events = readEvents(path.join(dir, name));
      if (events.length === 0) continue;
      const assignment = events.find((event) => event.type === "experiment_assignment");
      if (!assignment) continue;
      const unitId = assignment.data?.unitId || name;
      if (seen.has(unitId)) continue;
      const stamp = Date.parse(assignment.timestamp);
      if (options.since && stamp < options.since) continue;
      if (options.until && stamp > options.until) continue;
      const experiments = assignment.data?.experiments || {};
      if (options.experiment && experiments[options.experiment] === undefined) continue;
      seen.add(unitId);

      const input = events.find((event) => event.type === "user_input");
      const metrics = sessionMetrics(events);
      sessions.push({
        unitId,
        timestamp: assignment.timestamp,
        experiments,
        arm: options.experiment ? experiments[options.experiment] : undefined,
        prompt: input ? String(input.content).slice(0, 200) : "",
        wallMs: durations.get(unitId) ?? 0,
        ...metrics,
      });
    }
  }

  sessions.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const byArm = {};
  for (const session of sessions) {
    const arm = session.arm ?? "(none)";
    if (!byArm[arm]) {
      byArm[arm] = {
        sessions: 0,
        wallMs: 0,
        toolCalls: 0,
        redundantReads: 0,
        batchParamCalls: 0,
        subagents: 0,
      };
    }
    const bucket = byArm[arm];
    bucket.sessions += 1;
    bucket.wallMs += session.wallMs;
    bucket.toolCalls += session.toolCalls;
    bucket.redundantReads += session.redundantReads;
    bucket.batchParamCalls += session.batchParamCalls;
    bucket.subagents += session.subagents;
  }
  for (const bucket of Object.values(byArm)) {
    const n = bucket.sessions || 1;
    bucket.avgWallMs = bucket.wallMs / n;
    bucket.avgToolCalls = bucket.toolCalls / n;
    bucket.avgRedundantReads = bucket.redundantReads / n;
    bucket.avgBatchParamCalls = bucket.batchParamCalls / n;
  }

  const report = {
    experiment: options.experiment ?? null,
    since: options.since ? new Date(options.since).toISOString() : null,
    until: options.until ? new Date(options.until).toISOString() : null,
    sessions,
    byArm,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  console.log(`实验=${report.experiment} 会话=${sessions.length}`);
  for (const [arm, bucket] of Object.entries(byArm)) {
    console.log(
      `${arm.padEnd(12)} n=${bucket.sessions} calls=${bucket.avgToolCalls.toFixed(2)} ` +
        `dup=${bucket.avgRedundantReads.toFixed(2)} batch=${bucket.avgBatchParamCalls.toFixed(2)} ` +
        `wall=${(bucket.avgWallMs / 1000).toFixed(1)}s sub=${bucket.subagents}`,
    );
  }
}

main();
