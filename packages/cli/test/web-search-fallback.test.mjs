import assert from "node:assert/strict";
import test from "node:test";
import { selectFocusedWebText } from "../../plugins/dist/web-fetch-tool.js";
import { WebSearchTool } from "../../plugins/dist/web-search-tool.js";

const rss =
  "<rss><channel><item><title><![CDATA[API &amp; pricing]]></title><link>https://example.com/pricing?a=1&amp;b=2</link><description>Tokens &#36;2</description></item></channel></rss>";

test("DDG transport failure falls back to Bing RSS and decodes entities", async () => {
  const calls = [];
  const tool = new WebSearchTool(async (url, init, options) => {
    calls.push(url);
    assert.equal(options.timeoutMs, 12000);
    assert.ok(init.signal);
    if (calls.length === 1) throw new TypeError("fetch failed");
    return new Response(rss);
  });
  const output = await tool.execute({ query: "model pricing" });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /bing\.com/);
  assert.match(output, /API & pricing/);
  assert.match(output, /a=1&b=2/);
  assert.match(output, /Tokens \$2/);
});

test("DDG accepts arbitrary attribute order, redirects, and missing snippets", async () => {
  const tool = new WebSearchTool(
    async () =>
      new Response(
        `<a href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp' class='other result-link'>A &amp; B</a><a class="result-link" href="javascript:bad">bad</a>`,
      ),
  );
  const output = await tool.execute({ query: "x" });
  assert.match(output, /https:\/\/example.com\/p/);
  assert.match(output, /A & B/);
  assert.match(output, /无摘要/);
  assert.doesNotMatch(output, /javascript/);
});

test("HTTP failure and challenge pages continue to final backend", async () => {
  let count = 0;
  const tool = new WebSearchTool(async () => {
    count++;
    if (count === 1) return new Response("blocked", { status: 403 });
    return new Response(count === 2 ? "<html>captcha</html>" : rss);
  });
  assert.match(await tool.execute({ query: "x" }), /Bing CN RSS/);
  assert.equal(count, 3);
});

test("all failures include nested codes without exposing proxy credentials", async () => {
  const tool = new WebSearchTool(async () => {
    throw new Error("https://user:password@proxy", {
      cause: Object.assign(new Error("secret"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
  });
  const output = await tool.execute({ query: "x" });
  assert.match(output, /^网络搜索失败/);
  assert.match(output, /UND_ERR_CONNECT_TIMEOUT/);
  assert.doesNotMatch(output, /password|secret/);
});

test("abort stops fallback and an already aborted call does not fetch", async () => {
  const controller = new AbortController();
  let calls = 0;
  const tool = new WebSearchTool(async () => {
    calls++;
    controller.abort();
    throw new Error("cancel");
  });
  const context = { abortSignal: controller.signal };
  assert.match(await tool.execute({ query: "x" }, context), /已中止/);
  assert.match(await tool.execute({ query: "x" }, context), /已中止/);
  assert.equal(calls, 1);
});

test("late pricing rows survive focused extraction", () => {
  const body = `currency USD ${"navigation ".repeat(1200)} gpt-6.1-sol input 2 output 8 ${"footer ".repeat(1000)}`;
  const text = selectFocusedWebText(body, "gpt-6.1-sol");
  assert.match(text, /currency USD/);
  assert.match(text, /gpt-6.1-sol input 2 output 8/);
  assert.ok(text.length < 7000);
  assert.equal(selectFocusedWebText(body, "missing"), body);
});
