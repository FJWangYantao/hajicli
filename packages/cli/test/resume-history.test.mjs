import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// /resume 历史回显逻辑已从 index.ts 抽到 session-commands.ts，源码断言跟随迁移。
const source = fs.readFileSync(new URL("../src/session-commands.ts", import.meta.url), "utf8");

test("/resume 恢复的历史思考标题不显示图标", () => {
  assert.match(
    source,
    /appendHistoryLine\(colors\.gray\(`深度思考 \(\$\{m\.reasoning_content\.length\} 字\)`\)\)/,
  );
  assert.doesNotMatch(source, /💭 深度思考/);
});
