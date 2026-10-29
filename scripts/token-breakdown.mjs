#!/usr/bin/env node
/**
 * 一次运行（或一批运行）的 token 去向拆解：主线请求 / 辅助请求 / 重复读取各占多少。
 *
 * 数据源只有 trace：`<dir>/**​/.haji/traces/*.events.jsonl` 里的 `llm_call`（含完整 messages
 * 与 usage）与 `tool_execution`（含工具名与入参）。不调用任何模型，纯离线统计。
 *
 * 用法：
 *   node scripts/token-breakdown.mjs .tmp/quality-cn-fixed
 *   node scripts/token-breakdown.mjs .tmp/quality-cn-fixed --json
 *
 * 分类口径（辅助请求靠提示词特征识别，宁可归入「未识别」也不要算进主线）：
 * - title：会话标题（`请针对以下用户的第一条需求，总结出`）
 * - compaction：上下文压缩摘要（system 里出现「压缩」/「摘要」且只有 1 轮历史）
 * - distill：经验提炼（提示词含 `instinct` / `经验`）
 * - mainline：其余带 system prompt 或 ≥3 条消息的请求
 * - other：短请求但没命中上面任何特征（新辅助请求出现时先落这里，再补特征）
 */
import fs from "node:fs";
import path from "node:path";

const MARKERS = [
  ["title", /请针对以下用户的第一条需求，总结出/],
  ["compaction", /(?:压缩|摘要)[\s\S]{0,200}(?:对话|上下文|历史)/],
  ["distill", /(?:instinct|经验规则|可复用的经验)/i],
];

/** 主线回合的 system prompt 首行固定是这段身份说明（见 index.ts 的提示词拼装）。 */
const MAINLINE_SYSTEM = /^#\s*身份与目标/;

function classify(call) {
  const messages = Array.isArray(call.messages) ? call.messages : [];
  const first = messages[0];
  // 先判主线：主线 system prompt 里本身就会提到「压缩」「摘要」，用关键词先判会把主线全吃掉。
  if (
    first?.role === "system" &&
    typeof first.content === "string" &&
    MAINLINE_SYSTEM.test(first.content.trimStart())
  ) {
    return "mainline";
  }
  const text = messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n")
    .slice(0, 4000);
  for (const [kind, pattern] of MARKERS) {
    if (pattern.test(text)) return kind;
  }
  return "other";
}

/** 递归找出所有 trace 事件文件。 */
function findEventFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".events.jsonl")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

function readEvents(file) {
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 半行（进程被杀）忽略：统计不因一条坏行整体失败。
    }
  }
  return events;
}

function emptyBucket() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
}

function addUsage(bucket, usage) {
  bucket.requests += 1;
  bucket.promptTokens += Number(usage?.prompt_tokens ?? 0) || 0;
  bucket.completionTokens += Number(usage?.completion_tokens ?? 0) || 0;
  bucket.cachedTokens +=
    (Number(usage?.prompt_cache_hit_tokens ?? 0) || 0) + (Number(usage?.cached_tokens ?? 0) || 0);
}

const total = (bucket) => bucket.promptTokens + bucket.completionTokens;

function analyzeSession(file) {
  const events = readEvents(file);
  const kinds = {};
  const reads = new Map();
  let toolCalls = 0;
  for (const event of events) {
    const data = event?.data ?? {};
    if (event.type === "llm_call") {
      const kind = classify(data);
      kinds[kind] ??= emptyBucket();
      addUsage(kinds[kind], data.usage);
    } else if (event.type === "tool_execution") {
      toolCalls += 1;
      if (String(data.name ?? "").toLowerCase() !== "read") continue;
      const args = data.arguments ?? {};
      const target = `${args.path ?? args.file_path ?? ""}#${args.startLine ?? ""}-${args.endLine ?? ""}:${args.symbol ?? ""}`;
      reads.set(target, (reads.get(target) ?? 0) + 1);
    }
  }
  let duplicateReads = 0;
  for (const count of reads.values()) duplicateReads += Math.max(0, count - 1);
  const bucket = { kinds, toolCalls, readCalls: reads.size, duplicateReads };
  bucket.totalRequests = Object.values(kinds).reduce((sum, item) => sum + item.requests, 0);
  bucket.totalTokens = Object.values(kinds).reduce((sum, item) => sum + total(item), 0);
  bucket.promptTokens = Object.values(kinds).reduce((sum, item) => sum + item.promptTokens, 0);
  bucket.completionTokens = Object.values(kinds).reduce(
    (sum, item) => sum + item.completionTokens,
    0,
  );
  return bucket;
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const root = args.find((arg) => !arg.startsWith("--")) ?? ".";
const files = findEventFiles(root);
if (files.length === 0) {
  console.error(`没有找到 trace 事件文件：${root}`);
  process.exit(1);
}

const sessions = files.map((file) => {
  const stats = analyzeSession(file);
  // 任务名取 trace 上一级目录（`.tmp/quality-x/sum/.haji/traces/a.events.jsonl` → sum）。
  const parts = file.split(path.sep);
  const tracesIndex = parts.lastIndexOf("traces");
  const task = tracesIndex >= 2 ? parts[tracesIndex - 2] : path.basename(file, ".events.jsonl");
  return { task, file, ...stats };
});

const totals = { kinds: {}, sessions: sessions.length, duplicateReads: 0, toolCalls: 0 };
for (const session of sessions) {
  totals.duplicateReads += session.duplicateReads;
  totals.toolCalls += session.toolCalls;
  for (const [kind, bucket] of Object.entries(session.kinds)) {
    totals.kinds[kind] ??= emptyBucket();
    const target = totals.kinds[kind];
    target.requests += bucket.requests;
    target.promptTokens += bucket.promptTokens;
    target.completionTokens += bucket.completionTokens;
    target.cachedTokens += bucket.cachedTokens;
  }
}

if (asJson) {
  console.log(JSON.stringify({ root, sessions, totals }, null, 2));
} else {
  const pad = (value, width) => String(value).padStart(width);
  console.log(`trace 目录：${root}（${sessions.length} 个会话）\n`);
  console.log("会话                 请求   主线tok  辅助tok  未识别   重复读  工具数");
  for (const session of sessions) {
    const mainline = total(session.kinds.mainline ?? emptyBucket());
    const auxiliary = ["title", "compaction", "distill"].reduce(
      (sum, kind) => sum + total(session.kinds[kind] ?? emptyBucket()),
      0,
    );
    const other = total(session.kinds.other ?? emptyBucket());
    console.log(
      `${session.task.padEnd(20)} ${pad(session.totalRequests, 5)} ${pad(mainline, 8)} ${pad(auxiliary, 8)} ${pad(other, 7)} ${pad(session.duplicateReads, 7)} ${pad(session.toolCalls, 6)}`,
    );
  }
  const grand = Object.values(totals.kinds).reduce((sum, bucket) => sum + total(bucket), 0);
  console.log(
    `\n合计：${totals.sessions} 个会话，${Object.values(totals.kinds).reduce((s, b) => s + b.requests, 0)} 次请求，${grand} token，重复读 ${totals.duplicateReads} 次\n`,
  );
  console.log("分类明细（请求 / 输入 / 输出 / 占比 / 输入缓存命中）：");
  for (const [kind, bucket] of Object.entries(totals.kinds).sort(
    (a, b) => total(b[1]) - total(a[1]),
  )) {
    const share = grand > 0 ? ((total(bucket) / grand) * 100).toFixed(1) : "0.0";
    const cacheShare =
      bucket.promptTokens > 0
        ? ((bucket.cachedTokens / bucket.promptTokens) * 100).toFixed(1)
        : "0.0";
    console.log(
      `  ${kind.padEnd(11)} ${pad(bucket.requests, 5)} ${pad(bucket.promptTokens, 9)} ${pad(bucket.completionTokens, 8)} ${pad(`${share}%`, 7)} ${pad(`${cacheShare}%`, 8)}`,
    );
  }
  const mainline = totals.kinds.mainline;
  if (mainline) {
    console.log(
      `\n主线：${mainline.requests} 次请求，平均每次输入 ${Math.round(mainline.promptTokens / mainline.requests)} token、输出 ${Math.round(mainline.completionTokens / mainline.requests)} token；未命中缓存输入 ${mainline.promptTokens - mainline.cachedTokens} token（${(((mainline.promptTokens - mainline.cachedTokens) / mainline.promptTokens) * 100).toFixed(1)}%）。`,
    );
  }
}
