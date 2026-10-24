import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  AlwaysThinkingAdapter,
  adaptPayloadForAlwaysThinking,
  clampEffortForAlwaysThinking,
  isAlwaysThinkingConflict,
  OpenAICompatibleProvider,
} from "@hajicli/plugins";

const CONFLICT_MESSAGE =
  "This model always engages in thinking and cannot be disabled; please use low, high, or max";

test("isAlwaysThinkingConflict 只匹配智谱永远思考模型的 400 文案", () => {
  assert.equal(isAlwaysThinkingConflict(CONFLICT_MESSAGE), true);
  assert.equal(isAlwaysThinkingConflict("cannot be disabled for this endpoint"), true);
  assert.equal(isAlwaysThinkingConflict("Insufficient balance"), false);
  assert.equal(isAlwaysThinkingConflict("Invalid model name"), false);
  assert.equal(isAlwaysThinkingConflict(""), false);
});

test("clampEffortForAlwaysThinking 向上钳制到 low/high/max 集合", () => {
  assert.equal(clampEffortForAlwaysThinking("medium"), "high");
  assert.equal(clampEffortForAlwaysThinking("xhigh"), "max");
  assert.equal(clampEffortForAlwaysThinking("low"), "low");
  assert.equal(clampEffortForAlwaysThinking("high"), "high");
  assert.equal(clampEffortForAlwaysThinking("max"), "max");
});

test("adaptPayloadForAlwaysThinking 删除 disabled thinking 并钳制档位", () => {
  const payload = {
    model: "glm-5.3",
    thinking: { type: "disabled" },
    reasoning_effort: "xhigh",
  };
  assert.equal(adaptPayloadForAlwaysThinking(payload), true);
  assert.equal("thinking" in payload, false);
  assert.equal(payload.reasoning_effort, "max");

  // enabled thinking 与合法档位不修改；无相关字段不修改。
  const clean = { model: "glm-5.3", thinking: { type: "enabled" }, reasoning_effort: "high" };
  assert.equal(adaptPayloadForAlwaysThinking(clean), false);
  assert.deepEqual(clean, {
    model: "glm-5.3",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  const empty = { model: "glm-5.3" };
  assert.equal(adaptPayloadForAlwaysThinking(empty), false);
});

test("AlwaysThinkingAdapter 首次冲突吸收后按模型记忆", () => {
  const adapter = new AlwaysThinkingAdapter();
  const payload = { model: "glm-5.3", reasoning_effort: "medium" };

  // 非 400 或文案不匹配：不吸收、不修改。
  assert.equal(adapter.absorb("glm-5.3", payload, 429, CONFLICT_MESSAGE), false);
  assert.equal(adapter.absorb("glm-5.3", payload, 400, "other error"), false);
  assert.equal(payload.reasoning_effort, "medium");

  // 命中冲突：吸收并修改 payload。
  assert.equal(adapter.absorb("glm-5.3", payload, 400, CONFLICT_MESSAGE), true);
  assert.equal(payload.reasoning_effort, "high");

  // 已记忆模型：后续请求发送前直接适配，再次 absorb 返回 false。
  const next = { model: "glm-5.3", thinking: { type: "disabled" }, reasoning_effort: "medium" };
  adapter.applyKnown("glm-5.3", next);
  assert.equal("thinking" in next, false);
  assert.equal(next.reasoning_effort, "high");
  assert.equal(adapter.absorb("glm-5.3", next, 400, CONFLICT_MESSAGE), false);

  // 其他模型不受影响。
  const other = { model: "glm-4.5", reasoning_effort: "medium" };
  adapter.applyKnown("glm-4.5", other);
  assert.equal(other.reasoning_effort, "medium");
});

test("OpenAICompatibleProvider 遇永远思考 400 自动适配重试并缓存", async () => {
  const received = [];
  let conflictOnce = true;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body);
      received.push(payload);
      const hasDisabledThinking = payload.thinking?.type === "disabled";
      const effortInvalid =
        typeof payload.reasoning_effort === "string" &&
        !["low", "high", "max"].includes(payload.reasoning_effort);
      if (conflictOnce && (hasDisabledThinking || effortInvalid)) {
        conflictOnce = false;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: CONFLICT_MESSAGE } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    defaultModel: "glm-5.3",
    providerName: "test-zhipu",
  });

  try {
    // 第一次调用：disabled + medium 档位 → 400 → 自动适配重试成功。
    const first = await provider.complete([{ role: "user", content: "hi" }], {
      thinking: false,
      reasoningEffort: "medium",
    });
    assert.equal(first, "ok");
    assert.equal(received.length, 2);
    assert.equal(received[0].thinking?.type, "disabled");
    assert.equal(received[0].reasoning_effort, "medium");
    assert.equal("thinking" in received[1], false);
    assert.equal(received[1].reasoning_effort, "high");

    // 第二次调用：模型已记忆，直接发送合法参数，不再触发 400。
    received.length = 0;
    const second = await provider.complete([{ role: "user", content: "again" }], {
      thinking: false,
      reasoningEffort: "xhigh",
    });
    assert.equal(second, "ok");
    assert.equal(received.length, 1);
    assert.equal("thinking" in received[0], false);
    assert.equal(received[0].reasoning_effort, "max");
  } finally {
    server.close();
  }
});

test("OpenAICompatibleProvider 对无关 400 错误不做适配重试", async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls += 1;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Model not found" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    defaultModel: "missing-model",
    providerName: "test-plain",
  });

  try {
    await assert.rejects(
      provider.complete([{ role: "user", content: "hi" }], { reasoningEffort: "medium" }),
      /Model not found/,
    );
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});
