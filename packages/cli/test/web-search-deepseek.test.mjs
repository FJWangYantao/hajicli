import assert from "node:assert/strict";
import test from "node:test";
import { WebSearchTool } from "../../plugins/dist/web-search-tool.js";

/** DuckDuckGo Lite 走 HTML 解析（结果链接必须带 result-link 类名）。 */
const ddgHtml = (title = "DDG 兜底结果") =>
  `<a class="result-link" href="https://fallback.example/p">${title}</a>`;

const officialBody = (items) => JSON.stringify({ results: items });

/** 记录调用并按 URL 分派；未登记的 URL 一律失败。 */
function router(routes) {
  const calls = [];
  const fetchPage = async (url, init = {}, options = {}) => {
    calls.push({ url, init, options });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) return handler(url, init);
    }
    throw new TypeError(`unexpected fetch: ${url}`);
  };
  return { calls, fetchPage };
}

test("官方 Search 有 key 时优先命中，并带上 count / need_content=false", async () => {
  const { calls, fetchPage } = router([
    [
      /api\.deepseek\.com\/v1\/tools\/search/,
      async () =>
        new Response(
          officialBody([
            {
              title: "官方文档",
              url: "https://api-docs.deepseek.com/zh-cn/guides/search/",
              snippet: "短摘要",
              summary: "长摘要，适用于给模型阅读",
              rerank_score: 2.4,
              authority: 3,
            },
          ]),
          { headers: { "content-type": "application/json" } },
        ),
    ],
  ]);
  const tool = new WebSearchTool(fetchPage, { deepseekApiKey: () => "sk-test" });
  const output = await tool.execute({ query: "deepseek search api" });

  assert.equal(calls.length, 1, "命中官方源后不应再打免费源");
  assert.match(calls[0].url, /^https:\/\/api\.deepseek\.com\/v1\/tools\/search$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "deepseek search api",
    count: 5,
    need_content: false,
  });

  assert.match(
    output,
    /^\[网络搜索结果 - 检索关键字 "deepseek search api" - 来源 DeepSeek Search\]/,
  );
  assert.match(output, /### 1\. 官方文档/);
  assert.match(output, /https:\/\/api-docs\.deepseek\.com\/zh-cn\/guides\/search\//);
  assert.match(output, /长摘要，适用于给模型阅读/, "应优先用 summary 而不是 snippet");
  assert.doesNotMatch(output, /短摘要/);
});

test("官方源 HTTP 失败时落回 DuckDuckGo，不中断检索", async () => {
  const { calls, fetchPage } = router([
    [/api\.deepseek\.com/, async () => new Response("boom", { status: 500 })],
    [/duckduckgo\.com/, async () => new Response(ddgHtml("DDG 结果"))],
  ]);
  const tool = new WebSearchTool(fetchPage, { deepseekApiKey: () => "sk-test" });
  const output = await tool.execute({ query: "x" });

  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /duckduckgo\.com/);
  assert.match(output, /来源 DuckDuckGo Lite/);
  assert.match(output, /DDG 结果/);
});

test("官方源返回空结果视为失败，继续走公开源", async () => {
  const { calls, fetchPage } = router([
    [/api\.deepseek\.com/, async () => new Response(officialBody([]))],
    [/duckduckgo\.com/, async () => new Response(ddgHtml("兜底"))],
  ]);
  const tool = new WebSearchTool(fetchPage, { deepseekApiKey: () => " " });
  const output = await tool.execute({ query: "x" });

  assert.equal(calls.length, 1, "空白 key 不发起官方请求");
  assert.match(output, /https:\/\/fallback\.example\/p/);

  const second = new WebSearchTool(fetchPage, { deepseekApiKey: () => "sk-test" });
  const output2 = await second.execute({ query: "x" });
  assert.match(output2, /来源 DuckDuckGo Lite/);
});

test("没有 key 时完全不请求官方端点", async () => {
  const { calls, fetchPage } = router([
    [/duckduckgo\.com/, async () => new Response(ddgHtml("零 key"))],
  ]);
  const tool = new WebSearchTool(fetchPage, { deepseekApiKey: () => undefined });
  const output = await tool.execute({ query: "x" });

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].url, /api\.deepseek\.com/);
  assert.match(output, /零 key/);
});

test("中止后不再尝试其余来源", async () => {
  const controller = new AbortController();
  let calls = 0;
  const tool = new WebSearchTool(
    async () => {
      calls += 1;
      controller.abort();
      throw new Error("cancel");
    },
    { deepseekApiKey: () => "sk-test" },
  );
  const output = await tool.execute({ query: "x" }, { abortSignal: controller.signal });
  assert.match(output, /已中止/);
  assert.equal(calls, 1);
});

test("服务端回显的 key 不会出现在失败信息里", async () => {
  const secret = "sk-really-secret-value";
  const tool = new WebSearchTool(
    async (url) => {
      if (/api\.deepseek\.com/.test(url))
        return new Response(`Authentication fails with key ${secret}`, { status: 401 });
      throw new TypeError("blocked");
    },
    { deepseekApiKey: () => secret },
  );
  const output = await tool.execute({ query: "x" });

  assert.match(output, /网络搜索失败/);
  assert.match(output, /DeepSeek Search: HTTP 401/);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /redacted.*redacted/, "只替换一次即可");
});

test("官方 summary 逐条封顶，不会把上下文撑爆", async () => {
  const filler = "长".repeat(3000);
  const tool = new WebSearchTool(
    async () =>
      new Response(
        officialBody(
          Array.from({ length: 3 }, (_, i) => ({
            title: `结果 ${i}`,
            url: `https://example.com/${i}`,
            summary: `${i}${filler}`,
          })),
        ),
      ),
    { deepseekApiKey: () => "sk-test" },
  );
  const output = await tool.execute({ query: "x" });

  assert.ok(output.length <= 8000, `输出长度 ${output.length} 应受总预算约束`);
  assert.match(output, /### 3\. 结果 2/);
});

test("自定义 baseUrl 生效（中转或自建端点）", async () => {
  const { calls, fetchPage } = router([
    [
      /relay\.example/,
      async () =>
        new Response(officialBody([{ title: "t", url: "https://e.com/a", summary: "s" }])),
    ],
  ]);
  const tool = new WebSearchTool(fetchPage, {
    deepseekApiKey: () => "sk-test",
    deepseekBaseUrl: () => "https://relay.example/v1/",
  });
  await tool.execute({ query: "x" });
  assert.match(calls[0].url, /^https:\/\/relay\.example\/v1\/tools\/search$/);
});
