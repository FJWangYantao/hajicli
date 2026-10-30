import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyAdjudicationToFindings,
  applyPatrolTransition,
  canTransitionPatrolStatus,
  evaluatePatrolMergeGate,
  latestApplicableDecision,
  mergeReviewFindings,
  PatrolStore,
  patrolBudgetStatus,
  patrolJobId,
  planNextStatusAfterReview,
  resetPatrolJobForNewCommit,
} from "@hajicli/core";

function makeVersion(head = "a1b2c3d4e5f6") {
  return { headSha: head, baseSha: "base0001", ruleVersion: "v1" };
}

function makeFinding(id, severity = "blocking") {
  return {
    findingId: id,
    severity,
    summary: `问题 ${id}`,
    evidence: "证据",
    state: "open",
  };
}

function makeJob(overrides = {}) {
  const now = new Date().toISOString();
  return {
    jobId: patrolJobId("owner/repo", 7),
    repo: "owner/repo",
    prNumber: 7,
    branch: "agent/fix",
    targetBranch: "master",
    source: { taskId: "task-1", origin: "haji", verified: true },
    taskBrief: "修复 X",
    acceptance: ["测试覆盖 X"],
    scope: ["src/"],
    version: makeVersion(),
    status: "discovered",
    draft: false,
    fixRounds: 0,
    adjudicationRounds: 0,
    findings: [],
    decisions: [],
    runs: [],
    usage: { promptTokens: 0, completionTokens: 0, costCny: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDecision(verdict, overrides = {}) {
  return {
    decisionId: `d-${Math.random().toString(36).slice(2, 8)}`,
    kind: "review",
    verdict,
    version: makeVersion(),
    createdAt: new Date().toISOString(),
    byAgent: "review-fake",
    reasons: [],
    ...overrides,
  };
}

const LIMITS = {
  maxFixRounds: 3,
  maxAdjudicationRounds: 2,
  maxCostCny: 20,
  reserveAdjudicationCny: 5,
  maxAgeMs: 24 * 3600_000,
  maxRunRetries: 3,
};

test("状态机：非法转换被拒绝，合法路径可用", () => {
  assert.equal(canTransitionPatrolStatus("discovered", "reviewing"), true);
  assert.equal(canTransitionPatrolStatus("discovered", "merged"), false);
  assert.throws(
    () => applyPatrolTransition(makeJob(), "merged"),
    /不允许从 discovered 转换到 merged/,
  );
  assert.throws(
    () => applyPatrolTransition(makeJob({ status: "merged" }), "reviewing"),
    /已处于终态 merged/,
  );
  // 完整合法路径：discovered → reviewing → awaiting_changes → fixing → reviewing → ready_to_merge → merging → merged
  const job = makeJob();
  applyPatrolTransition(job, "reviewing");
  job.findings.push(makeFinding("f-1"));
  applyPatrolTransition(job, "awaiting_changes", { reason: "退回修改" });
  applyPatrolTransition(job, "fixing");
  applyPatrolTransition(job, "reviewing");
  job.findings[0].state = "resolved";
  job.decisions.push(makeDecision("pass"));
  applyPatrolTransition(job, "ready_to_merge");
  applyPatrolTransition(job, "merging");
  applyPatrolTransition(job, "merged");
  assert.equal(job.mergedAt !== undefined, true);
});

test("ready_to_merge 守卫：缺少通过性结论或存在阻塞问题时拒绝", () => {
  const job = makeJob({ status: "reviewing" });
  assert.throws(() => applyPatrolTransition(job, "ready_to_merge"), /需要当前版本的通过性结论/);
  job.decisions.push(makeDecision("changes_required"));
  assert.throws(() => applyPatrolTransition(job, "ready_to_merge"), /不能进入 ready_to_merge/);
  const job2 = makeJob({ status: "reviewing" });
  job2.decisions.push(makeDecision("pass"));
  job2.findings.push(makeFinding("f-1"));
  assert.throws(() => applyPatrolTransition(job2, "ready_to_merge"), /未解决的阻塞问题/);
  job2.findings[0].state = "resolved";
  applyPatrolTransition(job2, "ready_to_merge");
  assert.equal(job2.status, "ready_to_merge");
});

test("awaiting_changes 守卫：没有阻塞问题不能退回修改", () => {
  const job = makeJob({ status: "reviewing" });
  assert.throws(() => applyPatrolTransition(job, "awaiting_changes"), /必须存在未解决的阻塞问题/);
  job.findings.push(makeFinding("f-1"));
  applyPatrolTransition(job, "awaiting_changes", { reason: "测试" });
  assert.equal(job.status, "awaiting_changes");
});

test("enforcing 守卫：需要当前版本的裁决结论", () => {
  const job = makeJob({ status: "adjudicating" });
  assert.throws(() => applyPatrolTransition(job, "enforcing"), /需要当前版本的裁决指令/);
  job.decisions.push(makeDecision("remediate", { kind: "adjudication" }));
  applyPatrolTransition(job, "enforcing");
  assert.equal(job.status, "enforcing");
});

test("新提交重置：作废旧结论、中止运行中的 run、终态不动", () => {
  const job = makeJob({ status: "fixing" });
  job.decisions.push(makeDecision("changes_required"));
  job.runs.push({
    runId: "run-1",
    role: "fix",
    version: job.version,
    startedAt: new Date().toISOString(),
    status: "running",
    attempt: 1,
  });
  const changed = resetPatrolJobForNewCommit(job, makeVersion("ffff0000dead"));
  assert.equal(changed, true);
  assert.equal(job.status, "discovered");
  assert.equal(job.runs[0].status, "aborted");
  assert.equal(latestApplicableDecision(job), undefined);
  // 相同版本不重置
  assert.equal(resetPatrolJobForNewCommit(job, makeVersion("ffff0000dead")), false);
  // 终态不重置
  const merged = makeJob({ status: "merged" });
  assert.equal(resetPatrolJobForNewCommit(merged, makeVersion("another1111")), false);
  assert.equal(merged.status, "merged");
});

test("审查结论路由：轮次未满退回修改，已满升级裁决", () => {
  const job = makeJob();
  assert.equal(
    planNextStatusAfterReview(job, makeDecision("pass"), { maxFixRounds: 3 }),
    "ready_to_merge",
  );
  assert.equal(
    planNextStatusAfterReview(job, makeDecision("inconclusive"), { maxFixRounds: 3 }),
    "adjudicating",
  );
  assert.equal(
    planNextStatusAfterReview(job, makeDecision("changes_required"), { maxFixRounds: 3 }),
    "awaiting_changes",
  );
  const exhausted = makeJob({ fixRounds: 3 });
  assert.equal(
    planNextStatusAfterReview(exhausted, makeDecision("changes_required"), { maxFixRounds: 3 }),
    "adjudicating",
  );
});

test("问题清单合并：未再报告视为解决，复发问题重新打开", () => {
  const job = makeJob();
  job.findings.push(makeFinding("f-1"), makeFinding("f-2"));
  const decision = makeDecision("changes_required", {
    findings: [makeFinding("f-2"), makeFinding("f-3")],
  });
  mergeReviewFindings(job, decision);
  assert.equal(job.findings.find((f) => f.findingId === "f-1")?.state, "resolved");
  assert.equal(job.findings.find((f) => f.findingId === "f-2")?.state, "open");
  assert.equal(job.findings.find((f) => f.findingId === "f-3")?.state, "open");
  // f-2 在下一轮没有再出现 → 解决；再下一轮又出现 → 重新打开
  mergeReviewFindings(job, makeDecision("changes_required", { findings: [] }));
  assert.equal(job.findings.find((f) => f.findingId === "f-2")?.state, "resolved");
  mergeReviewFindings(job, makeDecision("changes_required", { findings: [makeFinding("f-2")] }));
  assert.equal(job.findings.find((f) => f.findingId === "f-2")?.state, "open");
});

test("裁决落地：被驳回的阻塞问题标记 rejected", () => {
  const job = makeJob();
  job.findings.push(makeFinding("f-1"), makeFinding("f-2"));
  applyAdjudicationToFindings(job, makeDecision("overrule", { findings: [makeFinding("f-1")] }));
  assert.equal(job.findings.find((f) => f.findingId === "f-1")?.state, "rejected");
  assert.equal(job.findings.find((f) => f.findingId === "f-2")?.state, "open");
});

test("预算：普通阶段预留裁决额度，总上限耗尽后不允许任何派发", () => {
  const healthy = patrolBudgetStatus(makeJob(), LIMITS);
  assert.equal(healthy.exhausted, false);
  assert.equal(healthy.normalPhaseExhausted, false);
  assert.equal(healthy.adjudicationAllowed, true);

  const spentNormal = makeJob({ usage: { promptTokens: 0, completionTokens: 0, costCny: 16 } });
  const normalGone = patrolBudgetStatus(spentNormal, LIMITS);
  assert.equal(normalGone.exhausted, false);
  assert.equal(normalGone.normalPhaseExhausted, true, "超过 max-reserve 后普通阶段停止");
  assert.equal(normalGone.adjudicationAllowed, true, "裁决额度仍保留");

  const spentAll = makeJob({ usage: { promptTokens: 0, completionTokens: 0, costCny: 21 } });
  const gone = patrolBudgetStatus(spentAll, LIMITS);
  assert.equal(gone.exhausted, true);
  assert.equal(gone.adjudicationAllowed, false);

  const adjudicationDone = makeJob({ adjudicationRounds: 2 });
  const roundsGone = patrolBudgetStatus(adjudicationDone, LIMITS);
  assert.equal(roundsGone.adjudicationAllowed, false);
});

function gateInput(overrides = {}) {
  const job = makeJob({ status: "ready_to_merge" });
  job.decisions.push(makeDecision("pass"));
  return {
    job,
    pr: {
      state: "open",
      draft: false,
      headSha: job.version.headSha,
      mergeable: true,
    },
    checks: [{ name: "ci/verify", status: "success", appSlug: "github-actions" }],
    requiredChecks: ["ci/verify"],
    trustedApps: ["github-actions"],
    budget: patrolBudgetStatus(job, LIMITS),
    paused: false,
    ...overrides,
  };
}

test("合并门禁：全部满足时放行", () => {
  const result = evaluatePatrolMergeGate(gateInput());
  assert.equal(result.allowed, true);
});

test("合并门禁：head 变化 / 草稿 / 冲突 / 暂停拒绝", () => {
  const drifted = gateInput();
  drifted.pr.headSha = "9999aaaabbbb";
  const r1 = evaluatePatrolMergeGate(drifted);
  assert.equal(r1.allowed, false);
  assert.match(r1.reasons.join("\n"), /head 已变化/);

  const draft = gateInput();
  draft.pr.draft = true;
  assert.equal(evaluatePatrolMergeGate(draft).allowed, false);

  const conflict = gateInput();
  conflict.pr.mergeable = false;
  assert.match(evaluatePatrolMergeGate(conflict).reasons.join("\n"), /合并冲突/);

  const paused = gateInput({ paused: true });
  assert.match(evaluatePatrolMergeGate(paused).reasons.join("\n"), /暂停/);
});

test("合并门禁：来源未授权自动合并时拒绝（只审查）", () => {
  const unauthorized = gateInput();
  unauthorized.job.source.mergeAuthorized = false;
  const result = evaluatePatrolMergeGate(unauthorized);
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join("\n"), /未授权自动合并/);

  // 缺省（旧状态文件 / 手动登记）视为允许，不引入回归。
  const legacy = gateInput();
  delete legacy.job.source.mergeAuthorized;
  assert.equal(evaluatePatrolMergeGate(legacy).allowed, true);
});

test("合并门禁：必需检查缺失 / 失败 / 来源不受信都拒绝", () => {
  const missing = gateInput({ checks: [] });
  assert.match(evaluatePatrolMergeGate(missing).reasons.join("\n"), /必需检查缺失/);

  const failing = gateInput({
    checks: [{ name: "ci/verify", status: "cancelled", appSlug: "github-actions" }],
  });
  assert.match(evaluatePatrolMergeGate(failing).reasons.join("\n"), /ci\/verify（cancelled）/);

  const untrusted = gateInput({
    checks: [{ name: "ci/verify", status: "success", appSlug: "evil-pr-bot" }],
  });
  assert.match(evaluatePatrolMergeGate(untrusted).reasons.join("\n"), /来源不受信/);
});

test("合并门禁：阻塞问题未解决、runner 仍在运行时拒绝", () => {
  const job = makeJob({ status: "ready_to_merge" });
  job.decisions.push(makeDecision("pass"));
  job.findings.push(makeFinding("f-open"));
  const blocked = gateInput({ job });
  assert.match(evaluatePatrolMergeGate(blocked).reasons.join("\n"), /f-open/);

  const job2 = makeJob({ status: "ready_to_merge" });
  job2.decisions.push(makeDecision("pass"));
  job2.runs.push({
    runId: "run-9",
    role: "review",
    version: job2.version,
    startedAt: new Date().toISOString(),
    status: "running",
    attempt: 1,
  });
  const running = gateInput({ job: job2 });
  assert.match(evaluatePatrolMergeGate(running).reasons.join("\n"), /runner 在运行/);
});

test("存储：任务读写、恢复语义与动作幂等", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-patrol-"));
  const store = new PatrolStore(dir);
  const job = makeJob({ status: "fixing" });
  job.runs.push({
    runId: "run-1",
    role: "fix",
    version: job.version,
    startedAt: new Date().toISOString(),
    status: "running",
    attempt: 1,
  });
  job.lease = {
    holder: "run-1",
    role: "fix",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  store.saveJob(job);

  // 动作：先存意图，标记执行中后模拟崩溃重启（构造时自动恢复）
  const begun = store.beginAction({
    actionId: `${job.jobId}:merge:${job.version.headSha}`,
    jobId: job.jobId,
    kind: "merge",
  });
  assert.equal(begun.skip, false);
  store.markActionExecuting(begun.action.actionId);
  const reopened = new PatrolStore(dir);
  const reloaded = reopened.getJob(job.jobId);
  assert.equal(reloaded.runs[0].status, "aborted", "运行中的 run 在重启后中止");
  assert.equal(reloaded.lease, undefined, "持有者已中止的租约被清除");
  const actionAfterReopen = reopened.getAction(begun.action.actionId);
  assert.equal(actionAfterReopen?.status, "intended", "执行中的动作回退为已存意图");
  const againRunning = reopened.getJob(job.jobId);
  assert.equal(
    againRunning.runs.every((run) => run.status !== "running"),
    true,
  );

  // 幂等：已完成的动作不允许再次执行
  reopened.markActionResult(begun.action.actionId, { ok: true });
  const again = reopened.beginAction({
    actionId: begun.action.actionId,
    jobId: job.jobId,
    kind: "merge",
  });
  assert.equal(again.skip, true);
  assert.equal(again.action.status, "done");

  // 登记读写
  reopened.saveRegistration({
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    taskId: "task-1",
    origin: "haji",
    registeredAt: new Date().toISOString(),
    taskBrief: "修复 X",
    acceptance: ["测试覆盖 X"],
    scope: ["src/"],
  });
  assert.equal(reopened.getRegistration(job.jobId)?.taskId, "task-1");
  assert.equal(reopened.removeRegistration(job.jobId), true);
  assert.equal(reopened.getRegistration(job.jobId), null);
});
