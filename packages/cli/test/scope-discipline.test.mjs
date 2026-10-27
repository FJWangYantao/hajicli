import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolsPromptPart } from "@hajicli/core";
import { buildOverlapHint, mergeRanges, overlapRatio, ReadFileTool } from "@hajicli/plugins";

test("overlapRatio 只算交集行数占本次请求的比例", () => {
  assert.equal(overlapRatio([], 1, 100), 0);
  assert.equal(overlapRatio([{ start: 1, end: 100 }], 51, 150), 0.5);
  assert.equal(overlapRatio([{ start: 1, end: 100 }], 1, 100), 1);
  assert.equal(overlapRatio([{ start: 1, end: 10 }], 200, 300), 0);
  // 多次已读区间累加
  assert.equal(
    overlapRatio(
      [
        { start: 1, end: 25 },
        { start: 76, end: 100 },
      ],
      1,
      100,
    ),
    0.5,
  );
});

test("mergeRanges 合并重叠与相邻区间", () => {
  assert.deepEqual(mergeRanges([{ start: 10, end: 20 }], { start: 21, end: 30 }), [
    { start: 10, end: 30 },
  ]);
  assert.deepEqual(
    mergeRanges(
      [
        { start: 1, end: 10 },
        { start: 50, end: 60 },
      ],
      { start: 5, end: 55 },
    ),
    [{ start: 1, end: 60 }],
  );
});

test("buildOverlapHint 只在重叠过半且跨度足够时提示", () => {
  assert.equal(buildOverlapHint([{ start: 1, end: 100 }], 90, 99), undefined);
  assert.equal(buildOverlapHint([{ start: 1, end: 100 }], 101, 200), undefined);
  const hint = buildOverlapHint([{ start: 1, end: 100 }], 40, 140);
  assert.ok(hint);
  assert.match(hint, /60% 与已读区间重叠/);
  assert.match(hint, /1-100/);
  assert.match(hint, /nextStartLine/);
});

test("read 工具在叠读时提示，且关闭 overlapHint 后不提示", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-overlap-"));
  try {
    const file = path.join(dir, "big.ts");
    fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n"));

    const tool = new ReadFileTool();
    const first = await tool.execute({ path: file, startLine: 1, endLine: 200 });
    assert.doesNotMatch(String(first), /与已读区间重叠/);

    const second = await tool.execute({ path: file, startLine: 100, endLine: 300 });
    assert.match(String(second), /与已读区间重叠/);

    const quiet = new ReadFileTool({ overlapHint: false });
    await quiet.execute({ path: file, startLine: 1, endLine: 200 });
    const again = await quiet.execute({ path: file, startLine: 100, endLine: 300 });
    assert.doesNotMatch(String(again), /与已读区间重叠/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scope_discipline 只在 converge 组注入搜索/读取纪律", () => {
  const part = new ToolsPromptPart();
  const base = { cwd: "/tmp", os: "linux", tools: ["read", "grep", "global"] };
  const control = part.getContent(base);
  assert.doesNotMatch(control, /连续两次没有命中/);
  assert.doesNotMatch(control, /不要先读一段再回头补读/);

  const treatment = part.getContent({ ...base, scopeDiscipline: true });
  assert.match(treatment, /连续两次没有命中/);
  assert.match(treatment, /global\.patterns/);
  assert.match(treatment, /不要先读一段再回头补读/);
});
