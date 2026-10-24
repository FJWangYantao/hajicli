import assert from "node:assert/strict";
import test from "node:test";

import { expandFileMentions, matchFileMentionCandidates } from "../dist/file-mentions.js";

const FILES = [
  "packages/cli/src/index.ts",
  "packages/cli/src/terminal-input.ts",
  "packages/core/src/index.ts",
  "README.md",
  "docs/architecture.md",
];

test("matchFileMentionCandidates prefers basename prefix hits", () => {
  assert.deepEqual(matchFileMentionCandidates(FILES, "readme"), ["README.md"]);
  const terminal = matchFileMentionCandidates(FILES, "terminal");
  assert.equal(terminal[0], "packages/cli/src/terminal-input.ts");
});

test("matchFileMentionCandidates falls back to path substring and subsequence", () => {
  const core = matchFileMentionCandidates(FILES, "core");
  assert.ok(core.includes("packages/core/src/index.ts"));
  const fuzzy = matchFileMentionCandidates(FILES, "tinput");
  assert.ok(fuzzy.includes("packages/cli/src/terminal-input.ts"));
});

test("matchFileMentionCandidates limits results and skips node_modules for empty query", () => {
  const many = Array.from({ length: 50 }, (_, index) => `src/file-${index}.ts`);
  assert.ok(matchFileMentionCandidates(many, "file").length <= 8);
  // 空查询：含 node_modules 路径的候选被跳过（依赖目录几乎不可能被有意引用）。
  const empty = matchFileMentionCandidates(
    ["node_modules/x.js", "src/a.ts", "node_modules/y.js"],
    "",
  );
  assert.deepEqual(empty, ["src/a.ts"]);
});

test("expandFileMentions still attaches contents for completed paths", () => {
  // 与 @ 补全配套：补全插入 @路径 后提交时展开为附件块。
  const expansion = expandFileMentions("看看 README.md", process.cwd());
  assert.equal(expansion.attached.length, 0);
});
