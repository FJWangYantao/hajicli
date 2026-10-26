import assert from "node:assert/strict";
import test from "node:test";

import { ReasoningBlockWriter } from "../dist/cli-runtime.js";

/** 极简对话区替身：只记录锚点改写与整体写入，语义与 TerminalUI 用到的部分一致。 */
function fakeTarget({ interactive = true, width = 40, head = "已有内容\n" } = {}) {
  const state = {
    chat: head,
    writes: [],
    updates: [],
  };
  return {
    state,
    getChatLength: () => state.chat.length,
    getContentWidth: () => width,
    isInteractive: () => interactive,
    updateChatFrom: (offset, value) => {
      state.updates.push({ offset, value });
      state.chat = state.chat.slice(0, offset) + value;
    },
    writeLine: (value = "") => {
      state.writes.push(value);
      state.chat += `${value}\n`;
    },
  };
}

test("推理块改写同一锚点，收尾后正文可以接在下面", () => {
  const target = fakeTarget();
  const writer = new ReasoningBlockWriter(target);
  const anchor = target.state.chat.length;

  // 小于 16 字的增量先不改写对话区（避免每帧重排）。
  assert.equal(writer.append("先看目录。"), false);
  const long = "先看目录，再确认默认值。".repeat(4);
  assert.equal(writer.append(long), true);
  assert.equal(target.state.updates.at(-1).offset, anchor);
  assert.match(target.state.chat, /· 先看目录/);

  // 继续增长仍然改写同一锚点，不会把上一次的内容累加。
  writer.append(`${long}${"再看实现。".repeat(4)}`);
  assert.ok(target.state.updates.every((update) => update.offset === anchor));
  assert.equal(target.state.chat.split("先看目录").length - 1 > 0, true);

  // 收尾：写满并停止改写；之后的正文起点就是当时的对话区长度。
  writer.seal(`${long}${"再看实现。".repeat(4)}尾巴`);
  const afterSeal = target.state.chat.length;
  assert.equal(writer.isSealed, true);
  assert.equal(writer.append("不该再出现"), false);
  assert.equal(target.state.chat.length, afterSeal);
  assert.ok(target.state.chat.endsWith("\n"));
  assert.match(target.state.chat, /尾巴/);
});

test("关闭思维链显示时整体空转，不动对话区", () => {
  const target = fakeTarget();
  const writer = new ReasoningBlockWriter(target, false);
  assert.equal(writer.append("随便写点什么。".repeat(5)), false);
  assert.equal(writer.seal("随便写点什么。".repeat(5)), false);
  assert.deepEqual(target.state.updates, []);
  assert.deepEqual(target.state.writes, []);
});

test("管道模式只在收尾时整体写一次，不重复回放增量", () => {
  const target = fakeTarget({ interactive: false });
  const writer = new ReasoningBlockWriter(target);
  const text = "第一步确认需求。第二步读代码。".repeat(3);

  assert.equal(writer.append(text), false);
  assert.deepEqual(target.state.writes, []);
  assert.equal(writer.seal(text), true);
  assert.equal(target.state.writes.length, 1);
  assert.match(target.state.writes[0], /第一步确认需求/);
  // trimEnd：块尾的换行交给 writeLine 补，不产生两行空行。
  assert.ok(!target.state.writes[0].endsWith("\n"));
  assert.equal(writer.seal(text), false);
  assert.equal(target.state.writes.length, 1);
});
