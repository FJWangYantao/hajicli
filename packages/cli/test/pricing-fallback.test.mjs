import assert from "node:assert/strict";
import test from "node:test";
import {
  PRICING_AGENT_MAX_TOOL_CALLS,
  resolveOfficialPricingUrls,
  runPricingAgent,
} from "../dist/pricing-agent.js";
import { detectProviderForModel, findProviderForModel } from "../dist/provider-models.js";

const url = "https://openai.com/api/pricing/";
const answer = JSON.stringify({ inputPerMTokens: 2, outputPerMTokens: 8, source: url });
const call = (name, args, id = "call") => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

test("magpie GPT candidates never inherit DeepSeek route default", () => {
  const config = { providers: { magpie: { models: ["codex/gpt-6.1-sol"] } } };
  assert.equal(findProviderForModel("codex/gpt-6.1-sol", config), "magpie");
  const urls = resolveOfficialPricingUrls("magpie", "codex/gpt-6.1-sol");
  assert.ok(urls.length >= 2);
  assert.ok(urls.every((value) => new URL(value).hostname.endsWith("openai.com")));
  assert.deepEqual(resolveOfficialPricingUrls(undefined, "unknown-zzzz"), []);
  assert.equal(detectProviderForModel("deepseek-flash"), "deepseek");
});

test("early unresolved automatically fetches remaining official candidate", async () => {
  const used = [];
  const result = await runPricingAgent({
    query: { model: "codex/gpt-6.1-sol", provider: "magpie", officialUrls: [url] },
    callModel: async (_messages, step) => ({
      text: step === 1 ? '{"unresolved":"search failed"}' : answer,
    }),
    runTool: async (name, args) => {
      used.push(name);
      assert.equal(args.focus, "gpt-6.1-sol");
      return "GPT-6.1 Sol input 2 output 8";
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(used, ["webfetch"]);
});

test("failed first candidate can recover through second official page", async () => {
  const used = [];
  const result = await runPricingAgent({
    query: { model: "gpt-6.1-sol", officialUrls: ["https://developers.openai.com/pricing", url] },
    callModel: async (_messages, step) => ({
      text: step < 3 ? '{"unresolved":"missing"}' : answer,
    }),
    runTool: async (_name, args) => {
      used.push(args.url);
      return used.length === 1 ? "网页抓取失败: 状态码 403" : "gpt-6.1-sol input 2 output 8";
    },
  });
  assert.equal(result.ok, true);
  assert.equal(used.length, 2);
});

test("unverified, wrong-model and URL-only prices are rejected", async () => {
  for (const output of [
    "网页抓取失败: 状态码 403",
    "gpt-6.1 input 2 output 8",
    "gpt-6.1-sol-preview input 2 output 8",
    `[网页抓取成功 - 目标地址: https://example.com/gpt-6.1-sol]\n\nNo model here`,
  ]) {
    const result = await runPricingAgent({
      query: { model: "gpt-6.1-sol", officialUrls: [] },
      maxSteps: 2,
      callModel: async (_messages, step) =>
        step === 1 ? { text: "", toolCalls: [call("webfetch", { url })] } : { text: answer },
      runTool: async () => output,
    });
    assert.equal(result.ok, false, output);
  }
});

test("known model family rejects prices from unrelated hosts", async () => {
  const blog = "https://example.com/pricing";
  const result = await runPricingAgent({
    query: { model: "gpt-6.1-sol" },
    maxSteps: 2,
    callModel: async (_messages, step) =>
      step === 1
        ? { text: "", toolCalls: [call("webfetch", { url: blog })] }
        : { text: JSON.stringify({ inputPerMTokens: 2, outputPerMTokens: 8, source: blog }) },
    runTool: async () => "gpt-6.1-sol input 2 output 8",
  });
  assert.equal(result.ok, false);
});

test("deduplicates calls and enforces a hard tool budget", async () => {
  let calls = 0;
  const result = await runPricingAgent({
    query: { model: "unknown", officialUrls: [] },
    maxSteps: 2,
    callModel: async () => ({
      text: "",
      toolCalls: Array.from({ length: 20 }, (_, i) =>
        call("websearch", { query: `q${i}` }, `id${i}`),
      ),
    }),
    runTool: async () => {
      calls++;
      return "网络搜索失败: test";
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, PRICING_AGENT_MAX_TOOL_CALLS);
});

test("cancellation during automatic fallback prevents further model requests", async () => {
  const controller = new AbortController();
  let requests = 0;
  const result = await runPricingAgent({
    query: { model: "gpt-6.1-sol", officialUrls: [url] },
    abortSignal: controller.signal,
    callModel: async () => {
      requests++;
      return { text: '{"unresolved":"missing"}' };
    },
    runTool: async () => {
      controller.abort();
      return "cancel";
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /取消/);
  assert.equal(requests, 1);
});
