import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@hajicli/core";

import { resumeLatestSession } from "../dist/session-commands.js";

/**
 * /resume 的压缩记录回放：压缩摘要只写在 system 消息里，普通历史渲染会跳过，
 * 所以这里守着「恢复后仍能看见压缩提示、字符/Token 估算、压缩前轨迹与摘要」。
 */

const COMPACTED_SYSTEM = [
  "BASE PROMPT",
  "",
  "[Compacted Context Summary]",
  "",
  "## 当前目标",
  "整理分支",
  "",
  "完整压缩前记录：/tmp/transcript_9.jsonl",
  "",
  "[HAJI_ACTIVE_SKILLS_START]",
  "skill-line",
  "[HAJI_ACTIVE_SKILLS_END]",
].join("\n");

const COMPACTION = {
  at: "2026-10-27T10:00:00.000Z",
  beforeTokens: 123_456,
  afterTokens: 4_567,
  beforeChars: 234_567,
  afterChars: 45_678,
  layers: ["L1:大结果落盘", "L4:模型结构化摘要"],
  transcriptPath: "/tmp/transcript_9.jsonl",
  summaryMode: "model",
  summaryModel: "glm-5.2",
};

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "haji-resume-compaction-"));
}

/** 最小 ctx：只实现 loadAndRenderSession 用到的接口，聊天内容收集到 lines。 */
function createContext(sessionManager, lines) {
  const noop = () => {};
  const ui = {
    getContentWidth: () => 80,
    writeLine: (value = "") => lines.push(value),
    replaceChatSegments: (pieces) => {
      lines.push("<<CHAT>>");
      for (const piece of pieces) lines.push(piece.raw);
    },
    clearChat: noop,
    dismissStartupHeader: () => lines.push("<<HEADER_DISMISSED>>"),
  };
  return {
    ui,
    sessionManager,
    taskStore: { setTaskScope: noop },
    snapshotEngine: { setScope: noop },
    agentManager: { setScope: noop },
    skillRegistry: { restoreScopeFromMessages: noop },
    readSelectionSafely: async () => ({ value: "" }),
    getSlashCommands: () => [],
    pendingInputs: [],
    getMessages: () => [],
    setMessages: noop,
    getSystemPrompt: () => "sys",
    resetPlanReviewState: noop,
    syncTaskPlanUI: noop,
    refreshSystemPrompt: async () => {},
    refreshAgentVerificationContext: noop,
    isThinkingVisible: () => true,
    saveSession: noop,
    updateStatusUI: noop,
    applySessionUsage: (usage) => lines.push(`<<USAGE ${usage?.compactionCount}>>`),
  };
}

async function seedSession(dir, { usage }) {
  const writer = new SessionManager(dir);
  const id = writer.getCurrentSession().id;
  const messages = [
    { role: "system", content: COMPACTED_SYSTEM },
    { role: "user", content: "删除分支" },
    { role: "assistant", content: "已删除。" },
  ];
  writer.saveCurrentSession(messages, "分支整理");
  if (usage) {
    writer.setUsage({ costRecords: [], lastTurnMs: 1000, ...usage });
    writer.saveCurrentSession(messages);
  }
  await writer.flush();
  return id;
}

async function renderResume(dir) {
  const lines = [];
  const reader = new SessionManager(dir);
  // 主目录里得有一个“当前会话”，resumeLatestSession 才会列出刚种下的那个。
  reader.startNewSession();
  const ok = await resumeLatestSession(createContext(reader, lines));
  assert.equal(ok, true);
  assert.ok(lines.includes("<<HEADER_DISMISSED>>"));
  return lines.join("\n");
}

test("/resume 回放压缩记录：次数/层级/字符/Token/轨迹与摘要", async () => {
  const dir = makeTempDir();
  await seedSession(dir, {
    usage: { compactionCount: 2, lastCompaction: COMPACTION },
  });

  const text = await renderResume(dir);
  assert.match(text, /已恢复会话：「分支整理」/);
  assert.match(text, /上下文压缩完成（共 2 次/);
  assert.match(text, /L1:大结果落盘 -> L4:模型结构化摘要/);
  assert.match(text, /字符占用: 234,567 ➔ 45,678 \(释放了 80\.5% 空间\)/);
  assert.match(text, /Token 估算: 123,456 ➔ 4,567/);
  // 「压缩模型」紧跟 Token 估算：摘要由哪个模型生成（杂活模型可能是另一个）。
  assert.match(text, /Token 估算: 123,456 ➔ 4,567\n.*压缩模型: glm-5\.2/);
  assert.match(text, /压缩前完整记录：\/tmp\/transcript_9\.jsonl/);
  assert.match(text, /压缩摘要（已并入系统提示词）/);
  assert.match(text, /整理分支/);
  // system 消息本身不参与渲染：基础提示词与技能分片都不能漏进聊天区。
  assert.doesNotMatch(text, /BASE PROMPT/);
  assert.doesNotMatch(text, /skill-line/);
  // 侧栏用量仍然照常恢复。
  assert.match(text, /<<USAGE 2>>/);
});

test("老会话没有压缩元数据时，用系统提示词里的摘要标记兜底", async () => {
  const dir = makeTempDir();
  await seedSession(dir, { usage: { compactionCount: 1 } });

  const text = await renderResume(dir);
  assert.match(text, /上下文压缩完成（共 1 次）/);
  // 没有落盘元数据就不编造字符/Token 估算。
  assert.doesNotMatch(text, /字符占用/);
  assert.doesNotMatch(text, /Token 估算/);
  assert.doesNotMatch(text, /压缩模型/);
  // 轨迹路径仍能从 system 消息尾部解析出来。
  assert.match(text, /压缩前完整记录：\/tmp\/transcript_9\.jsonl/);
  assert.match(text, /整理分支/);
});

test("本地降级摘要在恢复时明确标注", async () => {
  const dir = makeTempDir();
  await seedSession(dir, {
    usage: {
      compactionCount: 1,
      lastCompaction: {
        ...COMPACTION,
        summaryMode: "fallback",
        summaryError: "HTTP 402 账户额度不足",
      },
    },
  });

  const text = await renderResume(dir);
  assert.match(text, /本地降级摘要/);
  // 降级时「压缩模型」标出是哪个模型失败，方便直接换掉它。
  assert.match(text, /压缩模型: glm-5\.2（调用失败）/);
  // 跨会话回放也要带上当时的失败原因，否则只能看到「用了降级摘要」这个结论。
  assert.match(text, /模型摘要调用失败：HTTP 402 账户额度不足/);
});

test("老会话有摘要来源但没记模型名时，压缩模型标为未记录", async () => {
  const dir = makeTempDir();
  await seedSession(dir, {
    usage: {
      compactionCount: 1,
      lastCompaction: { ...COMPACTION, summaryModel: undefined },
    },
  });

  const text = await renderResume(dir);
  // 不编造模型名：老数据只能说明「这次摘要用过模型，但没留下是谁」。
  assert.match(text, /压缩模型: 未记录/);
});

// /resume 与 /clear 的压缩记录同步是 index.ts 注入的实现，这里守着接线不被改回去。
const indexSource = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("selfstate 读会话持久化的压缩记录，/resume 与 /clear 跟着会话重置", () => {
  assert.match(indexSource, /const persistedCompaction = current\.usage\?\.lastCompaction/);
  assert.match(indexSource, /lastCompaction = usage\?\.lastCompaction/);
  assert.match(indexSource, /\.\.\.\(lastCompaction \? \{ lastCompaction \} : \{\}\)/);
});

test("压缩提示里的「压缩模型」与摘要流式显示接线", () => {
  // 摘要模型来自杂活模型注入点，落盘时一并记住，/resume 回放才有据可查。
  assert.match(indexSource, /lastSummaryModel = utility\.model/);
  assert.match(indexSource, /summaryModel: lastSummaryModel/);
  assert.match(indexSource, /压缩模型: \$\{describeCompactionModel\(result\.summaryMode\)\}/);
  // 流式显示受偏好开关控制，且只在可重绘的交互终端里增量渲染。
  assert.match(indexSource, /compactStreamEnabled && ui\.isInteractive\(\)/);
  assert.match(indexSource, /completeStream\(\s*requestMessages,\s*requestOptions,?\s*\)/);
  assert.match(indexSource, /compactStream: enabled/);
  assert.match(indexSource, /command === "compact-stream"/);
});

test("/resume 回放给工具块留渲染配方：区间落在块头上，全文已剥回执外壳", async () => {
  const dir = makeTempDir();
  const writer = new SessionManager(dir);
  writer.saveCurrentSession(
    [
      { role: "user", content: "跑一下测试" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "npm test" }) },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content:
          "[命令执行结果 - 退出码 0；耗时 812ms]\n--- 标准输出 (stdout) ---\nok 1 - a\nok 2 - b\n# pass 2",
      },
      { role: "assistant", content: "测试都过了。" },
    ],
    "跑测试",
  );
  await writer.flush();

  const reader = new SessionManager(dir);
  reader.startNewSession();
  let captured = [];
  const ctx = createContext(reader, []);
  ctx.ui.replaceChatSegments = (pieces) => {
    captured = pieces;
  };
  assert.equal(await resumeLatestSession(ctx), true);
  const fold = captured.find((piece) => piece.kind === "fold");
  assert.ok(fold, "工具调用收成过程段");
  assert.equal(fold.blocks?.length, 1);
  const [block] = fold.blocks;
  assert.match(fold.raw.slice(block.start, block.end), /bash/);
  assert.equal(block.info.toolName, "bash");
  assert.equal(block.info.keep, "tail");
  assert.match(block.info.fullOutput, /# pass 2/);
  assert.doesNotMatch(block.info.fullOutput, /命令执行结果|标准输出/);
});
