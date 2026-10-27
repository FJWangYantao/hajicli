import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatOffPeakWindow,
  isWithinOffPeak,
  parseClockMinute,
  parseOffPeakWindow,
} from "../../plugins/dist/index.js";
import { cachedUsageFields } from "../../plugins/dist/openai-stream.js";
import { loadPreference, savePreference } from "../dist/cli-runtime.js";
import {
  CostTracker,
  effectiveModelPricing,
  estimateRequestCostCny,
} from "../dist/cost-tracker.js";
import {
  describeCurrentTier,
  formatPricingLabel,
  loadPricingOverrides,
  parsePriceInput,
  pricingOrigin,
  recentPricingFailure,
  recordPricingAttempt,
  removePricingOverride,
  resolveModelPricing,
  savePricingOverride,
} from "../dist/model-pricing.js";
import {
  buildPricingAgentMessages,
  deriveUpstreamModel,
  PRICING_AGENT_TOOLS,
  parsePricingAgentReply,
  previewForLog,
  resolveOfficialPricingUrls,
  runPricingAgent,
} from "../dist/pricing-agent.js";
import {
  TerminalInputCancelledError,
  TerminalInputTakenOverError,
  TerminalUI,
} from "../dist/terminal-input.js";
import { buildSidebarFrame } from "../dist/tui-sidebar.js";

/** 每个用例一份独立的定价覆盖表，避免污染真实 ~/.haji/pricing.json。 */
function withTempPricing(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-pricing-"));
  const file = path.join(dir, "pricing.json");
  const previous = process.env.HAJI_PRICING_PATH;
  process.env.HAJI_PRICING_PATH = file;
  try {
    return run(file);
  } finally {
    if (previous === undefined) delete process.env.HAJI_PRICING_PATH;
    else process.env.HAJI_PRICING_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

test("定价覆盖表可写入、读取、删除，非法条目在读取时被忽略", () => {
  withTempPricing((file) => {
    assert.deepEqual(loadPricingOverrides(), {}, "文件缺失时回空表");
    assert.equal(pricingOrigin("cn:custom-model"), "none");

    const saved = savePricingOverride("cn:custom-model", {
      inputPerMTokens: 2,
      outputPerMTokens: 8,
      source: "手动录入",
    });
    assert.equal(saved.ok, true);
    assert.ok(fs.existsSync(file));
    const table = loadPricingOverrides();
    assert.equal(table["cn:custom-model"].inputPerMTokens, 2);
    assert.equal(table["cn:custom-model"].outputPerMTokens, 8);
    assert.equal(table["cn:custom-model"].source, "手动录入");
    assert.equal(pricingOrigin("cn:custom-model"), "override");

    // 0 / 负数不是合法单价：既不写入，也不会在读取时被采纳。
    assert.equal(
      savePricingOverride("cn:bad-model", { inputPerMTokens: 0, outputPerMTokens: 8 }).ok,
      false,
    );
    // 直接改文件（模拟手工编辑）：非法条目被忽略，合法条目仍然生效，删除也不会误伤。
    fs.writeFileSync(
      file,
      JSON.stringify({
        models: {
          "cn:custom-model": { inputPerMTokens: 2, outputPerMTokens: 8 },
          "cn:bad-model": { inputPerMTokens: -1, outputPerMTokens: 3 },
        },
      }),
      "utf8",
    );
    assert.equal(loadPricingOverrides()["cn:bad-model"], undefined);
    assert.equal(loadPricingOverrides()["cn:custom-model"].inputPerMTokens, 2);

    assert.equal(removePricingOverride("cn:custom-model"), true);
    assert.equal(removePricingOverride("cn:custom-model"), false);
  });
});

test("解析单价时内置注册表优先，其次才是本地覆盖", () => {
  withTempPricing(() => {
    assert.equal(resolveModelPricing("deepseek-v4-flash")?.inputPerMTokens, 0.5);
    assert.equal(pricingOrigin("deepseek-v4-flash"), "builtin");

    // 覆盖一个内置模型：注册表仍应优先（内置价是发布时校准过的）。
    savePricingOverride("deepseek-v4-flash", { inputPerMTokens: 99, outputPerMTokens: 99 });
    assert.equal(resolveModelPricing("deepseek-v4-flash")?.inputPerMTokens, 0.5);
    assert.equal(pricingOrigin("deepseek-v4-flash"), "builtin");

    savePricingOverride("cn:deepseek-v4.1-flash", { inputPerMTokens: 0.4, outputPerMTokens: 1.6 });
    const resolved = resolveModelPricing("cn:deepseek-v4.1-flash");
    assert.equal(resolved?.inputPerMTokens, 0.4);
    assert.equal(resolved?.outputPerMTokens, 1.6);
    assert.equal(resolved?.currency, "CNY");
    assert.match(formatPricingLabel(resolved), /¥0\.4 \/ ¥1\.6/);
  });
});

test("手动输入单价容忍 ¥ / 元 前后缀，拒绝非正数", () => {
  assert.equal(parsePriceInput("2"), 2);
  assert.equal(parsePriceInput("¥2.5"), 2.5);
  assert.equal(parsePriceInput("8元"), 8);
  assert.equal(parsePriceInput(" 0.35 "), 0.35);
  assert.equal(parsePriceInput("abc"), undefined);
  assert.equal(parsePriceInput("0"), undefined);
  assert.equal(parsePriceInput("-3"), undefined);
});

test("CostTracker 注入解析器后按覆盖单价计费，并列出未定价模型", () => {
  withTempPricing(() => {
    const tracker = new CostTracker((model) => resolveModelPricing(model));
    tracker.record("cn:custom-model", {
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
      total_tokens: 1_500_000,
    });
    const before = tracker.getSummary();
    assert.equal(before.totalCostCny, 0, "未定价时金额为 0");
    assert.equal(before.hasUnpriced, true);
    assert.deepEqual(before.unpricedModels, ["cn:custom-model"]);

    // 补上单价后，本会话已发生的调用立刻按新价重算（历史记录不落金额）。
    savePricingOverride("cn:custom-model", { inputPerMTokens: 2, outputPerMTokens: 8 });
    const after = tracker.getSummary();
    assert.equal(after.totalCostCny, 2 * 1 + 8 * 0.5);
    assert.equal(after.hasUnpriced, false);
    assert.deepEqual(after.unpricedModels, []);
    assert.equal(after.byModel[0].costCny, 6);
  });
});

test("未定价时 /cost 报告给出补单价入口", () => {
  const tracker = new CostTracker(() => undefined);
  tracker.record("cn:whatever", { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  const report = tracker.formatCostReport().join("\n");
  assert.match(report, /未定价模型 cn:whatever/);
  assert.match(report, /\/cost config/);
});

test("侧栏费用区块可命中，并在未定价时显示配置入口与 agent 状态", () => {
  const frame = buildSidebarFrame(
    {
      usedTokens: 1_000,
      maxTokens: 100_000,
      costCny: 0,
      costRequests: 2,
      hasUnpricedCost: true,
      unpricedModels: ["cn:deepseek-v4.1-flash"],
      promptTokens: 5_000,
      completionTokens: 500,
      pricingAgent: { status: "running", model: "cn:deepseek-v4.1-flash" },
    },
    30,
    30,
  );
  const lines = frame.rows.map(stripAnsi);
  const regions = new Map(frame.regions.map((region) => [region.id, region]));
  const summary = regions.get("cost.summary");
  assert.ok(summary, "费用区块应给出命中区域");
  const sectionTop = lines.findIndex((line) => line.includes("费用"));
  assert.ok(sectionTop >= 0);
  assert.equal(summary.hit.top, sectionTop);
  assert.ok(summary.hit.height >= 2);
  // 未定价时「配置单价」与 agent 状态行各自再套一层更深的命中区。
  assert.ok(regions.has("cost.config"), "配置单价行应有独立命中区");
  assert.ok(regions.has("cost.pricingAgent"), "agent 状态行应有独立命中区");
  assert.ok(lines.some((line) => line.includes("配置单价")));
  assert.ok(lines.some((line) => line.includes("由 agent 查询定价")));

  // 已全部定价时不再出现配置入口，但费用区块仍然可点（可主动改价）。
  const priced = buildSidebarFrame(
    { usedTokens: 1_000, maxTokens: 100_000, costCny: 1.2, costRequests: 1 },
    30,
    30,
  );
  assert.ok(priced.regions.some((region) => region.id === "cost.summary"));
  assert.ok(!priced.regions.some((region) => region.id === "cost.config"));
  assert.ok(!priced.rows.map(stripAnsi).some((line) => line.includes("配置单价")));
});

test("定价 agent 提示词带上模型与 provider，并限定只输出 JSON", () => {
  const messages = buildPricingAgentMessages({
    model: "cn:deepseek-v4.1-flash",
    provider: "workbuddy",
  });
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const user = messages.find((message) => message.role === "user")?.content ?? "";
  assert.match(system, /websearch/);
  assert.match(system, /inputPerMTokens/);
  assert.match(user, /cn:deepseek-v4\.1-flash/);
  assert.match(user, /workbuddy/);
});

test("解析 agent 回复：容忍代码块与解释文字，非法数值一律视为查不到", () => {
  const ok = parsePricingAgentReply(
    '查到了。\n```json\n{"inputPerMTokens": 0.5, "outputPerMTokens": 2, "source": "https://example.com/pricing"}\n```',
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.inputPerMTokens, 0.5);
  assert.equal(ok.outputPerMTokens, 2);
  assert.equal(ok.source, "https://example.com/pricing");

  const shorthand = parsePricingAgentReply('{"input": "1.2", "output": "4"}');
  assert.equal(shorthand.ok, true);
  assert.equal(shorthand.inputPerMTokens, 1.2);

  const unresolved = parsePricingAgentReply('{"unresolved": "官网没有公开定价"}');
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.reason, /官网没有公开定价/);

  assert.equal(parsePricingAgentReply("").ok, false);
  assert.equal(parsePricingAgentReply("大概是几块钱吧").ok, false);
  assert.equal(parsePricingAgentReply('{"inputPerMTokens": 0, "outputPerMTokens": 2}').ok, false);
});

test("定价 agent 循环先检索再结论，拒绝非 websearch 工具，超过步数就放弃", async () => {
  const usedTools = [];
  const outcome = await runPricingAgent({
    query: { model: "cn:custom-model" },
    callModel: async (messages, step) => {
      if (step === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "websearch", arguments: '{"query":"custom model pricing"}' },
            },
            {
              id: "call-2",
              type: "function",
              function: { name: "bash", arguments: '{"command":"echo hi"}' },
            },
          ],
        };
      }
      const toolMessages = messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 2, "两次工具结果都应回灌给模型");
      return { text: '{"inputPerMTokens": 1, "outputPerMTokens": 3, "source": "https://x"}' };
    },
    runTool: async (name, args) => {
      usedTools.push([name, args.query]);
      return "搜索结果：官方定价页 ¥1 / ¥3";
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.inputPerMTokens, 1);
  assert.deepEqual(usedTools, [["websearch", "custom model pricing"]], "只执行允许的工具");

  const stuck = await runPricingAgent({
    query: { model: "cn:stuck" },
    maxSteps: 2,
    callModel: async () => ({
      text: "",
      toolCalls: [
        {
          id: "loop",
          type: "function",
          function: { name: "websearch", arguments: '{"query":"again"}' },
        },
      ],
    }),
    runTool: async () => "没有结果",
  });
  assert.equal(stuck.ok, false);
  assert.match(stuck.reason, /2 步/);
});

test("「已提醒过」的模型名跨会话持久化，避免重复追问", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-prefs-"));
  const file = path.join(dir, "preferences.json");
  try {
    savePreference(
      {
        model: "cn:deepseek-v4.1-flash",
        reasoningEffort: "medium",
        provider: "workbuddy",
        pricingPromptedModels: ["cn:deepseek-v4.1-flash"],
      },
      undefined,
      file,
    );
    const loaded = loadPreference(file);
    assert.deepEqual(loaded.pricingPromptedModels, ["cn:deepseek-v4.1-flash"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 之前点侧栏「费用」会走 ui.cancelInput()，而主循环正 await readInput：
 * 那次取消被主循环当成用户退出，表现为「点一下定价就弹出去」。改成 takeOverInput 后，
 * 主循环拿到的是「接管」而不是「取消」，会继续等下一轮输入。
 */
test("侧栏点击接管输入行：返回草稿但不等于用户取消", async () => {
  const ui = new TerminalUI({
    header: "",
    compactHeader: "",
    inputPrompt: "> ",
    renderBorder: (width) => "-".repeat(width),
  });
  ui.interactive = true;
  if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
  ui.streamRenderTimer = null;
  ui.renderScheduled = false;

  const pending = ui.readInput({});
  ui.dispatchKeypress("1", { name: "1" });
  ui.dispatchKeypress("2", { name: "2" });
  const draft = ui.takeOverInput();
  assert.equal(draft, "12", "未发送的草稿要还给调用方");
  const error = await pending.then(
    () => assert.fail("接管后输入应以错误结束"),
    (err) => err,
  );
  assert.ok(error instanceof TerminalInputTakenOverError);
  assert.equal(
    error instanceof TerminalInputCancelledError,
    false,
    "接管不能被当成用户取消，否则主循环会退出",
  );
  assert.equal(ui.isInputActive(), false);
});

test("中转 provider 的别名去前缀取上游模型，官方定价页按 provider 给出", () => {
  assert.equal(deriveUpstreamModel("cn:deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.equal(deriveUpstreamModel("openai/gpt-4o"), "gpt-4o");
  assert.equal(deriveUpstreamModel("glm-5.2"), "glm-5.2");
  assert.ok(resolveOfficialPricingUrls("deepseek").every((url) => url.startsWith("https://")));
  assert.deepEqual(resolveOfficialPricingUrls("workbuddy"), [], "中转 provider 没有官方定价页");
  assert.deepEqual([...PRICING_AGENT_TOOLS], ["websearch", "webfetch"]);
});

test("提示词带上游模型名与候选定价页，并要求 websearch 失败就换 webfetch", () => {
  const messages = buildPricingAgentMessages({
    model: "cn:deepseek-v4.1-flash",
    provider: "workbuddy",
    officialUrls: ["https://api-docs.deepseek.com/quick_start/pricing"],
  });
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const user = messages.find((message) => message.role === "user")?.content ?? "";
  assert.match(system, /webfetch/);
  assert.match(system, /上游/);
  assert.match(user, /可查的上游模型名：deepseek-v4\.1-flash/);
  assert.match(user, /https:\/\/api-docs\.deepseek\.com\/quick_start\/pricing/);
});

test("定价 agent 允许 webfetch，并把工具结果回灌给模型", async () => {
  const used = [];
  const outcome = await runPricingAgent({
    query: { model: "cn:x" },
    callModel: async (messages, step) => {
      if (step === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "fetch-1",
              type: "function",
              function: {
                name: "webfetch",
                arguments: '{"url":"https://api-docs.deepseek.com/quick_start/pricing"}',
              },
            },
          ],
        };
      }
      const toolMessage = messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /定价/);
      return { text: '{"inputPerMTokens": 0.5, "outputPerMTokens": 2}' };
    },
    runTool: async (name, args) => {
      used.push([name, args.url]);
      return "官方定价：输入 0.5 元/百万，输出 2 元/百万";
    },
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(used, [["webfetch", "https://api-docs.deepseek.com/quick_start/pricing"]]);
});

test("定价 agent 逐事件上报过程，详情页据此还原查询步骤", async () => {
  const events = [];
  const outcome = await runPricingAgent({
    query: { model: "cn:custom-model" },
    callModel: async (_messages, step) =>
      step === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: { name: "websearch", arguments: '{"query":"deepseek pricing"}' },
              },
            ],
          }
        : { text: '{"inputPerMTokens": 2, "outputPerMTokens": 8}' },
    runTool: async () => "网络搜索失败: fetch failed",
    onEvent: (event) => events.push(event),
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["step", "tool", "tool_result", "step", "reply", "done"],
  );
  const tool = events.find((event) => event.type === "tool");
  assert.equal(tool.toolName, "websearch");
  assert.equal(tool.args.query, "deepseek pricing");
  // 工具返回的错误文本会被标成失败，详情页据此一眼看出「被拦截/不通」。
  assert.equal(events.find((event) => event.type === "tool_result").ok, false);
  assert.equal(events.at(-1).outcome.ok, true);
});

test("过程摘要压成单行并限长", () => {
  assert.equal(previewForLog(`a${String.fromCharCode(10, 10)}b   c`), "a b c");
  assert.ok(previewForLog("x".repeat(300)).length <= 121);
});

test("查询失败记进缓存，24 小时内提示不再重复查；手动补价后清空", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-attempts-"));
  const cacheFile = path.join(dir, "pricing-agent-cache.json");
  const previous = process.env.HAJI_PRICING_AGENT_CACHE_PATH;
  process.env.HAJI_PRICING_AGENT_CACHE_PATH = cacheFile;
  try {
    assert.equal(recentPricingFailure("cn:relay-model"), undefined);
    recordPricingAttempt("cn:relay-model", "查不到官方定价");
    const recent = recentPricingFailure("cn:relay-model");
    assert.match(recent, /查询失败/);
    assert.match(recent, /查不到官方定价/);
    assert.ok(fs.existsSync(cacheFile));
    // 超出重试窗口后不再拦截。
    assert.equal(
      recentPricingFailure("cn:relay-model", Date.now() + 25 * 60 * 60 * 1000),
      undefined,
    );
    recordPricingAttempt("cn:relay-model", undefined);
    assert.equal(recentPricingFailure("cn:relay-model"), undefined);
  } finally {
    if (previous === undefined) delete process.env.HAJI_PRICING_AGENT_CACHE_PATH;
    else process.env.HAJI_PRICING_AGENT_CACHE_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("侧栏定价 agent 状态行给出独立命中区（可点开过程详情）", () => {
  const frame = buildSidebarFrame(
    {
      usedTokens: 1_000,
      maxTokens: 100_000,
      costCny: 0.02,
      costRequests: 3,
      hasUnpricedCost: true,
      unpricedModels: ["cn:relay-model"],
      pricingAgent: { status: "failed", model: "cn:relay-model" },
    },
    30,
    30,
  );
  const regions = new Map(frame.regions.map((region) => [region.id, region]));
  const summary = regions.get("cost.summary");
  assert.ok(summary, "费用区块应给出命中区域");
  assert.equal(regions.get("cost.pricingAgent").hit.height, 1);
  const line = stripAnsi(frame.rows[regions.get("cost.pricingAgent").hit.top]);
  assert.match(line, /定价查询失败/);
  // 状态行落在费用区块内部，且比整块更深一层：点击时优先于外层费用区。
  assert.ok(regions.has("cost.summary"));
  assert.ok(regions.get("cost.pricingAgent").hit.top >= summary.hit.top);
  assert.ok(regions.get("cost.pricingAgent").hit.top < summary.hit.top + summary.hit.height);
  assert.ok(
    regions.get("cost.pricingAgent").depth > regions.get("cost.summary").depth,
    "深层区域必须排在后面，命中时才能从后往前先找到它",
  );
});

test("缓存命中的输入 token 按缓存价计费，未上报命中数时按全价", () => {
  // 内置 flash：输入 0.5、输出 2、缓存 0.1（元 / 百万）。
  // 时刻钉在峰时（BEIJING_14）：内置模型有谷时五折，默认取当前时间会在谷时窗口挂。
  assert.equal(
    estimateRequestCostCny(
      "deepseek-v4-flash",
      {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        total_tokens: 1_000_000,
        prompt_cache_hit_tokens: 800_000,
      },
      undefined,
      BEIJING_14,
    ),
    0.2 * 0.5 + 0.8 * 0.1,
  );
  // 没上报 → 全价。
  assert.equal(
    estimateRequestCostCny(
      "deepseek-v4-flash",
      { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      undefined,
      BEIJING_14,
    ),
    0.5,
  );
  // 命中数大于 prompt_tokens（口径不一致）时夹逼，不会算出负数。
  assert.equal(
    estimateRequestCostCny(
      "deepseek-v4-flash",
      {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        total_tokens: 1_000_000,
        prompt_cache_hit_tokens: 5_000_000,
      },
      undefined,
      BEIJING_14,
    ),
    0.1,
  );
});

test("覆盖表可带缓存价，CostTracker 汇总缓存命中并在报告里标出来", () => {
  withTempPricing(() => {
    savePricingOverride("cn:cache-model", {
      inputPerMTokens: 2,
      outputPerMTokens: 8,
      cachedInputPerMTokens: 0.4,
    });
    const pricing = resolveModelPricing("cn:cache-model");
    assert.equal(pricing.cachedInputPerMTokens, 0.4);
    assert.match(formatPricingLabel(pricing), /缓存 ¥0\.4/);

    const tracker = new CostTracker((model) => resolveModelPricing(model));
    tracker.record("cn:cache-model", {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      total_tokens: 1_000_000,
      prompt_cache_hit_tokens: 900_000,
    });
    const summary = tracker.getSummary();
    assert.equal(summary.cachedPromptTokens, 900_000);
    assert.equal(summary.totalCostCny, 0.1 * 2 + 0.9 * 0.4);
    assert.match(tracker.formatCostReport().join(String.fromCharCode(10)), /缓存命中 900,000/);
  });
});

test("provider 上报的缓存字段（两种命名）都能归一成 prompt_cache_hit_tokens", () => {
  assert.deepEqual(cachedUsageFields({ prompt_cache_hit_tokens: 12 }), {
    prompt_cache_hit_tokens: 12,
  });
  assert.deepEqual(cachedUsageFields({ prompt_tokens_details: { cached_tokens: 7 } }), {
    prompt_cache_hit_tokens: 7,
  });
  assert.deepEqual(cachedUsageFields({}), {});
});

test("定价 agent 会带回缓存价；缓存价不低于输入价时丢弃（不编造折扣）", () => {
  const withCache = parsePricingAgentReply(
    '{"inputPerMTokens": 2, "outputPerMTokens": 8, "cachedInputPerMTokens": 0.4}',
  );
  assert.equal(withCache.ok, true);
  assert.equal(withCache.cachedInputPerMTokens, 0.4);

  const bogus = parsePricingAgentReply(
    '{"inputPerMTokens": 2, "outputPerMTokens": 8, "cachedInputPerMTokens": 3}',
  );
  assert.equal(bogus.ok, true);
  assert.equal(bogus.cachedInputPerMTokens, undefined);

  const noCache = parsePricingAgentReply('{"inputPerMTokens": 2, "outputPerMTokens": 8}');
  assert.equal(noCache.cachedInputPerMTokens, undefined);
});

test("侧栏展示缓存命中占比", () => {
  const frame = buildSidebarFrame(
    {
      usedTokens: 1_000,
      maxTokens: 100_000,
      costCny: 0.42,
      costRequests: 3,
      promptTokens: 100_000,
      cachedPromptTokens: 80_000,
      completionTokens: 5_000,
    },
    30,
    30,
  );
  const line = frame.rows.map(stripAnsi).find((row) => row.includes("含缓存"));
  assert.ok(line, "应有一行显示缓存命中");
  assert.match(line, /80%/);
});

/** 北京 02:00（谷时）与北京 14:00（峰时）各取一个时间戳。 */
const BEIJING_02 = Date.parse("2025-01-01T18:00:00Z");
const BEIJING_14 = Date.parse("2025-01-02T06:00:00Z");

test("谷时窗口判定：跨零点、时区偏移与边界", () => {
  const window = { startMinute: 30, endMinute: 8 * 60 + 30, utcOffsetMinutes: 480 };
  assert.equal(isWithinOffPeak(BEIJING_02, window), true);
  assert.equal(isWithinOffPeak(BEIJING_14, window), false);
  // 北京 00:30 是窗口起点（含），00:29 不算。
  assert.equal(isWithinOffPeak(Date.parse("2025-01-01T16:30:00Z"), window), true);
  assert.equal(isWithinOffPeak(Date.parse("2025-01-01T16:29:00Z"), window), false);
  // 跨零点窗口。
  const overnight = { startMinute: 23 * 60, endMinute: 60, utcOffsetMinutes: 0 };
  assert.equal(isWithinOffPeak(Date.parse("2025-01-01T23:30:00Z"), overnight), true);
  assert.equal(isWithinOffPeak(Date.parse("2025-01-02T00:30:00Z"), overnight), true);
  assert.equal(isWithinOffPeak(Date.parse("2025-01-02T02:00:00Z"), overnight), false);
  assert.equal(isWithinOffPeak(Date.now(), { startMinute: 60, endMinute: 60 }), false);
});

test("时钟与时段解析：HH:MM、区间、时区后缀", () => {
  assert.equal(parseClockMinute("08:30"), 510);
  assert.equal(parseClockMinute("0:05"), 5);
  assert.equal(parseClockMinute("24:00"), undefined);
  assert.equal(parseClockMinute("8-30"), undefined);
  assert.deepEqual(parseOffPeakWindow("00:30-08:30"), { startMinute: 30, endMinute: 510 });
  assert.deepEqual(parseOffPeakWindow("23:00-07:00 UTC-5"), {
    startMinute: 23 * 60,
    endMinute: 7 * 60,
    utcOffsetMinutes: -5 * 60,
  });
  assert.equal(parseOffPeakWindow("随便写"), undefined);
  assert.equal(
    formatOffPeakWindow({ startMinute: 30, endMinute: 510, utcOffsetMinutes: 480 }),
    "UTC+8 00:30–08:30",
  );
});

test("内置模型按调用时刻选峰/谷价，缓存命中同样享谷时价", () => {
  const peak = estimateRequestCostCny(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    undefined,
    BEIJING_14,
  );
  const offPeak = estimateRequestCostCny(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    undefined,
    BEIJING_02,
  );
  assert.equal(peak, 0.5);
  assert.equal(offPeak, 0.25);
  // 谷时 + 缓存命中：0.2×0.25 + 0.8×0.05
  assert.equal(
    estimateRequestCostCny(
      "deepseek-v4-flash",
      {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        total_tokens: 1_000_000,
        prompt_cache_hit_tokens: 800_000,
      },
      undefined,
      BEIJING_02,
    ),
    0.2 * 0.25 + 0.8 * 0.05,
  );
  // 没有峰谷分档的模型，两个时刻同价。
  assert.equal(
    estimateRequestCostCny(
      "doubao-pro-32k",
      { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      undefined,
      BEIJING_02,
    ),
    0.8,
  );
});

test("CostTracker 按记录时刻分档，并统计谷时请求数", () => {
  const tracker = new CostTracker();
  tracker.record(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    "主线回合",
    BEIJING_14,
  );
  tracker.record(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    "主线回合",
    BEIJING_02,
  );
  const summary = tracker.getSummary();
  assert.equal(summary.offPeakRequests, 1);
  assert.equal(summary.byModel[0].offPeakRequests, 1);
  assert.equal(summary.totalCostCny, 0.5 + 0.25);
  assert.match(tracker.formatCostReport().join(String.fromCharCode(10)), /谷时 1 次/);
});

test("CostTracker 按轮次汇总，且不同指标改变排序视角", () => {
  const tracker = new CostTracker();
  // 第 1 轮：单次请求。
  tracker.beginTurn();
  tracker.record(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    "主线回合",
    BEIJING_14,
  );
  // 第 2 轮：同一回合里两次请求（工具循环）。
  tracker.beginTurn();
  tracker.record(
    "deepseek-v4-flash",
    { prompt_tokens: 2_000_000, completion_tokens: 1_000_000, total_tokens: 3_000_000 },
    "主线回合",
    BEIJING_14,
  );
  tracker.record(
    "deepseek-v4-flash",
    { prompt_tokens: 500_000, completion_tokens: 0, total_tokens: 500_000 },
    "主线回合",
    BEIJING_14,
  );

  const turns = tracker.getTurnSummaries();
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turn, 1);
  assert.equal(turns[0].requests, 1);
  assert.equal(turns[1].turn, 2);
  assert.equal(turns[1].requests, 2);
  assert.equal(turns[1].promptTokens, 2_500_000);

  // 第 2 轮更贵、请求更多：两种口径都应把它排在第一。
  const costReport = tracker.formatTurnReport("cost").join(String.fromCharCode(10));
  assert.ok(
    costReport.indexOf("第 2 轮") < costReport.indexOf("第 1 轮"),
    "按花费排序时更贵的轮次在前",
  );
  const reqReport = tracker.formatTurnReport("requests").join(String.fromCharCode(10));
  assert.ok(
    reqReport.indexOf("第 2 轮") < reqReport.indexOf("第 1 轮"),
    "按请求次数排序时请求多的轮次在前",
  );
});

test("空回合不占据轮次编号", () => {
  const tracker = new CostTracker();
  tracker.beginTurn(); // 声明开轮但一个请求都没发出。
  tracker.beginTurn();
  tracker.record(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
    "主线回合",
    BEIJING_14,
  );
  const turns = tracker.getTurnSummaries();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn, 1, "跳过的空回合不占号，首次真正记账仍是第 1 轮");
});

test("轮次随会话记录持久化，恢复后续接在原编号之后", () => {
  const tracker = new CostTracker();
  tracker.beginTurn();
  tracker.record(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
    "主线回合",
    BEIJING_14,
  );
  tracker.beginTurn();
  tracker.record(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
    "主线回合",
    BEIJING_14,
  );
  const records = tracker.getRecords();
  assert.equal(records[0].turn, 1);
  assert.equal(records[1].turn, 2);

  const restored = new CostTracker();
  restored.loadRecords(records);
  restored.beginTurn();
  restored.record(
    "deepseek-v4-flash",
    { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
    "主线回合",
    BEIJING_14,
  );
  const turns = restored.getTurnSummaries();
  assert.equal(turns[turns.length - 1].turn, 3, "续接的新轮次接在历史最大轮次之后");
});

test("覆盖表可带谷时配置，非法时段/不更便宜的谷时价被拒", () => {
  withTempPricing(() => {
    const saved = savePricingOverride("cn:peak-model", {
      inputPerMTokens: 2,
      outputPerMTokens: 8,
      offPeak: {
        inputPerMTokens: 1,
        outputPerMTokens: 4,
        window: { startMinute: 30, endMinute: 510, utcOffsetMinutes: 480 },
      },
    });
    assert.equal(saved.ok, true);
    const pricing = resolveModelPricing("cn:peak-model");
    assert.equal(pricing.offPeak.inputPerMTokens, 1);
    assert.match(formatPricingLabel(pricing), /谷时 ¥1 \/ ¥4/);

    // 起止相同 → 视为非法，整段谷时配置被丢弃。
    savePricingOverride("cn:bad-window", {
      inputPerMTokens: 2,
      outputPerMTokens: 8,
      offPeak: {
        inputPerMTokens: 1,
        outputPerMTokens: 4,
        window: { startMinute: 60, endMinute: 60 },
      },
    });
    assert.equal(resolveModelPricing("cn:bad-window")?.offPeak, undefined);

    // 时刻判定跟着覆盖表走。
    const tier = effectiveModelPricing(resolveModelPricing("cn:peak-model"), BEIJING_02);
    assert.equal(tier.offPeak, true);
    assert.equal(tier.inputPerMTokens, 1);
    assert.equal(describeCurrentTier("cn:peak-model", BEIJING_02), "offPeak");
    assert.equal(describeCurrentTier("cn:peak-model", BEIJING_14), "peak");
    assert.equal(describeCurrentTier("cn:no-such-model"), "flat");
  });
});

test("侧栏显示谷时请求数", () => {
  const frame = buildSidebarFrame(
    {
      usedTokens: 1_000,
      maxTokens: 100_000,
      costCny: 0.75,
      costRequests: 2,
      offPeakRequests: 1,
      promptTokens: 2_000,
      completionTokens: 100,
    },
    30,
    30,
  );
  const line = frame.rows.map(stripAnsi).find((row) => row.includes("谷时"));
  assert.ok(line, "应有谷时行");
  assert.match(line, /1 次/);
});
