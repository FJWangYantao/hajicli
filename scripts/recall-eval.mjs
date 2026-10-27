#!/usr/bin/env node
/**
 * 经验召回离线评测：不花 API 钱，直接在 605 条项目级 instincts 上比不同检索配置。
 *
 * 用法：
 *   node scripts/recall-eval.mjs            # 汇总表
 *   node scripts/recall-eval.mjs --samples  # 额外打印每个任务命中的前 3 条，便于人工复核
 *
 * 评测集：
 * - 11 个固定调研任务（prompt 取自 design/ab/data 里的实验数据）；
 * - 10 个无关短问，正确行为是「一条都不注入」。
 *
 * 相关性判定用任务主题词表（见 TASK_TOPICS），是弱标注：只看命中的 instinct 是否落在
 * 该任务的话题里。它不能代替人工判断，但足够比较不同配置的相对好坏。
 */

import fs from "node:fs";
import path from "node:path";
import { ExperienceStore, tokenize } from "../packages/core/dist/index.js";

const store = new ExperienceStore({ cwd: process.cwd() });

const args = new Set(process.argv.slice(2));
const SHOW_SAMPLES = args.has("--samples");

// ─── 评测集 ────────────────────────────────────────────────────────────────

const TASK_TOPICS = {
  0: ["read", "读取", "分页", "总结", "文件"],
  1: ["grep", "搜索", "查询", "标识符", "正则"],
  2: ["global", "查找", "文件", "glob", "通配"],
  3: ["会话", "保存", "session", "flush", "落盘", "持久化"],
  4: ["测试", "test", "覆盖", "用例"],
  5: ["批量", "batch", "并行", "工具", "调用"],
  6: ["构建", "build", "测试", "配置", "tsconfig"],
  7: ["错误", "失败", "止损", "重试", "error"],
  8: ["实验", "ab", "指标", "trace", "报告"],
  9: ["core", "文件", "模块", "职责"],
  10: ["subagent", "子代理", "并行", "判定", "策略"],
};

const UNRELATED = [
  "一句话说明：read 工具的 symbol 参数是干什么的？",
  "这个项目用什么包管理器？",
  "pnpm test 和 pnpm lint 有什么区别？",
  "帮我把这句话翻译成英文：今天天气不错",
  "解释一下什么是 Jaccard 相似度",
  "1+1 等于几",
  "你支持哪些终端主题？",
  "怎么退出这个程序？",
  "今天星期几？",
  "帮我写一个正则，匹配 11 位手机号",
];

function loadTaskPrompts() {
  const file = path.join(process.cwd(), "design/ab/data/2026-10-27-batch-only.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const byTask = new Map();
  for (const session of data.sessions ?? []) {
    if (session.task !== undefined && !byTask.has(session.task))
      byTask.set(session.task, session.prompt);
  }
  return byTask;
}

// ─── 分词与打分 ────────────────────────────────────────────────────────────

/** ASCII 词 + 中文单字（现状）。 */
function tokensSingle(text) {
  return tokenize(text);
}

/** ASCII 词 + 中文双字词：单字会把「的/用/不」都算命中，双字噪声小得多。 */
function tokensBigram(text) {
  const tokens = new Set();
  const ascii = text.toLowerCase().match(/[a-z0-9][a-z0-9-_]{1,}/g);
  if (ascii) for (const token of ascii) tokens.add(token);
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

function jaccard(a, b) {
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 加权 Jaccard：权重用 IDF，罕见词命中比「的/用/不」值钱。 */
function weightedJaccard(a, b, weights) {
  let inter = 0;
  let union = 0;
  for (const token of a) {
    const weight = weights.get(token) ?? 1;
    if (b.has(token)) inter += weight;
    else union += weight;
  }
  for (const token of b) if (!a.has(token)) union += weights.get(token) ?? 1;
  return union === 0 ? 0 : inter / union;
}

function buildIdf(docs, tokenizeFn) {
  const df = new Map();
  for (const doc of docs) {
    for (const token of tokenizeFn(doc)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const total = docs.length;
  const weights = new Map();
  for (const [token, count] of df) weights.set(token, Math.log((total + 1) / (count + 1)) + 1);
  return weights;
}

// ─── 配置 ──────────────────────────────────────────────────────────────────

const CONFIGS = [
  // 线上真实实现：直接调 store.recallInstincts，避免脚本和产品代码各写一套打分。
  { name: "线上实现（双字 + IDF + ≥0.10 + top2）", live: true },
  {
    name: "旧实现 minConf0.7 + 单字 + top8",
    tokenize: tokensSingle,
    minConfidence: 0.7,
    minScore: 0,
    topK: 8,
    idf: false,
  },
  {
    name: "minConf0.5 + 单字 + top3",
    tokenize: tokensSingle,
    minConfidence: 0.5,
    minScore: 0,
    topK: 3,
    idf: false,
  },
  {
    name: "minConf0.5 + 双字 + score≥0.05 + top3",
    tokenize: tokensBigram,
    minConfidence: 0.5,
    minScore: 0.05,
    topK: 3,
    idf: false,
  },
  {
    name: "minConf0.5 + 双字 + IDF + score≥0.05 + top3",
    tokenize: tokensBigram,
    minConfidence: 0.5,
    minScore: 0.05,
    topK: 3,
    idf: true,
  },
  {
    name: "minConf0.5 + 双字 + IDF + score≥0.10 + top2",
    tokenize: tokensBigram,
    minConfidence: 0.5,
    minScore: 0.1,
    topK: 2,
    idf: true,
  },
];

// ─── 评测 ──────────────────────────────────────────────────────────────────

function docsOf(instinct) {
  return `${instinct.trigger} ${instinct.action} ${instinct.domain}`;
}

function runConfig(config, instincts, prompts, idfWeights) {
  const candidates = instincts.filter((item) => item.confidence >= config.minConfidence);
  const docs = candidates.map((item) => ({ item, tokens: config.tokenize(docsOf(item)) }));

  const recall = (query) => {
    if (config.live) {
      return store.recallInstincts(query).map((instinct) => ({ instinct, score: 0 }));
    }
    const queryTokens = config.tokenize(query);
    const scored = [];
    for (const doc of docs) {
      const score = config.idf
        ? weightedJaccard(queryTokens, doc.tokens, idfWeights)
        : jaccard(queryTokens, doc.tokens);
      if (score < config.minScore || score <= 0) continue;
      scored.push({ instinct: doc.item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, config.topK);
  };

  let taskHits = 0;
  let taskReturned = 0;
  const samples = [];
  for (const [task, prompt] of prompts) {
    const topics = TASK_TOPICS[task] ?? [];
    const hits = recall(prompt);
    const relevant = hits.filter((hit) => {
      const text = docsOf(hit.instinct).toLowerCase();
      return topics.some((topic) => text.includes(topic.toLowerCase()));
    });
    taskHits += relevant.length;
    taskReturned += hits.length;
    samples.push({ task, hits, relevant });
  }

  let unrelatedInjected = 0;
  for (const query of UNRELATED) {
    const hits = recall(query);
    if (hits.length > 0) unrelatedInjected += 1;
  }

  const taskChars =
    samples.reduce(
      (sum, sample) => sum + sample.hits.reduce((s, hit) => s + hit.instinct.action.length, 0),
      0,
    ) / Math.max(1, samples.length);

  return {
    name: config.name,
    candidates: config.live ? "—" : candidates.length,
    precision: taskReturned === 0 ? 0 : taskHits / taskReturned,
    coverage: samples.filter((sample) => sample.relevant.length > 0).length / samples.length,
    unrelatedRate: unrelatedInjected / UNRELATED.length,
    avgChars: taskChars,
    samples,
  };
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

const instincts = store.loadInstincts();
const prompts = [...loadTaskPrompts()].sort((a, b) => a[0] - b[0]);

console.log(
  `instincts 总数 ${instincts.length}；任务 ${prompts.length} 个；无关短问 ${UNRELATED.length} 个\n`,
);

const bigramIdf = buildIdf(
  instincts.map((item) => docsOf(item)),
  tokensBigram,
);

const rows = CONFIGS.map((config) => runConfig(config, instincts, prompts, bigramIdf));

const pad = (value, width) => String(value).padEnd(width);
console.log(
  pad("配置", 44) +
    pad("候选", 6) +
    pad("相关率", 8) +
    pad("覆盖率", 8) +
    pad("无关注入率", 12) +
    "平均字符",
);
for (const row of rows) {
  console.log(
    pad(row.name, 44) +
      pad(row.candidates, 6) +
      pad(`${(row.precision * 100).toFixed(0)}%`, 8) +
      pad(`${(row.coverage * 100).toFixed(0)}%`, 8) +
      pad(`${(row.unrelatedRate * 100).toFixed(0)}%`, 12) +
      row.avgChars.toFixed(0),
  );
}

if (SHOW_SAMPLES) {
  for (const row of rows) {
    console.log(`\n=== ${row.name}`);
    for (const sample of row.samples) {
      console.log(` 任务 ${sample.task}: ${sample.relevant.length}/${sample.hits.length} 相关`);
      for (const hit of sample.hits) {
        const mark = sample.relevant.includes(hit) ? "✓" : "✗";
        console.log(
          `   ${mark} ${hit.score.toFixed(3)} [${hit.instinct.domain}] ${hit.instinct.action.slice(0, 60)}`,
        );
      }
    }
  }
}
