import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdjudicationPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  extractTaggedJson,
  parseAdjudicationOutput,
  parseFixOutput,
  parseReviewOutput,
  stableFindingId,
} from "../dist/patrol/runners.js";

test("extractTaggedJson：优先取带标签的 fenced 块，兼容裸 JSON", () => {
  const text = '前置说明\n```patrol-review\n{"verdict":"pass"}\n```\n后置说明';
  assert.deepEqual(extractTaggedJson(text, "patrol-review"), { verdict: "pass" });
  assert.deepEqual(extractTaggedJson('{"a":1}', "patrol-review"), { a: 1 });
  assert.equal(extractTaggedJson("完全没有 JSON", "patrol-review"), null);
});

test("解析审查输出：非法或自相矛盾的输出一律不允许伪装通过", () => {
  assert.deepEqual(parseReviewOutput('```patrol-review\n{"verdict":"pass","summary":"好"}\n```'), {
    verdict: "pass",
    findings: [],
    summary: "好",
  });
  // pass 却带阻塞问题 → 降级为 changes_required
  const coerced = parseReviewOutput(
    '```patrol-review\n{"verdict":"pass","findings":[{"summary":"严重"}]}\n```',
  );
  assert.equal(coerced.verdict, "changes_required");
  // changes_required 没有清单 → inconclusive
  const empty = parseReviewOutput('```patrol-review\n{"verdict":"changes_required"}\n```');
  assert.equal(empty.verdict, "inconclusive");
  // 完全无法解析 → inconclusive
  const garbage = parseReviewOutput("我觉得挺好的，可以合并");
  assert.equal(garbage.verdict, "inconclusive");
  // 未知结论 → inconclusive
  const unknown = parseReviewOutput('```patrol-review\n{"verdict":"lgtm"}\n```');
  assert.equal(unknown.verdict, "inconclusive");
});

test("解析修复输出：非法结构按 failed", () => {
  const ok = parseFixOutput(
    '```patrol-fix\n{"status":"pushed","summary":"ok","pushedHeadSha":"a1"}\n```',
  );
  assert.deepEqual(ok, {
    status: "pushed",
    summary: "ok",
    pushedHeadSha: "a1",
    disputeReason: undefined,
  });
  assert.equal(parseFixOutput("改好了").status, "failed");
  assert.equal(parseFixOutput('```patrol-fix\n{"status":"yolo"}\n```').status, "failed");
});

test("解析裁决输出：verdict 白名单外返回 null", () => {
  const ok = parseAdjudicationOutput(
    '```patrol-adjudication\n{"verdict":"overrule","reasons":["r"],"rejectedFindingIds":["f-1"],"orders":[],"acceptance":[],"summary":"s"}\n```',
  );
  assert.equal(ok.verdict, "overrule");
  assert.deepEqual(ok.rejectedFindingIds, ["f-1"]);
  assert.equal(parseAdjudicationOutput("我认为应该合并"), null);
  assert.equal(parseAdjudicationOutput('```patrol-adjudication\n{"verdict":"vibe"}\n```'), null);
});

test("stableFindingId：同位置同摘要稳定，显式合法 ID 优先", () => {
  const raw = { location: "src/a.ts", summary: "空指针" };
  const id1 = stableFindingId("owner/repo#1", raw);
  const id2 = stableFindingId("owner/repo#1", { ...raw });
  const id3 = stableFindingId("owner/repo#2", raw);
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  assert.equal(stableFindingId("owner/repo#1", { ...raw, findingId: "F-9" }), "F-9");
  // 非法字符的自带 ID 被忽略，回落到哈希
  assert.equal(stableFindingId("owner/repo#1", { ...raw, findingId: "带空格 id" }), id1);
});

test("提示词构造：包含任务上下文与输出格式约定", () => {
  const job = {
    jobId: "owner/repo#7",
    repo: "owner/repo",
    prNumber: 7,
    branch: "agent/fix",
    targetBranch: "master",
    taskBrief: "修复 X",
    acceptance: ["测试覆盖"],
    scope: ["src/"],
    version: { headSha: "aaaa1111bbbb", baseSha: "b", ruleVersion: "v1" },
    findings: [
      {
        findingId: "f-1",
        severity: "blocking",
        summary: "问题",
        evidence: "证据",
        requiredFix: "修好",
        state: "open",
      },
    ],
    decisions: [],
    runs: [],
    usage: { promptTokens: 0, completionTokens: 0, costCny: 0 },
    fixRounds: 0,
    adjudicationRounds: 0,
    createdAt: "",
    updatedAt: "",
    status: "reviewing",
    draft: false,
    source: { taskId: "t", origin: "haji", verified: true },
  };
  const review = buildReviewPrompt({
    job,
    prTitle: "t",
    diff: "+diff",
    priorFindings: job.findings,
  });
  assert.match(review, /独立审查/);
  assert.match(review, /修复 X/);
  assert.match(review, /\+diff/);
  assert.match(review, /f-1/);
  assert.match(review, /```patrol-review/);

  const fix = buildFixPrompt({ job, findings: job.findings, orders: ["加锁"], attempt: 1 });
  assert.match(fix, /最终裁决指令/);
  assert.match(fix, /加锁/);
  assert.match(fix, /不要 push/);

  const adjudication = buildAdjudicationPrompt({
    job,
    contestedDecisionId: "dec-1",
    findings: job.findings,
    disputeReason: "有测试",
  });
  assert.match(adjudication, /最终裁决/);
  assert.match(adjudication, /不要修改文件/);
  assert.match(adjudication, /dec-1/);
});
