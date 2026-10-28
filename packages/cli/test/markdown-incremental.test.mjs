import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownStreamRenderer } from "../dist/markdown-renderer.js";
import {
  resetActiveColorLevel,
  resetActiveTheme,
  resetThemeAppearance,
  setActiveColorLevel,
  setThemeAppearance,
} from "../dist/theme.js";

/**
 * 这些用例锁的是增量解析的**等价性**：命中前缀缓存后只解析尾部，结果必须与
 * 一个全新 renderer 的全量解析逐字节相同。缓存是纯优化，不允许改变任何输出。
 */

/** 全新 renderer 的全量渲染（无缓存可命中），作为基准。 */
function baseline(content, { isFinal = false, width = 80 } = {}) {
  return new MarkdownStreamRenderer(() => width).render(content, isFinal);
}

/** 同一 renderer 逐 chunk 流式渲染，每帧都必须与全量基准逐字节相等。 */
function assertStreamingMatchesBaseline(chunks, { width = 80, label = "" } = {}) {
  const streamer = new MarkdownStreamRenderer(() => width);
  let text = "";
  for (const chunk of chunks) {
    text += chunk;
    assert.equal(
      streamer.render(text, false),
      baseline(text, { isFinal: false, width }),
      `${label}: 流式中间帧不一致（累计 ${text.length} 字符）`,
    );
  }
  assert.equal(
    streamer.render(text, true),
    baseline(text, { isFinal: true, width }),
    `${label}: 最终帧不一致`,
  );
  return text;
}

/** 按固定长度切片；最后一帧可能短于 step。 */
function sliceByLength(text, step) {
  const chunks = [];
  for (let i = 0; i < text.length; i += step) chunks.push(text.slice(i, i + step));
  return chunks;
}

/** 按行切片（保留行尾换行），更贴近真实流式的行级到达。 */
function sliceByLines(text) {
  const chunks = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return chunks;
}

const CORPUS = {
  prose:
    "# 一级标题\n\n这是一段**粗体**、`inline code` 和 [链接](https://example.com) 混排的正文，" +
    "带 snake_case 标识符。\n\n## 二级标题\n\n- 项目一\n- 项目二\n\n> 引用块内容\n\n" +
    "1. 第一项\n2. 第二项\n\n- [x] 已完成\n- [ ] 未完成\n\n尾行。\n",
  code:
    "说明：\n\n```ts\nexport function add(a: number, b: number): number {\n" +
    '  const label = "sum"; // 注释\n  return a + b;\n}\n```\n\n结束。\n',
  table:
    "表格：\n\n| 列A | 列B | 列C |\n| --- | --- | --- |\n| 1 | 二 | three |\n" +
    "| 3 | 四 | five |\n\n尾行。\n",
  card:
    "卡片：\n\n┌── code ──────────\n│ const a = 1\n│ const b = 2\n└──────────────────\n\n尾行。\n",
  crlf: "行一\r\n行二\r\n```js\r\nconst a = 1;\r\n```\r\n尾行\r\n",
  unclosedBold: "开始 **加粗但没闭合\n\n下一段继续\n",
  unclosedTick: "文字 `code 未闭合\n\n```js\nconst a = 1;\n",
};

for (const [name, text] of Object.entries(CORPUS)) {
  test(`增量解析与全量解析逐字节等价：${name}`, () => {
    for (const step of [1, 3, 7, 16]) {
      assertStreamingMatchesBaseline(sliceByLength(text, step), { label: `${name}/step=${step}` });
    }
    assertStreamingMatchesBaseline(sliceByLines(text), { label: `${name}/按行` });
  });
}

test("未闭合代码块在流式中间态与全量解析保持一致", () => {
  const text = "```ts\nconst a = 1;\nconst b = 2;\n```\n\n后续正文\n";
  const streamer = new MarkdownStreamRenderer(() => 80);
  let acc = "";
  for (const chunk of sliceByLines(text)) {
    acc += chunk;
    // 未闭合的那几帧 autoCloseMarkdown 会补围栏，缓存仍必须与全量结果一致。
    assert.equal(streamer.render(acc, false), baseline(acc, { isFinal: false }));
  }
});

test("流式中间态的未闭合语法补全行为保持不变", () => {
  const width = 80;
  const render = (text) => new MarkdownStreamRenderer(() => width).render(text, false);

  // 未闭合代码围栏会被补成完整卡片（有底栏），而不是裸露半截
  const codeBlock = render("```ts\nconst a = 1;");
  assert.match(codeBlock, /└─+┘/u, "未闭合围栏应补全出代码卡片底栏");

  // 未闭合粗体会被补上闭合标记，于是 `**` 被当作强调语法消费掉
  const bold = render("开始 **加粗");
  assert.equal(bold.includes("**"), false, "未闭合粗体应被补上闭合标记后消费");

  // 末行未闭合的行内代码反引号会被补齐，反引号同样被消费
  const tick = render("文字 `code");
  assert.equal(tick.includes("`"), false, "未闭合行内代码应被补上闭合反引号");
  assert.ok(tick.includes("code"), "行内代码内容应保留");

  // 四个反引号的围栏同样按奇数/偶数配对
  const fence4 = render("````\n四个反引号未闭合");
  assert.match(fence4, /└─+┘/u, "四个反引号的未闭合围栏也应补全");
});

test("宽度变化后前缀缓存失效，输出与新宽度全量渲染一致", () => {
  const text = CORPUS.code + CORPUS.table;
  let width = 80;
  const streamer = new MarkdownStreamRenderer(() => width);
  assert.equal(streamer.render(text, true), baseline(text, { isFinal: true, width: 80 }));

  width = 32;
  assert.equal(
    streamer.render(text, true),
    baseline(text, { isFinal: true, width: 32 }),
    "窄屏渲染不得复用宽屏缓存",
  );

  width = 80;
  assert.equal(
    streamer.render(text, true),
    baseline(text, { isFinal: true, width: 80 }),
    "切回宽屏后重新渲染必须正确",
  );
});

test("主题变化后前缀缓存失效，输出与新主题全量渲染一致", () => {
  const text = CORPUS.code + CORPUS.prose;
  try {
    setActiveColorLevel("truecolor");
    resetThemeAppearance();
    const streamer = new MarkdownStreamRenderer(() => 80);
    assert.equal(streamer.render(text, true), baseline(text, { isFinal: true }));

    assert.equal(setThemeAppearance("light"), true);
    assert.equal(
      streamer.render(text, true),
      baseline(text, { isFinal: true }),
      "切换 light 外观后不得复用深色板缓存",
    );

    resetThemeAppearance();
    assert.equal(
      streamer.render(text, true),
      baseline(text, { isFinal: true }),
      "切回 dark 后重新渲染必须正确",
    );
  } finally {
    resetThemeAppearance();
    resetActiveTheme();
    resetActiveColorLevel();
  }
});

test("颜色能力变化后前缀缓存失效", () => {
  const text = CORPUS.code;
  try {
    setActiveColorLevel("truecolor");
    const streamer = new MarkdownStreamRenderer(() => 80);
    const truecolor = streamer.render(text, true);
    assert.equal(truecolor, baseline(text, { isFinal: true }));

    setActiveColorLevel("mono");
    const mono = streamer.render(text, true);
    assert.equal(mono, baseline(text, { isFinal: true }));
    assert.notEqual(mono, truecolor, "降级到 mono 后不应残留真彩色序列");
  } finally {
    resetActiveColorLevel();
    resetActiveTheme();
  }
});

test("前缀不匹配时回退全量解析", () => {
  const streamer = new MarkdownStreamRenderer(() => 80);
  assert.equal(streamer.render(CORPUS.code, true), baseline(CORPUS.code, { isFinal: true }));

  // 内容被整体替换（重放 / 会话切换）：既不共享前缀，也不能复用旧行。
  assert.equal(
    streamer.render(CORPUS.table, true),
    baseline(CORPUS.table, { isFinal: true }),
    "无关文本必须回退全量",
  );

  // 新文本是旧文本的前缀（内容被截断）：同样不能命中。
  const truncated = CORPUS.code.slice(0, 20);
  assert.equal(
    streamer.render(truncated, true),
    baseline(truncated, { isFinal: true }),
    "截断文本必须回退全量",
  );
});

test("reset 后不残留缓存", () => {
  const streamer = new MarkdownStreamRenderer(() => 80);
  streamer.render(CORPUS.prose, false);
  streamer.reset();
  assert.equal(streamer.render(CORPUS.table, false), baseline(CORPUS.table, { isFinal: false }));
});

test("长文本流式渲染：增量解析显著快于逐帧全量重解析", () => {
  const unit =
    "这是一段普通回复，包含**粗体**、`inline` 和 [链接](https://example.com)。\n\n" +
    "- 列表项\n\n```ts\nconst value = compute(1, \"s\");\n```\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n";
  let text = "";
  while (text.length < 20_000) text += unit;
  const chunks = sliceByLength(text, 200);

  const runStreaming = (createRenderer) => {
    let acc = "";
    const renderer = createRenderer();
    const startedAt = process.hrtime.bigint();
    for (const chunk of chunks) {
      acc += chunk;
      renderer.render(acc, false);
    }
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
  };

  // 增量：同一个 renderer，跨帧复用前缀。
  const incremental = runStreaming(() => new MarkdownStreamRenderer(() => 80));
  // 全量对照：每帧一个全新 renderer，等于没有缓存的原始实现。
  const fullReparse = runStreaming(() => ({ render: (value) => baseline(value, { width: 80 }) }));

  assert.ok(
    incremental * 2 < fullReparse,
    `增量解析应至少快一倍：增量 ${incremental.toFixed(1)}ms，全量 ${fullReparse.toFixed(1)}ms`,
  );
});
