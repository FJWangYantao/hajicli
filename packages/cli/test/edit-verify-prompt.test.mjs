import assert from "node:assert/strict";
import test from "node:test";

import { SystemPromptManager } from "@hajicli/core";

/** 编辑后验证提示分片：只有拿到真实命令时才注入。 */
test("edit verify hint is injected only when a check command is known", async () => {
  const manager = new SystemPromptManager();
  const base = {
    cwd: "/repo",
    os: "linux",
    tools: ["read", "edit", "write", "bash"],
    reasoningEffort: "medium",
  };

  const withHint = await manager.generatePrompt({ ...base, editVerifyCommand: "npx tsc -b" });
  assert.match(withHint, /编辑后自动验证/);
  assert.match(withHint, /npx tsc -b/);
  // 关键是明确告诉模型「不要自己再跑一遍」，否则这条提示只剩上下文成本。
  assert.match(withHint, /不要为了确认自己的改动而重复运行 tsc/);
  // 但任务要求跑测试时必须照跑，不能一刀切禁止验证。
  assert.match(withHint, /任务明确要求跑测试/);

  const withoutHint = await manager.generatePrompt(base);
  assert.doesNotMatch(withoutHint, /编辑后自动验证/);
});
