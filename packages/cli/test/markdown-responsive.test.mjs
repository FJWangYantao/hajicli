import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownStreamRenderer } from "../dist/markdown-renderer.js";

const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("narrow code blocks drop the four-sided frame without truncating long code", () => {
  const renderer = new MarkdownStreamRenderer(() => 32);
  const longCode = 'const preservedValue = "ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789";';
  const rendered = stripAnsi(renderer.render(`\`\`\`js\n${longCode}\n\`\`\``, true));

  assert.equal(rendered.includes(longCode), true);
  assert.doesNotMatch(rendered, /[┌┐└┘─]/u);
  assert.equal(rendered.includes("…"), false);
});

test("narrow tables become vertical records and preserve every value", () => {
  const renderer = new MarkdownStreamRenderer(() => 32);
  const rendered = stripAnsi(
    renderer.render(
      [
        "| Name | Value |",
        "| --- | --- |",
        "| Alpha | first-complete-value-0123456789 |",
        "| Beta | 第二个完整值🙂 |",
      ].join("\n"),
      true,
    ),
  );

  assert.match(rendered, /Name: Alpha/);
  assert.match(rendered, /Value: first-complete-value-0123456789/);
  assert.match(rendered, /Name: Beta/);
  assert.match(rendered, /Value: 第二个完整值🙂/u);
  assert.doesNotMatch(rendered, /[┌┬┐├┼┤└┴┘]/u);
  assert.equal(rendered.includes("…"), false);
});

test("H1 headings preserve the model-provided letter casing", () => {
  const renderer = new MarkdownStreamRenderer(() => 32);
  const rendered = stripAnsi(renderer.render("# MiXeD API v2", true));

  assert.equal(rendered.includes("MiXeD API v2"), true);
  assert.equal(rendered.includes("MIXED API V2"), false);
});

test("model-provided CSI and OSC sequences cannot enter rendered Markdown", () => {
  const renderer = new MarkdownStreamRenderer(() => 32);
  const injected = "Visible\x1b[2J text\nCopy\x1b]52;c;c2VjcmV0\x07 done";
  const clean = "Visible text\nCopy done";

  const rendered = renderer.render(injected, true);
  assert.equal(rendered, renderer.render(clean, true));
  assert.equal(rendered.includes("\x1b[2J"), false);
  assert.equal(rendered.includes("\x1b]52"), false);
  assert.equal(rendered.includes("c2VjcmV0"), false);
});

test("wide code blocks keep the complete frame at width 80", () => {
  const renderer = new MarkdownStreamRenderer(() => 80);
  const rendered = stripAnsi(renderer.render("```ts\nconst answer = 42;\n```", true));
  const lines = rendered.split("\n");

  assert.match(lines[0], /^┌── ts .*┐$/u);
  assert.match(lines[1], /^│ .* │$/u);
  assert.match(lines.at(-1), /^└─+┘$/u);
});

test("wide code blocks wrap long lines inside the frame instead of truncating them", () => {
  const renderer = new MarkdownStreamRenderer(() => 48);
  const longCode =
    "export function summarize(name: string, args: Record<string, unknown>): string {";
  const rendered = stripAnsi(renderer.render(`\`\`\`ts\n${longCode}\n}\n\`\`\``, true));
  const rows = rendered.split("\n");

  assert.equal(rendered.includes("…"), false);
  assert.match(rows[2], /^│↪/u, "continuation rows are marked");
  const joined = rows
    .slice(1, -1)
    .map((row) => row.replace(/^│[ ↪]/u, "").replace(/ *│$/u, ""))
    .join("");
  assert.equal(joined.includes(longCode), true, "every character of the code survives");
  const frameWidth = rows[0].length;
  for (const row of rows) assert.equal(row.length, frameWidth, `misaligned row: ${row}`);
});

test("links render as text plus address and never mangle underscores", () => {
  const renderer = new MarkdownStreamRenderer(() => 80);
  const rendered = stripAnsi(
    renderer.render(
      "见 [Node 文档](https://nodejs.org/api/tty.html)，变量 write_file_tool，地址 https://x.com/a_b_c 和 <https://a.b/c>。*强调*",
      true,
    ),
  );
  assert.equal(
    rendered,
    "见 Node 文档 https://nodejs.org/api/tty.html，变量 write_file_tool，地址 https://x.com/a_b_c 和 https://a.b/c。强调",
  );
});

test("table cells keep only the link text so columns stay aligned", () => {
  const renderer = new MarkdownStreamRenderer(() => 80);
  const rendered = stripAnsi(
    renderer.render("| 名称 | 链接 |\n|---|---|\n| a | [文档](https://e.com/x_y) |", true),
  );
  assert.match(rendered, /│ a {4}│ 文档 │/);
  assert.doesNotMatch(rendered, /https:/);
});
