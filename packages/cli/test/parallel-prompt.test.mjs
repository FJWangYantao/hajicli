import assert from "node:assert/strict";
import test from "node:test";

import { ToolsPromptPart } from "@hajicli/core";

const base = { cwd: "/tmp", os: "linux", tools: ["read", "grep", "global", "edit"] };

test("parallel batch guidance is injected only for the treatment arm", () => {
  const part = new ToolsPromptPart();
  const control = part.getContent({ ...base });
  assert.doesNotMatch(control, /同一条回复/);

  const treatment = part.getContent({
    ...base,
    parallelBatchReadOnly: true,
    parallelBatchLimit: 5,
  });
  assert.match(treatment, /同一条回复/);
  assert.match(treatment, /最多 5 个/);
  assert.match(treatment, /read 的结果要用来决定 edit 的参数/);
});

test("batch-first guidance is injected only for the tool_batching treatment arm", () => {
  const part = new ToolsPromptPart();
  const control = part.getContent({ ...base });
  assert.doesNotMatch(control, /queries/);
  assert.doesNotMatch(control, /patterns/);
  assert.doesNotMatch(control, /同一区间不要重复读取/);

  const treatment = part.getContent({ ...base, toolBatching: true });
  assert.match(treatment, /read 的 paths/);
  assert.match(treatment, /grep 的 queries/);
  assert.match(treatment, /global 的 patterns/);
  assert.match(treatment, /同一区间不要重复读取/);
});
test("subagent guidance explains cumulative budgets and partial continuation", () => {
  const content = new ToolsPromptPart().getContent({
    ...base,
    tools: ["subagent", "verifyagent"],
  });
  assert.match(content, /所有轮次输入与输出累计上限/);
  assert.match(content, /每轮重复历史和缓存输入/);
  assert.match(content, /不是上下文窗口或单次输出额度/);
  assert.match(content, /复杂实现任务避免设置小额度/);
  assert.match(content, /completed 或 partial/);
  assert.match(content, /必须独立验证已有进展并继续未完成事项/);
  assert.match(content, /不可将 partial 作为 taskfinish 的完成依据/);
});
