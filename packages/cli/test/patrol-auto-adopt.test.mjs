import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizePatrolLimits, PatrolStore, patrolJobId } from "@hajicli/core";
import { PatrolService } from "../dist/patrol/service.js";

const REPO = "owner/repo";

function makePr(number, head, overrides = {}) {
  return {
    repo: REPO,
    number,
    state: "open",
    draft: false,
    merged: false,
    branch: `haji/session-${number}`,
    targetBranch: "master",
    headSha: head,
    baseSha: "base0000000",
    title: `PR ${number}`,
    mergeable: true,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeForge {
  constructor(prs = []) {
    this.repo = REPO;
    this.prs = prs;
    this.mergeCalls = [];
  }
  async listOpenPullRequests() {
    return this.prs.filter((pr) => pr.state === "open");
  }
  async getPullRequest(number) {
    return this.prs.find((pr) => pr.number === number) ?? null;
  }
  async listCheckRuns() {
    return [{ name: "ci", status: "success", appSlug: "github-actions" }];
  }
  async getDiff() {
    return "diff --git a/x b/x\n--- a/x\n+++ b/x\n";
  }
  async postStatusComment() {}
  async merge(number, { headSha }) {
    this.mergeCalls.push({ number, headSha });
    return { merged: true, sha: `merge-${headSha.slice(0, 6)}` };
  }
  async close() {}
}

const passingRunners = {
  review: async () => ({ verdict: "pass", findings: [], summary: "没问题" }),
  fix: async () => ({ status: "failed", summary: "不应调用" }),
  adjudicate: async () => ({
    verdict: "terminate",
    reasons: ["不应调用"],
    rejectedFindingIds: [],
    orders: [],
    acceptance: [],
    summary: "不应调用",
  }),
};

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "haji-patrol-adopt-"));
}

function makeService(tmp, forge, configOverrides = {}) {
  return new PatrolService({
    cwd: tmp,
    store: new PatrolStore(path.join(tmp, ".haji", "patrol")),
    adapter: forge,
    runners: passingRunners,
    config: {
      repo: REPO,
      requiredChecks: ["ci"],
      trustedApps: ["github-actions"],
      limits: normalizePatrolLimits({ maxFixRounds: 3, maxAdjudicationRounds: 2 }),
      ...configOverrides,
    },
  });
}

test("自动接管：haji/ 分支的开放 PR 无需 register 即建立任务", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(11, "head1111")]);
  const service = makeService(tmp, forge);

  const result = await service.tick();
  assert.ok(
    result.events.some((line) => line.includes("自动登记 PR #11")),
    `应记录自动登记事件：${result.events.join(" | ")}`,
  );

  const jobId = patrolJobId(REPO, 11);
  const registration = service.store.getRegistration(jobId);
  assert.ok(registration, "应写入来源登记");
  assert.equal(registration.origin, "haji");
  assert.equal(registration.taskId, "session-11");
  assert.equal(registration.taskBrief, "PR 11");

  const job = service.store.getJob(jobId);
  assert.ok(job, "同一轮内应建立巡检任务");
  assert.equal(job.status, "ready_to_merge", `审查通过后应待合并，实际 ${job.status}`);
});

test("自动接管：非 haji/ 分支的 PR 不被接管", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(12, "head1212", { branch: "feat/manual" })]);
  const service = makeService(tmp, forge);

  await service.tick();
  assert.equal(service.store.getRegistration(patrolJobId(REPO, 12)), null);
  assert.equal(service.store.getJob(patrolJobId(REPO, 12)), null);
});

test("自动接管：autoAdoptBranchPrefixes 置空即关闭", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(13, "head1313")]);
  const service = makeService(tmp, forge, { autoAdoptBranchPrefixes: [] });

  await service.tick();
  assert.equal(service.store.getRegistration(patrolJobId(REPO, 13)), null);
  assert.equal(service.store.getJob(patrolJobId(REPO, 13)), null);
});

test("自动接管：配置多个前缀时命中任一即接管，taskId 取命中前缀之后的部分", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([
    makePr(21, "head2121", { branch: "feat/alpha" }),
    makePr(22, "head2222", { branch: "fix/beta" }),
    makePr(23, "head2323", { branch: "chore/gamma" }),
  ]);
  const service = makeService(tmp, forge, {
    autoAdoptBranchPrefixes: ["feat/", "fix/"],
  });

  await service.tick();
  const alpha = service.store.getRegistration(patrolJobId(REPO, 21));
  const beta = service.store.getRegistration(patrolJobId(REPO, 22));
  assert.ok(alpha, "feat/ 前缀应被接管");
  assert.ok(beta, "fix/ 前缀应被接管");
  assert.equal(alpha.taskId, "alpha");
  assert.equal(beta.taskId, "beta");
  assert.equal(
    service.store.getRegistration(patrolJobId(REPO, 23)),
    null,
    "未命中任何前缀的 chore/ 分支不应被接管",
  );
});

test("自动接管：已手动登记的任务不被覆盖", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(14, "head1414")]);
  const service = makeService(tmp, forge);
  service.store.saveRegistration({
    jobId: patrolJobId(REPO, 14),
    repo: REPO,
    prNumber: 14,
    taskId: "manual-task",
    origin: "haji",
    registeredAt: new Date().toISOString(),
    taskBrief: "人工登记的任务",
    acceptance: ["测试覆盖"],
    scope: ["src/"],
  });

  await service.tick();
  const registration = service.store.getRegistration(patrolJobId(REPO, 14));
  assert.equal(registration.taskId, "manual-task");
  assert.equal(registration.taskBrief, "人工登记的任务");
  assert.equal(registration.acceptance.length, 1);
});
