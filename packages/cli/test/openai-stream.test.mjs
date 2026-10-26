import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenAICompatibleStream } from "../../plugins/dist/openai-stream.js";

/** 用给定的 SSE 文本构造一个 Response，模拟 provider 的分块下发。 */
function streamResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function sseLine(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(response, completion) {
  const text = [];
  for await (const chunk of parseOpenAICompatibleStream(response, {
    completion,
    provider: "test",
    emptyBodyMessage: "empty",
  })) {
    text.push(chunk);
  }
  return text.join("");
}

test("tool call arguments stream through onToolCallDelta before the final call", async () => {
  const deltas = [];
  let finalCalls;
  const response = streamResponse([
    sseLine({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read" } }] } },
      ],
    }),
    sseLine({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path": ' } }] } }],
    }),
    sseLine({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] } }],
    }),
    sseLine({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);

  const text = await collect(response, {
    onToolCallDelta: (delta) => deltas.push(delta),
    onToolCall: (calls) => {
      finalCalls = calls;
    },
  });

  assert.equal(text, "");
  // 名字先到、参数逐段累积，界面据此显示生成进度。
  assert.deepEqual(
    deltas.map((delta) => [delta.index, delta.name, delta.argumentsText]),
    [
      [0, "read", ""],
      [0, "read", '{"path": '],
      [0, "read", '{"path": "src/a.ts"}'],
    ],
  );
  assert.deepEqual(
    finalCalls?.map((call) => [call.id, call.function.name, call.function.arguments]),
    [["call_1", "read", '{"path": "src/a.ts"}']],
  );
});

test("parallel tool calls report their own index while streaming", async () => {
  const deltas = [];
  const response = streamResponse([
    sseLine({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "a", function: { name: "read" } }],
          },
        },
      ],
    }),
    sseLine({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, id: "b", function: { name: "grep" } },
              { index: 0, function: { arguments: '{"path":' } },
            ],
          },
        },
      ],
    }),
    "data: [DONE]\n\n",
  ]);

  await collect(response, { onToolCallDelta: (delta) => deltas.push(delta) });

  assert.deepEqual(
    deltas.map((delta) => [delta.index, delta.name, delta.argumentsText]),
    [
      [0, "read", ""],
      [1, "grep", ""],
      [0, "read", '{"path":'],
    ],
  );
});

test("reasoning and content still stream when no tool call delta hook is set", async () => {
  const reasoning = [];
  const response = streamResponse([
    sseLine({ choices: [{ delta: { reasoning_content: "想一想" } }] }),
    sseLine({ choices: [{ delta: { content: "答案" } }] }),
    "data: [DONE]\n\n",
  ]);

  const text = await collect(response, { onReasoning: (chunk) => reasoning.push(chunk) });

  assert.equal(text, "答案");
  assert.deepEqual(reasoning, ["想一想"]);
});
