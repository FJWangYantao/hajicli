import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decideAdoption, normalizePatrolLimits, PatrolStore, patrolJobId } from "@hajicli/core";
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
  constructor(prs = [], { viewerLogin } = {}) {
    this.repo = REPO;
    this.prs = prs;
    this.mergeCalls = [];
    // 只有显式给定时才实现 getViewerLogin：缺省表示「读不到登录名」，走前缀兜底授权。
    if (viewerLogin !== undefined) this.getViewerLogin = async () => viewerLogin;
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

test("自动接管：autoAdoptSelfAuthored 开启后接管本人提交的任意分支 PR", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(31, "head3131", { branch: "feat/mine", author: "me" })], {
    viewerLogin: "me",
  });
  const service = makeService(tmp, forge, { autoAdoptSelfAuthored: true });

  await service.tick();
  const registration = service.store.getRegistration(patrolJobId(REPO, 31));
  assert.ok(registration, "本人提交的 PR 应被接管");
  assert.equal(registration.taskId, "feat/mine", "非前缀命中时 taskId 取整条分支名");
  assert.equal(registration.mergeAuthorized, true);
});

test("自动接管：本人提交但未开启 autoAdoptSelfAuthored 时不接管非前缀分支", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(32, "head3232", { branch: "feat/mine", author: "me" })], {
    viewerLogin: "me",
  });
  const service = makeService(tmp, forge);

  await service.tick();
  assert.equal(service.store.getRegistration(patrolJobId(REPO, 32)), null);
});

test("自动接管：命中 autoAdoptLabels 的 PR 被接管且允许合并", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge(
    [makePr(33, "head3333", { branch: "feat/labeled", author: "someone", labels: ["patrol"] })],
    { viewerLogin: "me" },
  );
  const service = makeService(tmp, forge, { autoAdoptLabels: ["patrol"] });

  await service.tick();
  const registration = service.store.getRegistration(patrolJobId(REPO, 33));
  assert.ok(registration, "命中授权 label 的 PR 应被接管");
  assert.equal(registration.mergeAuthorized, true);
  assert.equal(service.store.getJob(patrolJobId(REPO, 33))?.status, "ready_to_merge");
});

test("合并授权：前缀命中但作者不是本人时接管审查，绝不自动合并", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(34, "head3434", { author: "someone" })], {
    viewerLogin: "me",
  });
  const service = makeService(tmp, forge);

  const result = await service.tick();
  const registration = service.store.getRegistration(patrolJobId(REPO, 34));
  assert.ok(registration, "分支前缀命中仍应接管（便于审查）");
  assert.equal(registration.mergeAuthorized, false, "别人用 haji/ 前缀提的 PR 不应被授权合并");
  assert.ok(
    result.events.some((line) => line.includes("仅审查不合并")),
    `日志应说明只审查不合并：${result.events.join(" | ")}`,
  );

  // 第一轮审查通过进入待合并，第二轮才尝试合并——此时来源未授权，应收敛为仅审查。
  await service.tick();
  const job = service.store.getJob(patrolJobId(REPO, 34));
  assert.equal(job.status, "terminated", "审查通过后应收敛为仅审查，不留在待合并");
  assert.deepEqual(forge.mergeCalls, [], "不得调用合并接口");
});

test("合并授权：解析不到登录名时退回「前缀命中即授权」，保持旧行为", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(35, "head3535", { author: "someone" })]);
  const service = makeService(tmp, forge);

  await service.tick();
  const registration = service.store.getRegistration(patrolJobId(REPO, 35));
  assert.equal(registration.mergeAuthorized, true);
  assert.equal(service.store.getJob(patrolJobId(REPO, 35))?.status, "ready_to_merge");
});

test("decideAdoption：接管与合并授权分层判定", () => {
  const policy = {
    branchPrefixes: ["haji/"],
    selfAuthored: true,
    labels: ["patrol"],
    viewerLogin: "me",
  };
  // 本人提交 + 前缀命中：接管且授权合并。
  assert.deepEqual(decideAdoption({ branch: "haji/x", author: "me" }, policy), {
    adopted: true,
    mergeAuthorized: true,
    matchedPrefix: "haji/",
    reason: "分支前缀 haji/ / 本人提交",
  });
  // 别人 + 前缀：接管但不授权合并。
  assert.deepEqual(decideAdoption({ branch: "haji/x", author: "other" }, policy), {
    adopted: true,
    mergeAuthorized: false,
    matchedPrefix: "haji/",
    reason: "分支前缀 haji/",
  });
  // 别人 + 授权 label：接管且授权合并。
  assert.deepEqual(
    decideAdoption({ branch: "feat/y", author: "other", labels: ["patrol"] }, policy),
    {
      adopted: true,
      mergeAuthorized: true,
      reason: "label patrol",
    },
  );
  // 都不命中：不接管。
  assert.equal(
    decideAdoption({ branch: "feat/y", author: "other", labels: [] }, policy).adopted,
    false,
  );
  // 关掉 selfAuthored 后，本人提交的非前缀分支不再接管。
  assert.equal(
    decideAdoption({ branch: "feat/y", author: "me" }, { ...policy, selfAuthored: false }).adopted,
    false,
  );
});
