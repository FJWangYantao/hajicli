import assert from "node:assert/strict";
import test from "node:test";

import { ActivityIndicator, ToolRunView } from "../dist/activity-indicator.js";
import { TerminalInputCancelledError } from "../dist/terminal-input.js";
import { runAgentTurn } from "../dist/turn-runner.js";

/**
 * 中止回合时，正在工作的工具格不能凭空消失。
 *
 * commitWithBlocks() 只提交已结束的条目，而中止路径不会再回调 finish()：
 * 曾经的结果是格子连同实时区域一起被丢掉，屏幕上只剩一行「已中止本轮」，
 * 用户完全看不出刚才在跑什么。这些用例锁住「中止也要留格」。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TOOL_CALL = {
  id: "call_1",
  type: "function",
  function: { name: "bash", arguments: JSON.stringify({ command: "sleep 30" }) },
};

/**
 * 搭一个只跑「一次工具调用」的回合。
 * executor 决定工具怎么结束：一直挂着等 abort，或直接抛取消错误。
 */
function createHarness(executor, { stream } = {}) {
  const chat = [];
  let liveTail = "";
  let escHandler;
  const ui = {
    getContentWidth: () => 80,
    getChatLength: () => chat.length,
    writeLine: (line = "") => chat.push(line),
    writeBlankLine: () => chat.push(""),
    updateChatFrom: (offset, text) => {
      chat.length = offset;
      if (text) chat.push(...text.split("\n"));
    },
    markStableChatPrefix: () => {},
    writeToolCells: (text) => {
      if (text) chat.push(...text.replace(/\n$/, "").split("\n"));
    },
    setLiveTail: (text) => {
      liveTail = text;
    },
    beginFoldGroup: () => ({ epoch: 0, start: chat.length }),
    sealFoldGroup: () => 0,
    setStatus: () => {},
    setQueue: () => {},
    cancelInput: () => "",
    readInput: async () => "",
    onEsc: (callback) => {
      escHandler = callback;
    },
    appendInlineImage: () => ({ ok: true }),
  };
  // 只有第一次请求发起工具调用，之后的请求回一段正文收尾，避免回合无限循环。
  let requests = 0;
  const provider = {
    async complete() {
      return "";
    },
    async *completeStream(_messages, options = {}) {
      if (stream) {
        yield* stream(_messages, options);
        return;
      }
      options.onRequestStart?.();
      requests += 1;
      if (requests > 1) {
        options.onFinish?.({ reason: "stop" });
        yield "好的";
        return;
      }
      options.onToolCallDelta?.({
        index: 0,
        id: TOOL_CALL.id,
        name: "bash",
        argumentsText: TOOL_CALL.function.arguments,
      });
      options.onToolCall?.([TOOL_CALL]);
      options.onFinish?.({ reason: "tool_calls" });
      yield "";
    },
  };
  const messages = [];
  const deps = {
    ui,
    activityIndicator: new ActivityIndicator({ render: () => {} }),
    toolRunView: new ToolRunView({
      render: (text) => {
        liveTail = text;
      },
      getWidth: () => 80,
    }),
    tracker: { recordUserInput() {}, recordToolBatch() {} },
    sessionManager: {
      saveCurrentSession() {},
      flush: async () => {},
      hasPendingWrites: () => false,
      generateTitleAsync: async () => {},
    },
    skillRegistry: { restoreScopeFromMessages() {} },
    snapshotEngine: { createAnchor: () => "snap-1" },
    hookEngine: { trigger: async () => {} },
    agentManager: { list: () => [] },
    toolExecutor: { execute: executor },
    toolsMap: new Map([["bash", { name: "bash", definition: { name: "bash" } }]]),
    activeTools: () => [{ name: "bash", definition: { name: "bash" } }],
    getProvider: () => provider,
    getSelectedModel: () => "fake-model",
    getReasoningEffort: () => "medium",
    getPermissionMode: () => "auto",
    getRiskThreshold: () => "low",
    getMessages: () => messages,
    setMessages: (next) => {
      messages.length = 0;
      messages.push(...next);
    },
    setLastUserMessageForRecall() {},
    setForegroundAbortSignal() {},
    setLastToolBatchOutputs() {},
    isPlanReadyForReview: () => false,
    setPlanReadyForReview() {},
    isPlanReviewSummaryRequested: () => false,
    setPlanReviewSummaryRequested() {},
    deferredInputDrafts: [],
    pendingInputs: [],
    updateStatusUI() {},
    applyPermissionMode: async () => {},
    readSelectionSafely: async () => ({ value: "auto" }),
    showRuntimeWarning: () => {},
    refreshAgentVerificationContext: () => false,
    startBackgroundInput() {},
    flushImmediateEffects: async () => {},
  };
  const start = () =>
    runAgentTurn(deps, {
      forwardedPrompt: "跑个命令",
      commandInput: "跑个命令",
      promptDisplayStartOffset: 0,
    });
  return { chat, messages, deps, esc: () => escHandler?.(), live: () => liveTail, start };
}

test("执行中按 Esc：工具格以 ⊘ 留在对话区，不凭空消失", async () => {
  const harness = createHarness(
    (_name, _args, context) =>
      new Promise((_resolve, reject) => {
        context.abortSignal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
  );
  const turn = harness.start();
  await sleep(200);
  // 前提：工具确实已经在实时区域里跑起来了。
  assert.match(harness.live(), /sleep 30/);
  harness.esc();
  await turn;

  const text = harness.chat.join("\n");
  assert.match(text, /⊘ bash/);
  assert.match(text, /已中止，未执行/);
  assert.match(text, /已中止本轮/);
  // 草稿格已交给 ToolRunView 接管，不能再补一张，否则中止后会出现两格。
  assert.equal(text.match(/⊘/g).length, 1);
  // 模型侧的消息拓扑不变：被中止的调用仍补一条跳过结果。
  const toolMessage = harness.messages.find((message) => message.role === "tool");
  assert.match(toolMessage.content, /已跳过/);
});

test("取消工具后立即继续：旧调用有配对结果，下一轮能正常完成", async () => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const harness = createHarness(
    (_name, _args, context) =>
      new Promise((resolve) => {
        started();
        context.abortSignal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
  );
  const first = harness.start();
  await ready;
  harness.esc();
  await first;
  const calls = harness.messages.flatMap((message) => message.tool_calls ?? []);
  for (const call of calls) {
    assert.equal(harness.messages.filter((message) => message.tool_call_id === call.id).length, 1);
  }
  await harness.start();
  assert.equal(harness.messages.at(-1).content, "好的");
  assert.equal(harness.messages.filter((message) => message.role === "user").length, 2);
});

test("请求前取消：不提交 prompt，回填后可以重新发送", async () => {
  const harness = createHarness(async () => ({ output: "done", duration: 1 }));
  let submitted = 0;
  harness.deps.tracker.recordUserInput = () => {
    submitted += 1;
  };
  harness.deps.hookEngine.trigger = async (name) => {
    if (name === "UserPromptSubmit") harness.esc();
  };
  await harness.start();
  assert.equal(submitted, 0);
  assert.deepEqual(harness.messages, []);
  assert.deepEqual(harness.deps.deferredInputDrafts, ["跑个命令"]);
  harness.deps.hookEngine.trigger = async () => {};
  await harness.start();
  assert.equal(submitted, 1);
  assert.equal(harness.messages.at(-1).content, "好的");
});

test("正文生成中取消：保留部分输出供下一轮继续", async () => {
  let harness;
  let requests = 0;
  harness = createHarness(
    async () => {
      throw new Error("不应执行工具");
    },
    {
      stream: async function* (_messages, options) {
        options.onRequestStart?.();
        requests += 1;
        if (requests === 1) {
          yield "已完成的部分";
          harness.esc();
        } else {
          assert.ok(_messages.some((message) => message.content === "已完成的部分"));
          yield "继续完成";
        }
      },
    },
  );
  await harness.start();
  assert.equal(harness.messages.at(-1).content, "已完成的部分");
  await harness.start();
  assert.equal(harness.messages.at(-1).content, "继续完成");
});

test("授权卡片上按 Esc（取消错误）：工具格同样以 ⊘ 留在对话区", async () => {
  // 授权卡片被 Esc 取消时，执行器以 TerminalInputCancelledError 收尾。
  const harness = createHarness(
    (_name, _args, context) =>
      new Promise((_resolve, reject) => {
        context.abortSignal?.addEventListener(
          "abort",
          () => reject(new TerminalInputCancelledError()),
          { once: true },
        );
      }),
  );
  const turn = harness.start();
  await sleep(200);
  harness.esc();
  await turn;

  const text = harness.chat.join("\n");
  assert.match(text, /⊘ bash/);
  assert.match(text, /已中止，未执行/);
});

test("工具正常结束时仍是 ✓，closeOpen 不会改写已结束的格子", async () => {
  const harness = createHarness(async () => ({
    output: "done",
    duration: 5,
    images: [],
  }));
  await harness.start();
  const text = harness.chat.join("\n");
  assert.match(text, /✓ bash/);
  assert.doesNotMatch(text, /已中止/);
});

test("参数还在生成时按 Esc：补一张 ⊘ 卡片，交代这次工具调用没执行", async () => {
  const harness = createHarness(async () => ({ output: "", duration: 1 }), {
    // 参数只发一半就挂着，等 Esc 打断；真实 provider 会在 abort 时结束流。
    stream: async function* (_messages, options = {}) {
      options.onRequestStart?.();
      options.onToolCallDelta?.({
        index: 0,
        id: TOOL_CALL.id,
        name: "bash",
        argumentsText: '{"command":"sle',
      });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        options.abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      yield "";
    },
  });
  const turn = harness.start();
  await sleep(200);
  // 前提：草稿格确实已经出现在实时区域（参数正在拼）。
  assert.match(harness.live(), /sle/);
  harness.esc();
  await turn;

  const text = harness.chat.join("\n");
  assert.match(text, /⊘ bash/);
  assert.match(text, /sle/);
  assert.match(text, /已中止，未执行/);
  assert.equal(text.match(/⊘/g).length, 1);
  // 参数没生成完，工具从未执行，也不该进消息历史。
  assert.equal(harness.messages.filter((message) => message.role === "tool").length, 0);
});

test("closeOpen 只收口未结束条目：running / pending / judging 变 ⊘，已完成的不动", () => {
  const rendered = [];
  const view = new ToolRunView({
    render: (text) => rendered.push(text),
    getWidth: () => 80,
  });
  view.register("running", "bash", "跑命令");
  view.start("running");
  view.register("pending", "bash", "等授权");
  view.register("judging", "bash", "判定中");
  view.judge("judging");
  view.register("done", "bash", "已完成");
  view.start("done");
  view.finish("done", { status: "success", text: "ok" }, 12);

  view.closeOpen("已中止，未执行");
  const { text, blocks } = view.commitWithBlocks();
  assert.equal(blocks.length, 4);
  assert.equal(blocks.filter((block) => block.info.status === "rejected").length, 3);
  assert.equal(blocks.find((block) => block.info.summary === "已完成").info.status, "success");
  assert.match(text, /已中止，未执行/);
  // 实时区域在 commit 后必须清空，否则残留的 ● 行会盖住已写入正文的格子。
  assert.equal(rendered.at(-1), "");
});
