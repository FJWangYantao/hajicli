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

test("/resume 默认把整段思维链写进正文，折叠开关打开时才收成一行", () => {
  // 默认（thinkingVisible）走推理正文块，且不与工具过程段混在一起。
  assert.match(
    source,
    /plain \+= formatReasoningBlock\(m\.reasoning_content, ui\.getContentWidth\(\)\)/,
  );
  assert.match(source, /const thinkingVisible = ctx\.isThinkingVisible\?\.\(\) !== false;/);
});
