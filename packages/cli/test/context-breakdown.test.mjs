import assert from "node:assert/strict";
import test from "node:test";

import { estimateMessagesTokens } from "@hajicli/core";
import {
  buildContextBreakdown,
  buildContextItemGroups,
  CONTEXT_CATEGORIES,
  CONTEXT_CATEGORY_LABELS,
  totalBreakdownTokens,
} from "../dist/context-breakdown.js";

function toolCall(id, name) {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

function toolDefinition(name) {
  return {
    type: "function",
    function: { name, description: `${name} 的描述`, parameters: { type: "object" } },
  };
}

test("every category has a short Chinese label and a stable draw order", () => {
  assert.equal(CONTEXT_CATEGORIES.length, 6);
  for (const category of CONTEXT_CATEGORIES) {
    const label = CONTEXT_CATEGORY_LABELS[category];
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0 && label.length <= 2, `${category} 的图例标签要能塞进侧栏`);
  }
});

test("messages are split by role and by the tool that produced them", () => {
  const messages = [
    { role: "system", content: "系统提示词" },
    { role: "user", content: "帮我看看这个文件" },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("c1", "read"), toolCall("c2", "bash"), toolCall("c3", "loadskill")],
    },
    { role: "tool", tool_call_id: "c1", content: "文件正文".repeat(60) },
    { role: "tool", tool_call_id: "c2", content: "命令输出".repeat(20) },
    { role: "tool", tool_call_id: "c3", content: "技能说明".repeat(60) },
    { role: "assistant", content: "看完了" },
  ];
  const breakdown = buildContextBreakdown(messages, [toolDefinition("read")]);

  assert.ok(breakdown.system > 0, "系统提示词单独成类");
  assert.ok(breakdown.conversation > 0, "用户与助手正文算会话内容");
  assert.ok(breakdown.file > breakdown.toolResult, "read 的结果计入「文件」");
  assert.equal(
    breakdown.memory,
    4 + Math.ceil("技能说明".repeat(60).length * 0.7),
    "loadskill 的结果计入「记忆」",
  );
  assert.ok(breakdown.tools > 0, "工具定义单独成类");
});

test("a tool result whose call cannot be traced falls back to tool results", () => {
  const orphan = { role: "tool", tool_call_id: "missing", content: "孤立结果" };
  const breakdown = buildContextBreakdown([orphan]);
  assert.ok(breakdown.toolResult > 0);
  assert.equal(breakdown.file, 0);
  assert.equal(breakdown.memory, 0);
});

test("empty history and missing definitions both collapse to zero", () => {
  const empty = buildContextBreakdown([]);
  for (const category of CONTEXT_CATEGORIES) assert.equal(empty[category], 0);
  assert.equal(totalBreakdownTokens(empty), 0);

  const withoutTools = buildContextBreakdown([{ role: "user", content: "你好" }]);
  assert.equal(withoutTools.tools, 0);
});

test("the parts always add up to the total the sidebar shows", () => {
  const messages = [
    { role: "system", content: "系统提示词".repeat(30) },
    { role: "user", content: "q".repeat(200) },
    { role: "assistant", content: "", tool_calls: [toolCall("c1", "grep")] },
    { role: "tool", tool_call_id: "c1", content: "命中".repeat(80) },
    { role: "assistant", content: "a".repeat(120) },
  ];
  const definitions = [toolDefinition("grep"), toolDefinition("bash")];
  const breakdown = buildContextBreakdown(messages, definitions);
  const expected = estimateMessagesTokens(messages, { includeSystem: true }) + breakdown.tools;
  assert.equal(totalBreakdownTokens(breakdown), expected);
});

test("tool definition tokens are cached per tool set", () => {
  const definitions = [toolDefinition("read")];
  const first = buildContextBreakdown([], definitions).tools;
  const second = buildContextBreakdown([], definitions).tools;
  assert.equal(first, second);
  const wider = buildContextBreakdown([], [...definitions, toolDefinition("bash")]).tools;
  assert.ok(wider > first, "工具集合变化后必须重算");
});

test("item groups mirror the breakdown totals and keep every entry summed", () => {
  const messages = [
    { role: "system", content: "系统提示词".repeat(30) },
    { role: "user", content: "问题".repeat(20) },
    { role: "assistant", content: "", tool_calls: [toolCall("c1", "read")] },
    { role: "tool", tool_call_id: "c1", content: "文件正文".repeat(40) },
    { role: "assistant", content: "看完了".repeat(10) },
  ];
  const definitions = [toolDefinition("read"), toolDefinition("bash")];
  const breakdown = buildContextBreakdown(messages, definitions);
  const groups = buildContextItemGroups(messages, definitions);

  assert.deepEqual(
    groups.map((group) => group.category),
    [...CONTEXT_CATEGORIES],
    "分类顺序与侧栏图例一致",
  );
  for (const group of groups) {
    assert.equal(
      group.tokens,
      breakdown[group.category],
      `${group.category} 的合计必须等于圆环分项`,
    );
    const sum = group.items.reduce((acc, item) => acc + item.tokens, 0);
    assert.equal(sum, group.tokens, `${group.category} 的条目 tokens 之和必须等于分类合计`);
  }
});

test("tool results carry the call arguments and the result body", () => {
  const call = {
    id: "c9",
    type: "function",
    function: { name: "read", arguments: JSON.stringify({ path: "AGENTS.md" }) },
  };
  const messages = [
    { role: "assistant", content: "", tool_calls: [call] },
    { role: "tool", tool_call_id: "c9", content: "正文内容" },
  ];
  const fileGroup = buildContextItemGroups(messages).find((group) => group.category === "file");
  assert.equal(fileGroup.items.length, 1);
  assert.equal(fileGroup.items[0].label, "read AGENTS.md", "标题带工具名与关键参数");
  assert.match(fileGroup.items[0].detail, /AGENTS\.md/, "详情里能看到入参");
  assert.match(fileGroup.items[0].detail, /正文内容/, "详情里能看到结果");
  assert.equal(fileGroup.items[0].messageIndex, 1, "记住消息下标，供页面跳回");
});

test("tool definitions and conversation entries are labelled by ordinal", () => {
  const messages = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "assistant", content: "第二答" },
  ];
  const groups = buildContextItemGroups(messages, [toolDefinition("grep")]);
  const conversation = groups.find((group) => group.category === "conversation");
  assert.deepEqual(
    conversation.items.map((item) => item.label),
    ["用户 #1", "助手 #1", "助手 #2"],
    "同角色条目按出现顺序编号",
  );
  const tools = groups.find((group) => group.category === "tools");
  assert.equal(tools.items[0].label, "工具定义 grep");
  assert.match(tools.items[0].detail, /"parameters"/, "详情是完整的 schema");
});

test("empty history still returns six empty groups", () => {
  const groups = buildContextItemGroups([]);
  assert.equal(groups.length, CONTEXT_CATEGORIES.length);
  for (const group of groups) {
    assert.equal(group.tokens, 0);
    assert.equal(group.items.length, 0);
  }
});

test("an untraceable tool call keeps its result but loses the name", () => {
  const groups = buildContextItemGroups([{ role: "tool", tool_call_id: "gone", content: "孤立" }]);
  const toolResult = groups.find((group) => group.category === "toolResult");
  assert.equal(toolResult.items.length, 1);
  assert.equal(toolResult.items[0].label, "(未知工具)");
  assert.match(toolResult.items[0].detail, /孤立/);
});
