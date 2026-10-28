#!/usr/bin/env node
/**
 * 一键跑 A/B：按固定任务 × 轮次 × arm 交替执行 `haji -p`，结束后直接出 arm 级汇总。
 *
 * 用法（在仓库根目录，需要可用的 provider key；先 pnpm run build）：
 *   node scripts/ab-run.mjs --experiment read_symbol --arms baseline,symbol --tasks 5,7,10 --rounds 2
 *   node scripts/ab-run.mjs ... --dry-run        # 只打印计划，不调用模型
 *
 * 任务原文取自 design/ab/data/2026-10-27-batch-only.json（历次实验共用的 11 个固定任务）。
 * 每次运行写 trace 到 .haji/traces，结束后用 ab-extract 同一套口径汇总；
 * `--out <file>` 把每会话指标 + 运行记录落盘，供写报告时引用。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TASK_FILE = "design/ab/data/2026-10-27-batch-only.json";

function parseArgs(argv) {
  const options = {
    experiment: "",
    arms: [],
    tasks: [],
    rounds: 2,
    timeoutMs: 300_000,
    dryRun: false,
    out: "",
    bin: "haji",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--experiment") options.experiment = value ?? "";
    else if (arg === "--arms") options.arms = (value ?? "").split(",").filter(Boolean);
    else if (arg === "--tasks")
      options.tasks = (value ?? "").split(",").map(Number).filter(Boolean);
    else if (arg === "--rounds") options.rounds = Math.max(1, Number(value) || 1);
    else if (arg === "--timeout") options.timeoutMs = Math.max(10, Number(value) || 300) * 1000;
    else if (arg === "--out") options.out = value ?? "";
    else if (arg === "--bin") options.bin = value ?? "haji";
    else continue;
    if (arg !== "--dry-run") index += 1;
  }
  return options;
}

export function loadTaskPrompts(file = path.join(process.cwd(), TASK_FILE)) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const prompts = new Map();
  for (const session of data.sessions ?? []) {
    if (session.task !== undefined && session.prompt && !prompts.has(session.task)) {
      prompts.set(session.task, session.prompt);
    }
  }
  return prompts;
}

/**
 * 运行计划：同一轮里每个任务的 arm 顺序交替（奇数轮倒过来），
 * 抵消「先跑的那一臂缓存更冷」这类顺序效应。
 */
export function buildRunPlan(tasks, arms, rounds) {
  const plan = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const task of tasks) {
      const order = round % 2 === 1 ? arms : [...arms].reverse();
      for (const arm of order) plan.push({ task, arm, round });
    }
  }
  return plan;
}

function runOne(bin, prompt, env, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(bin, ["-p", prompt, "--no-worktree", "--output-format", "json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      let ok = false;
      try {
        ok = JSON.parse(stdout.trim().split("\n").pop() ?? "{}").ok === true;
      } catch {
        ok = false;
      }
      resolve({
        code,
        ok,
        wallMs: Date.now() - startedAt,
        timedOut: Date.now() - startedAt >= timeoutMs,
      });
    });
  });
}

function extract(experiment, since) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["scripts/ab-extract.mjs", "--experiment", experiment, "--since", since, "--json"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(undefined);
      }
    });
  });
}

const pct = (base, value) =>
  base > 0 ? `${value >= base ? "+" : ""}${(((value - base) / base) * 100).toFixed(1)}%` : "—";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.experiment || options.arms.length < 2 || options.tasks.length === 0) {
    console.error(
      "用法：node scripts/ab-run.mjs --experiment <名> --arms a,b --tasks 5,7,10 [--rounds 2] [--timeout 300] [--out file] [--dry-run]",
    );
    process.exit(2);
  }
  const prompts = loadTaskPrompts();
  const missing = options.tasks.filter((task) => !prompts.has(task));
  if (missing.length > 0) {
    console.error(`未知任务编号：${missing.join(", ")}（可用：${[...prompts.keys()].join(", ")}）`);
    process.exit(2);
  }
  const plan = buildRunPlan(options.tasks, options.arms, options.rounds);
  console.log(`计划 ${plan.length} 次运行：${options.experiment} = ${options.arms.join(" / ")}`);
  if (options.dryRun) {
    for (const item of plan) console.log(`  任务 ${item.task} · 第 ${item.round} 轮 · ${item.arm}`);
    return;
  }

  const since = new Date().toISOString();
  const runs = [];
  for (const [index, item] of plan.entries()) {
    const env = { ...process.env, HAJI_EXPERIMENTS: `${options.experiment}=${item.arm}` };
    process.stdout.write(
      `[${index + 1}/${plan.length}] 任务 ${item.task} 第 ${item.round} 轮 ${item.arm} … `,
    );
    const result = await runOne(options.bin, prompts.get(item.task), env, options.timeoutMs);
    runs.push({ ...item, ...result });
    console.log(
      result.timedOut
        ? "超时"
        : result.ok
          ? `${(result.wallMs / 1000).toFixed(1)}s`
          : `失败(${result.code})`,
    );
  }

  const report = await extract(options.experiment, since);
  if (!report) {
    console.error("没有读到 trace 指标：确认 .haji/traces 可写，或用 ab-extract 手动汇总。");
    process.exit(1);
  }
  const [control, treatment] = options.arms.map((arm) => report.byArm[arm]);
  console.log("");
  if (control && treatment) {
    const rows = [
      ["会话", control.sessions, treatment.sessions],
      ["墙钟/会话 (s)", control.avgWallMs / 1000, treatment.avgWallMs / 1000],
      ["请求/会话", control.avgRequests, treatment.avgRequests],
      ["工具调用/会话", control.avgToolCalls, treatment.avgToolCalls],
      ["read/会话", control.avgReadCalls, treatment.avgReadCalls],
      [
        "未命中 token/会话",
        (control.promptTokens - control.cachedPromptTokens) / (control.sessions || 1),
        (treatment.promptTokens - treatment.cachedPromptTokens) / (treatment.sessions || 1),
      ],
      ["费用/会话 (¥)", control.avgCostCny ?? Number.NaN, treatment.avgCostCny ?? Number.NaN],
      ["symbol 调用", control.symbolReads, treatment.symbolReads],
      ["symbol 提示", control.symbolHints, treatment.symbolHints],
    ];
    console.log(`| 指标 | ${options.arms[0]} | ${options.arms[1]} | 变化 |`);
    console.log("| --- | ---: | ---: | ---: |");
    for (const [label, a, b] of rows) {
      const fmt = (value) =>
        Number.isInteger(value) ? String(value) : value.toFixed(label.includes("¥") ? 4 : 1);
      console.log(`| ${label} | ${fmt(a)} | ${fmt(b)} | ${pct(a, b)} |`);
    }
  } else {
    console.log(JSON.stringify(report.byArm, null, 2));
  }
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(
      options.out,
      `${JSON.stringify({ experiment: options.experiment, tasks: options.tasks, rounds: options.rounds, arms: options.arms, runs, ...report }, null, 2)}\n`,
    );
    console.log(`\n已写入 ${options.out}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ab-run.mjs")) {
  await main();
}
