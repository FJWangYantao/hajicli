import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearMermaidArtCache,
  mermaidSources,
  parseVisualizeParams,
  probeMermaid,
  renderMermaidArt,
  VisualizeTool,
  validateVisualizeShape,
  visualizeMarkdown,
} from "@hajicli/plugins";

import { summarizeToolResult } from "../dist/cli-runtime.js";
import { setThemePreset } from "../dist/theme.js";
import { visualizePreview, visualizeTitle } from "../dist/visualize-view.js";

setThemePreset("default");

/**
 * visualize：模型侧是「校验 + markdown」，展示侧是「字符画，画不出就退回源码」。
 * 这里覆盖两条链路，全部纯函数或临时目录隔离。
 */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value) => value.replace(ANSI_RE, "");

const FLOW = "flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]";
/** 引擎不认识 gantt，画不出来只能退回源码。 */
const GANTT = "gantt\n  title Ship\n  section Build\n  compile :a1, 2024-01-01, 3d";
const BROKEN = "flowchart LR\n  A --> B\n  C -->";

async function withTempWorkspace(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-visualize-"));
  const cwd = process.cwd();
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    process.chdir(dir);
    return await run();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("diagram：校验通过后返回 mermaid 围栏，标题变成 markdown 标题", async () => {
  const tool = new VisualizeTool();
  const output = await tool.execute({ type: "diagram", title: "请求路径", mermaid: FLOW });
  assert.equal(output, `### 请求路径\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``);
});

test("diagram：空源码与坏语法都被拒，并说清怎么改", async () => {
  const tool = new VisualizeTool();
  assert.match(await tool.execute({ type: "diagram" }), /错误: .*`mermaid` 必填/);
  assert.match(await tool.execute({ type: "diagram", mermaid: "   " }), /错误: .*`mermaid` 必填/);

  const broken = await tool.execute({ type: "diagram", mermaid: BROKEN });
  assert.match(broken, /^错误: /);
  assert.match(broken, /mermaid 语法有问题（`mermaid`）/);
  assert.match(broken, /重新调用 visualize/);
});

test("diagram：未知 flowchart 方向被拒，引擎不认识的图族放行", async () => {
  assert.throws(() => probeMermaid("flowchart XX\n  A --> B"), /未知的 flowchart 方向 "XX"/);
  assert.doesNotThrow(() => probeMermaid("flowchart LR\n  A --> B"));
  assert.doesNotThrow(() => probeMermaid(GANTT));
});

test("comparison：必填与命名校验，markdown 保留 pros/cons 与推荐标记", async () => {
  const tool = new VisualizeTool();
  assert.match(await tool.execute({ type: "comparison" }), /错误: .*`options` 必填/);
  assert.match(
    await tool.execute({ type: "comparison", options: [{ pros: ["x"] }] }),
    /错误: options\[0\]\.name 必填/,
  );

  const output = await tool.execute({
    type: "comparison",
    title: "选存储",
    options: [
      { name: "SQLite", pros: ["零运维"], cons: ["并发弱"], recommended: true },
      { name: "Postgres", pros: ["功能全"], cons: ["要运维"] },
    ],
  });
  assert.match(output, /^## 选存储/);
  assert.match(output, /### SQLite — ✅ 推荐/);
  assert.match(output, /\*\*优点:\*\*\n- 零运维/);
  assert.match(output, /\*\*缺点:\*\*\n- 并发弱/);
  assert.match(output, /### Postgres\n/);
});

test("comparison：每个选项的内联 mermaid 也要过校验", async () => {
  const params = parseVisualizeParams({
    type: "comparison",
    options: [{ name: "A", mermaid: FLOW }, { name: "B" }],
  });
  assert.deepEqual(
    mermaidSources(params).map((item) => item.location),
    ["options[0].mermaid"],
  );

  const tool = new VisualizeTool();
  const output = await tool.execute({
    type: "comparison",
    options: [{ name: "A", mermaid: BROKEN }],
  });
  assert.match(output, /mermaid 语法有问题（`options\[0\]\.mermaid`）/);
});

test("file：路径必填、before 不能与 path 相同、文件必须已存在", async () => {
  const tool = new VisualizeTool();
  assert.match(await tool.execute({ type: "file" }), /错误: .*`path` 必填/);
  assert.match(
    await tool.execute({ type: "file", path: "a.html", before: "./a.html" }),
    /错误: .*指向同一个文件/,
  );

  await withTempWorkspace({}, async () => {
    assert.match(await tool.execute({ type: "file", path: "missing.html" }), /文件不存在/);
  });
  await withTempWorkspace(
    { "mockup.html": "<h1>hi</h1>", "old.html": "<h1>old</h1>" },
    async () => {
      const single = await tool.execute({ type: "file", path: "mockup.html" });
      assert.match(single, /已展示 `mockup\.html`。/);
      const diff = await tool.execute({ type: "file", path: "mockup.html", before: "old.html" });
      assert.match(diff, /已展示 `mockup\.html`（与 `old\.html` 的前后对比）。/);
    },
  );
});

test("validateVisualizeShape 与 visualizeMarkdown 是纯函数，可直接复用", () => {
  const params = parseVisualizeParams({ type: "diagram", mermaid: FLOW });
  assert.doesNotThrow(() => validateVisualizeShape(params));
  assert.equal(visualizeMarkdown(params), `\`\`\`mermaid\n${FLOW}\n\`\`\``);
  // 流式残缺参数：解析不炸，缺的字段按空处理。
  assert.deepEqual(parseVisualizeParams({}), {
    type: "diagram",
    title: undefined,
    mermaid: undefined,
    options: [],
    path: undefined,
    before: undefined,
  });
});

test("渲染：宽度够时画出 box-drawing，画不出来时退回源码框", () => {
  clearMermaidArtCache();
  const art = renderMermaidArt(FLOW);
  assert.ok(art, "flowchart 应该能画出来");
  assert.equal(art.warnings.length, 0);
  assert.ok(art.width > 0);

  const wide = visualizePreview({ type: "diagram", mermaid: FLOW }, 120);
  assert.ok(wide?.preview?.length, "宽终端应给出字符画预览");
  const joined = stripAnsi(wide.preview.join("\n"));
  assert.match(joined, /┌/);
  assert.match(joined, /Start/);
  assert.match(wide.text, /^flowchart LR · \d+ 列$/);

  // 引擎不认识的图族：退回源码框，源码一个字都不少。
  const gantt = visualizePreview({ type: "diagram", mermaid: GANTT }, 120);
  assert.ok(gantt?.preview?.length);
  const ganttText = stripAnsi(gantt.preview.join("\n"));
  assert.match(ganttText, /mermaid: gantt/);
  assert.match(ganttText, /compile :a1/);
  assert.match(gantt.text, /显示源码$/);
});

test("渲染：图比可用宽度宽就退回源码，绝不折行", () => {
  const narrow = visualizePreview({ type: "diagram", mermaid: FLOW }, 20);
  assert.equal(narrow.preview, undefined, "太窄时不留碎片框，只留一行说明");
  assert.match(narrow.text, /显示源码$/);

  const medium = visualizePreview({ type: "diagram", mermaid: FLOW }, 40);
  const lines = (medium.preview ?? []).map(stripAnsi);
  assert.ok(lines.length > 0);
  assert.doesNotMatch(lines.join("\n"), /┌────┐\s+┌/, "不该出现被压扁的字符画");
  for (const line of lines) assert.ok(line.length <= 40, `源码框不应超出宽度：${line}`);
});

test("渲染：comparison 逐条列方案，file 只给路径", () => {
  const comparison = visualizePreview(
    {
      type: "comparison",
      options: [{ name: "SQLite", recommended: true }, { name: "Postgres" }],
    },
    80,
  );
  assert.equal(comparison.text, "对比 2 个选项");
  assert.deepEqual(comparison.preview.map(stripAnsi), ["1. SQLite ✅ 推荐", "2. Postgres"]);

  const file = visualizePreview({ type: "file", path: "a.html", before: "b.html" }, 80);
  assert.equal(file.text, "前后对比");
  // 头行按 `before → path` 的顺序展示，读起来就是「从旧到新」。
  assert.equal(
    visualizeTitle({ type: "file", path: "a.html", before: "b.html" }),
    "b.html → a.html",
  );
});

test("头行主语：标题优先，其次按 type 归纳", () => {
  assert.equal(visualizeTitle({ type: "diagram", title: "请求路径", mermaid: FLOW }), "请求路径");
  assert.equal(visualizeTitle({ type: "diagram", mermaid: FLOW }), "flowchart LR");
  assert.equal(
    visualizeTitle({ type: "comparison", options: [{ name: "A" }, { name: "B" }] }),
    "对比 2 个选项",
  );
  assert.equal(visualizeTitle({ type: "file", path: "a.html" }), "a.html");
  assert.equal(visualizeTitle({}), "图表");
});

test("工具结果摘要：diagram 的预览就是字符画，宽度来自对话区内容宽", () => {
  const args = { type: "diagram", title: "请求路径", mermaid: FLOW };
  const output = visualizeMarkdown(parseVisualizeParams(args));

  const wide = summarizeToolResult("visualize", output, { blocked: false }, args, undefined, 120);
  assert.equal(wide.status, "success");
  assert.match(wide.text, /^flowchart LR · \d+ 列$/);
  assert.match(stripAnsi(wide.preview.join("\n")), /Start/);

  // 内容宽 40 → 预览可用宽 32，图放不下，退回源码。
  const narrow = summarizeToolResult("visualize", output, { blocked: false }, args, undefined, 40);
  assert.match(narrow.text, /显示源码$/);
  assert.match(stripAnsi(narrow.preview.join("\n")), /flowchart LR/);
});

test("工具结果摘要：失败仍走原来的错误通道，不会被图覆盖", () => {
  const args = { type: "diagram", mermaid: FLOW };
  // 执行器用 isFailedToolOutput 把「错误:」开头的输出标成 blocked，这里按同一口径传入。
  const failed = summarizeToolResult(
    "visualize",
    "错误: mermaid 语法有问题（`mermaid`）：图里有部分内容读不懂。",
    { blocked: true },
    args,
    undefined,
    120,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.preview, undefined);
  assert.match(failed.text, /mermaid 语法有问题/);
});
