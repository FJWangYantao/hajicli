import assert from "node:assert/strict";
import test from "node:test";
import {
  htmlToMarkdown,
  selectFocusedWebText,
  truncateWebMarkdown,
  WebFetchTool,
} from "../../plugins/dist/web-fetch-tool.js";

const page = `<!doctype html><html><head><title>t</title><style>a{}</style></head><body>
<nav><a href="/x">首页</a></nav>
<main>
<h1>安装指南</h1>
<p>先安装 <strong>Node.js</strong>，再看 <a href="/docs/cli">命令行</a>。</p>
<h2>步骤</h2>
<ol><li>下载</li><li>运行 <code>npm i</code></li></ol>
<pre class="language-bash"><code>npm install -g haji
  --verbose
</code></pre>
<table><thead><tr><th>参数</th><th>说明</th></tr></thead><tbody><tr><td>--help</td><td>显示帮助</td></tr></tbody></table>
</main></body></html>`;

const htmlResponse = (body, contentType = "text/html; charset=utf-8") =>
  new Response(body, { headers: { "content-type": contentType } });

test("HTML 转成结构化 Markdown：标题、列表、代码块、表格、链接都保留", () => {
  const markdown = htmlToMarkdown(page, "https://example.com/guide");
  assert.match(markdown, /^# 安装指南$/m);
  assert.match(markdown, /^## 步骤$/m);
  assert.match(
    markdown,
    /先安装 \*\*Node\.js\*\*，再看 \[命令行\]\(https:\/\/example\.com\/docs\/cli\)。/,
  );
  assert.match(markdown, /^1\. 下载$/m);
  assert.match(markdown, /^2\. 运行 `npm i`$/m);
  assert.match(markdown, /```bash\nnpm install -g haji\n {2}--verbose\n```/);
  assert.match(markdown, /^\| 参数 \| 说明 \|$/m);
  assert.match(markdown, /^\| --- \| --- \|$/m);
  assert.match(markdown, /^\| --help \| 显示帮助 \|$/m);
  assert.doesNotMatch(markdown, /首页/, "nav 里的导航文字不该进正文");
  assert.doesNotMatch(markdown, /<[a-z]/i, "不应残留任何标签");
});

test("嵌套列表用缩进表达层级，不是把子项拍平", () => {
  const markdown = htmlToMarkdown(
    "<ul><li>父项<ul><li>子项 A</li><li>子项 B</li></ul></li><li>第二项</li></ul>",
  );
  assert.match(markdown, /^- 父项$/m);
  assert.match(markdown, /^ {2}- 子项 A$/m);
  assert.match(markdown, /^ {2}- 子项 B$/m);
  assert.match(markdown, /^- 第二项$/m);
});

test("没有 thead 的表格把首行当表头，管线符被转义", () => {
  const markdown = htmlToMarkdown(
    "<table><tr><td>模型</td><td>价格</td></tr><tr><td>a|b</td><td>1</td></tr></table>",
  );
  assert.equal(markdown, "| 模型 | 价格 |\n| --- | --- |\n| a\\|b | 1 |");
});

test("导航容器与 40 条以上的纯链接目录被丢弃，正文保留", () => {
  const megaMenu = Array.from(
    { length: 45 },
    (_, index) => `<li><a href="/p${index}">页面 ${index}</a></li>`,
  ).join("");
  const markdown = htmlToMarkdown(
    `<div role="navigation"><a href="/a">导航文字</a></div>` +
      `<div id="site-sidebar"><a href="/b">侧栏文字</a></div>` +
      `<nav>站点导航</nav>` +
      `<article><p>正文段落</p><ul>${megaMenu}</ul></article>`,
  );
  assert.equal(markdown, "正文段落");
});

test("非 HTML 响应原样透传，不被转换器改写", async () => {
  const body = "# 标题\n\n正文 <b>保留</b>\n";
  const tool = new WebFetchTool(async () => htmlResponse(body, "text/plain; charset=utf-8"));
  const output = await tool.execute({ url: "https://example.com/readme.md" });
  assert.equal(
    output,
    `[网页抓取成功 - 目标地址: https://example.com/readme.md]\n\n${body.trim()}`,
  );
});

test("没有 content-type 时按内容判断：HTML 转换、纯文本透传", async () => {
  const html = new WebFetchTool(async () => new Response("<html><body><p>段落</p></body></html>"));
  assert.match(await html.execute({ url: "https://example.com/a" }), /段落/);

  const plain = new WebFetchTool(async () => new Response("plain text\nsecond line"));
  assert.match(await plain.execute({ url: "https://example.com/a" }), /plain text\nsecond line$/);
});

test("HTML 响应带首行信封，且正文是 Markdown 而不是一行文本", async () => {
  const tool = new WebFetchTool(async () => htmlResponse(page));
  const output = await tool.execute({ url: "https://example.com/guide" });
  assert.match(output, /^\[网页抓取成功 - 目标地址: https:\/\/example\.com\/guide\]\n\n# 安装指南/);
  assert.match(output, /\n## 步骤\n/);
  assert.match(output, /\n\| 参数 \| 说明 \|/);
});

test("页面没有正文时给出明确提示", async () => {
  const tool = new WebFetchTool(async () => htmlResponse("<html><body></body></html>"));
  assert.match(
    await tool.execute({ url: "https://example.com/empty" }),
    /（页面没有可提取的正文）/,
  );
});

test("超长页面按块裁剪，不切进代码块，并提示剩余小节", async () => {
  const tool = new WebFetchTool(async () =>
    htmlResponse(
      `<html><body><h1>第一章</h1><p>${"甲".repeat(4000)}</p>` +
        `<h2>第二章</h2><p>${"乙".repeat(4000)}</p>` +
        `<h2>第三章</h2><p>${"丙".repeat(4000)}</p></body></html>`,
    ),
  );
  const output = await tool.execute({ url: "https://example.com/long" });
  assert.ok(output.length <= 8_300, `输出 ${output.length} 应受预算约束`);
  assert.match(output, /# 第一章/);
  assert.match(output, /输出已截断/);
  assert.match(output, /后面还有《第二章》《第三章》等 2 个小节/);
  assert.match(output, /可用 focus 参数定位/);
  assert.doesNotMatch(output, /丙丙丙/, "被裁剪的内容不应出现在正文里");
});

test("focus 按标题小节挑选，而不是按字符窗口截断", () => {
  const filler = "填充".repeat(2_000);
  const markdown = `# 概览\n\n${filler}\n\n## 定价\n\n模型 X 输入 2 输出 8\n\n## 其他\n\n${filler}`;
  const focused = selectFocusedWebText(markdown, "模型 X");
  assert.match(focused, /^\[已按关键词提取相关片段，省略处以 … 标记\]/);
  assert.match(focused, /## 定价\n\n模型 X 输入 2 输出 8/);
  assert.doesNotMatch(focused, /## 其他/);
  // 页首信息保留，模型仍知道自己在看哪一页
  assert.match(focused, /# 概览/);
  assert.ok(focused.length < 2_000);
});

test("focus 未命中时退回字符窗口，仍能捞到长文里的关键词", () => {
  const body = `currency USD ${"navigation ".repeat(1200)} gpt-6.1-sol input 2 output 8 ${"footer ".repeat(1000)}`;
  const text = selectFocusedWebText(body, "gpt-6.1-sol");
  assert.match(text, /currency USD/);
  assert.match(text, /gpt-6.1-sol input 2 output 8/);
  assert.ok(text.length < 7_000);
});

test("truncateWebMarkdown 在块边界截断并报告剩余小节", () => {
  const markdown = `# 一\n\n${"a".repeat(100)}\n\n# 二\n\n${"b".repeat(100)}\n\n# 三\n\n${"c".repeat(100)}`;
  // 预算刚好容下前两节（含第二节正文），第三节放不下；末尾的孤立标题也不能留在输出里。
  const output = truncateWebMarkdown(markdown, 230);
  assert.match(output, /^# 一/);
  assert.match(output, /# 二/);
  assert.doesNotMatch(output, /# 三/);
  assert.match(output, /\[输出已截断：后面还有《三》等 1 个小节，可用 focus 参数定位\]$/);
});

test("单个巨型块也能裁剪，不会返回整页", () => {
  const output = truncateWebMarkdown("x".repeat(500), 100);
  assert.equal(output.slice(0, 100), "x".repeat(100));
  assert.match(output, /后面还有 1 段内容/);
});

test("转换失败不吞异常：抓取错误仍按原样返回", async () => {
  const tool = new WebFetchTool(async () => new Response("nope", { status: 502 }));
  assert.equal(await tool.execute({ url: "https://example.com/bad" }), "网页抓取失败: 状态码 502");

  const broken = new WebFetchTool(async () => {
    throw new Error("ETIMEDOUT");
  });
  assert.match(await broken.execute({ url: "https://example.com/bad" }), /网页抓取失败: ETIMEDOUT/);
});

test("参数缺失与中止走既有语义", async () => {
  const tool = new WebFetchTool(async () => htmlResponse("<p>x</p>"));
  assert.equal(await tool.execute({}), "错误: 缺少 url 参数。");

  const controller = new AbortController();
  controller.abort();
  const aborted = new WebFetchTool(async () => {
    throw new Error("aborted");
  });
  assert.equal(
    await aborted.execute({ url: "https://example.com/a" }, { abortSignal: controller.signal }),
    "[网页抓取已中止]",
  );
});
