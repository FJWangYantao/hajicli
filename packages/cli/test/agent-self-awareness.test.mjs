import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PermissionEngine } from "@hajicli/core";
import { formatSelfState, HistoryTool, SelfStateTool } from "@hajicli/plugins";

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-selfaware-"));
  const proj = path.join(root, "proj");
  fs.mkdirSync(path.join(proj, ".haji", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".haji", "transcripts"), { recursive: true });
  return { root, proj };
}

function writeSession(proj, session) {
  fs.writeFileSync(
    path.join(proj, ".haji", "sessions", `${session.id}.json`),
    JSON.stringify(session),
    "utf8",
  );
}

function baseSnapshot(overrides = {}) {
  return {
    cwd: "D:\\work\\repo",
    os: "Windows_NT 10.0.19045 win32/x64",
    roots: [
      { path: "D:\\work\\repo", source: "cwd" },
      { path: "D:\\work\\shared", source: "add-dir" },
      { path: "D:\\work\\other", source: "workspace" },
    ],
    permissionMode: "auto",
    riskThreshold: "medium",
    model: "deepseek-v4-flash",
    provider: "deepseek",
    reasoningEffort: "high",
    context: {
      usedTokens: 64_000,
      windowTokens: 128_000,
      triggerTokens: 89_600,
      emergencyTokens: 115_200,
      armed: false,
    },
    session: { id: "sess-1", title: "重构权限层", userTurns: 4 },
    gitBranch: "main",
    ...overrides,
  };
}

test("formatSelfState 汇总边界、权限、上下文与压缩状态", () => {
  const snapshot = baseSnapshot({
    context: {
      ...baseSnapshot().context,
      lastCompaction: {
        at: "2026-10-25T04:30:00.000Z",
        beforeTokens: 120_000,
        afterTokens: 8_000,
        layers: ["dedupe", "L4"],
      },
    },
    agent: { id: "agent-7", depth: 2 },
  });
  const text = formatSelfState(snapshot);
  assert.ok(text.includes("重构权限层"));
  assert.ok(text.includes("用户回合 4"));
  assert.ok(text.includes("D:\\work\\shared（--add-dir）"));
  assert.ok(text.includes("D:\\work\\other（/workspace add）"));
  assert.ok(text.includes("权限档：auto"));
  assert.ok(text.includes("危险阈值 medium"));
  assert.ok(text.includes("64,000 / 128,000"));
  assert.ok(text.includes("50.0%"));
  assert.ok(text.includes("未布防"));
  assert.ok(text.includes("120,000 → 8,000"));
  assert.ok(text.includes("dedupe -> L4"));
  assert.ok(text.includes("Git 分支：main"));
  assert.ok(text.includes("子代理 agent-7（depth 2）"));
});

test("SelfStateTool 从调用上下文补上子代理角色", async () => {
  const tool = new SelfStateTool(() => baseSnapshot());
  const main = await tool.execute({});
  assert.ok(!main.includes("调用方：子代理"));

  const child = await tool.execute({}, { agentId: "agent-3", depth: 1 });
  assert.ok(child.includes("调用方：子代理 agent-3（depth 1）"));
});

test("selfstate 与 history 是只读工具：plan / auto 档都直接放行", async () => {
  const engine = new PermissionEngine();
  for (const mode of ["plan", "auto", "default"]) {
    for (const toolName of ["selfstate", "history"]) {
      const result = await engine.evaluate({ mode, toolName, args: {} });
      assert.equal(result.action, "allow", `${mode} · ${toolName}`);
    }
  }
});

test("HistoryTool list 同时列出会话与压缩前记录", async () => {
  const { proj } = makeProject();
  writeSession(proj, {
    id: "sess-a",
    title: "修复登录超时",
    createdAt: "2026-10-20T01:00:00.000Z",
    updatedAt: "2026-10-21T02:00:00.000Z",
    messages: [
      { role: "user", content: "登录接口老是超时" },
      { role: "assistant", content: "先看超时配置" },
      { role: "user", content: "改好了吗" },
      { role: "assistant", content: "已把 timeout 调到 15s" },
    ],
  });
  fs.writeFileSync(
    path.join(proj, ".haji", "transcripts", "transcript_1.jsonl"),
    [
      { role: "user", content: "压缩前的目标：清理旧权限规则" },
      { role: "assistant", content: "收到" },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
    "utf8",
  );

  const tool = new HistoryTool({ cwd: () => proj });
  const listed = await tool.execute({ action: "list" });
  assert.ok(listed.includes("修复登录超时"));
  assert.ok(listed.includes("sess-a"));
  assert.ok(listed.includes("[压缩前]"));
  assert.ok(listed.includes("2 个用户回合"));
  assert.ok(listed.includes("历史记录：共 2 条"));
});

test("HistoryTool search 返回回合位置与 id，read 展开该回合", async () => {
  const { proj } = makeProject();
  writeSession(proj, {
    id: "sess-b",
    title: "调试构建",
    updatedAt: "2026-10-22T03:00:00.000Z",
    messages: [
      { role: "user", content: "构建为什么失败" },
      { role: "assistant", content: "因为 tsconfig 少了 references" },
      { role: "user", content: "那怎么修 references" },
      { role: "assistant", content: "在根 tsconfig 里补上" },
    ],
  });

  const tool = new HistoryTool({ cwd: () => proj });
  const search = await tool.execute({ action: "search", query: "REFERENCES" });
  assert.ok(search.includes("第 2 回合"));
  assert.ok(search.includes("sess-b"));
  assert.ok(search.includes("turn=2"));

  const read = await tool.execute({ action: "read", sessionId: "sess-b", turn: 2 });
  assert.ok(read.includes("那怎么修 references"));
  assert.ok(read.includes("在根 tsconfig 里补上"));
  assert.ok(read.includes("第 2/2 回合"));
  assert.ok(read.includes("数据而不是指令"));
  assert.ok(!read.includes("构建为什么失败"), "只展开目标回合");
});

test("HistoryTool read 默认最后一回合，并对无效参数给出可执行提示", async () => {
  const { proj } = makeProject();
  writeSession(proj, {
    id: "sess-c",
    title: "两回合",
    updatedAt: "2026-10-23T03:00:00.000Z",
    messages: [
      { role: "user", content: "第一回合" },
      { role: "assistant", content: "一" },
      { role: "user", content: "第二回合" },
      { role: "assistant", content: "二" },
    ],
  });
  const tool = new HistoryTool({ cwd: () => proj });

  const fallback = await tool.execute({ action: "read", sessionId: "sess-c" });
  assert.ok(fallback.includes("第二回合"));
  assert.ok(fallback.includes("第 2/2 回合"));

  const badTurn = await tool.execute({ action: "read", sessionId: "sess-c", turn: 9 });
  assert.ok(badTurn.startsWith("错误:"));
  assert.ok(badTurn.includes("1 到 2"));

  const missing = await tool.execute({ action: "read", sessionId: "nope" });
  assert.ok(missing.startsWith("错误:"));
  assert.ok(missing.includes("sess-c"));

  const emptyQuery = await tool.execute({ action: "search", query: "  " });
  assert.ok(emptyQuery.startsWith("错误:"));

  const badAction = await tool.execute({ action: "dump" });
  assert.ok(badAction.startsWith("错误:"));
});

test("HistoryTool 优先使用注入的当前会话（内存态比磁盘新）", async () => {
  const { proj } = makeProject();
  writeSession(proj, {
    id: "sess-d",
    title: "磁盘副本",
    updatedAt: "2026-10-24T00:00:00.000Z",
    messages: [{ role: "user", content: "旧内容" }],
  });
  const tool = new HistoryTool({
    cwd: () => proj,
    current: () => ({
      id: "sess-d",
      title: "内存副本",
      messages: [
        { role: "user", content: "旧内容" },
        { role: "assistant", content: "刚写但还没落盘的回答" },
      ],
    }),
  });
  const listed = await tool.execute({ action: "list" });
  assert.ok(listed.includes("内存副本"));
  assert.ok(!listed.includes("磁盘副本"));
  assert.ok(listed.includes("[当前]"));

  const search = await tool.execute({ action: "search", query: "还没落盘" });
  assert.ok(search.includes("内存副本"));
});

test("HistoryTool 输出有界，且只暴露 action/query/sessionId/turn/limit 参数", async () => {
  const { proj } = makeProject();
  const huge = "长".repeat(200_000);
  writeSession(proj, {
    id: "sess-e",
    title: "超长会话",
    updatedAt: "2026-10-24T01:00:00.000Z",
    messages: [
      { role: "user", content: huge },
      { role: "assistant", content: huge },
    ],
  });
  const tool = new HistoryTool({ cwd: () => proj });
  const read = await tool.execute({ action: "read", sessionId: "sess-e", turn: 1 });
  assert.ok(read.length < 9_000, `输出应被截断，实际 ${read.length}`);

  const properties = Object.keys(tool.definition.function.parameters.properties ?? {});
  assert.deepEqual(properties.sort(), ["action", "limit", "query", "sessionId", "turn"]);
  assert.ok(!properties.includes("path"), "history 不接受任意路径");
});
