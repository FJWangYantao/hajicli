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
