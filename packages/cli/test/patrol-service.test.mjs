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
    branch: `agent/pr-${number}`,
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
    this.checksByHead = new Map();
    this.comments = new Map();
    this.mergeCalls = [];
    this.closed = [];
  }
  async listOpenPullRequests() {
    return this.prs.filter((pr) => pr.state === "open");
  }
  async getPullRequest(number) {
    return this.prs.find((pr) => pr.number === number) ?? null;
  }
  async listCheckRuns(head) {
    return (
      this.checksByHead.get(head) ?? [{ name: "ci", status: "success", appSlug: "github-actions" }]
    );
  }
  async getDiff() {
    return "diff --git a/x b/x\n--- a/x\n+++ b/x\n";
  }
  async postStatusComment(number, _marker, body) {
    this.comments.set(number, body);
  }
  async merge(number, { headSha }) {
    this.mergeCalls.push({ number, headSha });
    const pr = this.prs.find((item) => item.number === number);
    if (!pr) throw new Error("GitHub API 404：PR 不存在");
    if (pr.headSha !== headSha) throw new Error("GitHub API 409：head 不匹配");
    if (pr.state !== "open" || pr.merged) {
      return { merged: true, alreadyMerged: true };
    }
    pr.state = "closed";
    pr.merged = true;
    return { merged: true, sha: `merge-${headSha.slice(0, 6)}` };
  }
  async close(number) {
    const pr = this.prs.find((item) => item.number === number);
    if (pr) pr.state = "closed";
    this.closed.push(number);
  }
  /** 测试辅助：把 PR head 推进到新提交（模拟执行 agent push）。 */
  pushTo(number, newHead) {
    const pr = this.prs.find((item) => item.number === number);
    if (!pr) throw new Error("no such pr");
    pr.headSha = newHead;
    pr.updatedAt = new Date().toISOString();
  }
}

function scriptRunners(scripts) {
  const calls = { review: [], fix: [], adjudicate: [] };
  const queues = {
    review: [...(scripts.review ?? [])],
    fix: [...(scripts.fix ?? [])],
    adjudicate: [...(scripts.adjudicate ?? [])],
  };
  const defaultReview = { verdict: "pass", findings: [], summary: "默认通过" };
  return {
    calls,
    runners: {
      review: async (input) => {
        calls.review.push(input);
        const output = queues.review.shift() ?? defaultReview;
        if (typeof output === "function") return output(input);
        return output;
      },
      fix: async (input) => {
        calls.fix.push(input);
        const output = queues.fix.shift();
        if (typeof output === "function") return output(input);
        return output ?? { status: "failed", summary: "fix 队列为空" };
      },
      adjudicate: async (input) => {
        calls.adjudicate.push(input);
        const output = queues.adjudicate.shift();
        if (typeof output === "function") return output(input);
        return (
          output ?? {
            verdict: "overrule",
            reasons: ["问题不成立"],
            rejectedFindingIds: input.findings.map((f) => f.findingId),
            orders: [],
            acceptance: [],
            summary: "默认驳回",
          }
        );
      },
    },
  };
}

function blocking(summary = "存在缺陷", id) {
  return id
    ? { findingId: id, summary, evidence: "证据", requiredFix: "修复并测试" }
    : { summary, evidence: "证据", requiredFix: "修复并测试" };
}

function makeService(tmp, adapter, runners, configOverrides = {}) {
  const store = new PatrolStore(path.join(tmp, ".haji", "patrol"));
  return new PatrolService({
    cwd: tmp,
    store,
    adapter,
    runners,
    config: {
      repo: REPO,
      requiredChecks: ["ci"],
      trustedApps: ["github-actions"],
      limits: normalizePatrolLimits({ maxFixRounds: 3, maxAdjudicationRounds: 2 }),
      ...configOverrides,
    },
  });
}

function register(store, number, overrides = {}) {
  store.saveRegistration({
    jobId: patrolJobId(REPO, number),
    repo: REPO,
    prNumber: number,
    taskId: `task-${number}`,
    origin: "haji",
    registeredAt: new Date().toISOString(),
    taskBrief: `任务 ${number}`,
    acceptance: ["测试覆盖"],
    scope: ["src/"],
    ...overrides,
  });
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "haji-patrol-svc-"));
}

test("闭环：审查通过 → 门禁 → 自动合并", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(1, "aaaa1111")]);
  const { runners, calls } = scriptRunners({
    review: [{ verdict: "pass", findings: [], summary: "没问题" }],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 1);

  const t1 = await service.tick();
  const job1 = service.store.getJob(patrolJobId(REPO, 1));
  assert.equal(
    job1.status,
    "ready_to_merge",
    `第一轮后应待合并，实际 ${job1.status}：${t1.events.join("|")}`,
  );

  const t2 = await service.tick();
  const job2 = service.store.getJob(patrolJobId(REPO, 1));
  assert.equal(job2.status, "merged", `第二轮后应已合并：${t2.events.join("|")}`);
  assert.equal(forge.mergeCalls.length, 1);
  assert.equal(forge.mergeCalls[0].headSha, "aaaa1111");
  assert.equal(calls.review.length, 1);
  assert.ok(forge.comments.get(1).includes("已合并"));
});

test("闭环：退回修改 → 推送新提交 → 重审通过 → 合并", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(2, "bbbb1111")]);
  const { runners, calls } = scriptRunners({
    review: [
      { verdict: "changes_required", findings: [blocking("空指针风险")], summary: "有问题" },
      { verdict: "pass", findings: [], summary: "已修复" },
    ],
    fix: [
      (input) => {
        assert.equal(input.findings.length, 1, "修复输入应包含阻塞问题");
        forge.pushTo(2, "bbbb2222");
        return { status: "pushed", summary: "已修复并推送", pushedHeadSha: "bbbb2222" };
      },
    ],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 2);

  await service.tick(); // 审查退回
  let job = service.store.getJob(patrolJobId(REPO, 2));
  assert.equal(job.status, "awaiting_changes");
  assert.equal(job.fixRounds, 0);
  assert.equal(job.findings.filter((f) => f.state === "open").length, 1);

  await service.tick(); // 修改推送
  job = service.store.getJob(patrolJobId(REPO, 2));
  assert.equal(job.status, "reviewing");
  assert.equal(job.fixRounds, 1);

  await service.tick(); // 对账发现新 head → 重审通过
  job = service.store.getJob(patrolJobId(REPO, 2));
  assert.equal(job.status, "ready_to_merge");
  assert.equal(job.version.headSha, "bbbb2222");
  assert.equal(
    job.findings.find((f) => f.severity === "blocking").state,
    "resolved",
    "旧问题应被标记解决",
  );

  await service.tick(); // 合并
  job = service.store.getJob(patrolJobId(REPO, 2));
  assert.equal(job.status, "merged");
  assert.equal(calls.review.length, 2);
  assert.equal(calls.fix.length, 1);
  assert.equal(forge.mergeCalls[0].headSha, "bbbb2222");
});

test("闭环：异议 → 裁决驳回误报 → 合并", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(3, "cccc1111")]);
  const { runners, calls } = scriptRunners({
    review: [
      {
        verdict: "changes_required",
        findings: [blocking("风格问题被误报为阻塞")],
        summary: "退回",
      },
    ],
    fix: [{ status: "disputed", summary: "该问题不成立", disputeReason: "有测试证明行为正确" }],
    adjudicate: [
      (input) => {
        assert.ok(input.disputeReason.includes("测试证明"), "裁决输入应包含异议理由");
        return {
          verdict: "overrule",
          reasons: ["审查误报"],
          rejectedFindingIds: input.findings.map((f) => f.findingId),
          orders: [],
          acceptance: [],
          summary: "驳回",
        };
      },
    ],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 3);

  await service.tick(); // 审查退回
  await service.tick(); // 修改 → 异议 → 裁决
  let job = service.store.getJob(patrolJobId(REPO, 3));
  assert.equal(job.status, "adjudicating");

  await service.tick(); // 裁决驳回 → 待合并
  job = service.store.getJob(patrolJobId(REPO, 3));
  assert.equal(job.status, "ready_to_merge");
  assert.equal(job.adjudicationRounds, 1);
  assert.equal(job.findings[0].state, "rejected");

  await service.tick(); // 合并
  job = service.store.getJob(patrolJobId(REPO, 3));
  assert.equal(job.status, "merged");
  assert.equal(calls.adjudicate.length, 1);
});

test("闭环：裁决指令修复（remediate）→ 执行 → 验证合并", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(4, "dddd1111")]);
  const { runners, calls } = scriptRunners({
    review: [{ verdict: "changes_required", findings: [blocking("并发缺陷")], summary: "退回" }],
    fix: [
      { status: "disputed", summary: "不是缺陷", disputeReason: "单线程场景" },
      (input) => {
        assert.ok(input.orders.length > 0, "裁决修复必须携带指令");
        forge.pushTo(4, "dddd2222");
        return { status: "pushed", summary: "按指令修复", pushedHeadSha: "dddd2222" };
      },
    ],
    adjudicate: [
      {
        verdict: "remediate",
        reasons: ["问题成立"],
        rejectedFindingIds: [],
        orders: ["加锁并补并发测试"],
        acceptance: ["并发测试通过"],
        summary: "维持问题",
      },
    ],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 4);

  await service.tick(); // 审查退回
  await service.tick(); // 异议 → 裁决
  await service.tick(); // 裁决 remediate → enforcing
  let job = service.store.getJob(patrolJobId(REPO, 4));
  assert.equal(job.status, "enforcing");

  await service.tick(); // 按指令修复推送
  job = service.store.getJob(patrolJobId(REPO, 4));
  assert.equal(job.status, "reviewing");

  // 重审（脚本 review 队列已空 → 默认 pass）
  await service.tick();
  job = service.store.getJob(patrolJobId(REPO, 4));
  assert.equal(job.status, "ready_to_merge");
  await service.tick();
  job = service.store.getJob(patrolJobId(REPO, 4));
  assert.equal(job.status, "merged");
  assert.equal(calls.fix.length, 2);
});

test("闭环：轮次耗尽升级裁决，裁决终止则终止任务", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(5, "eeee1111")]);
  const { runners } = scriptRunners({
    review: [
      { verdict: "changes_required", findings: [blocking("缺陷 A")], summary: "退回 1" },
      { verdict: "changes_required", findings: [blocking("缺陷 A")], summary: "退回 2" },
      { verdict: "changes_required", findings: [blocking("缺陷 A")], summary: "退回 3" },
      { verdict: "changes_required", findings: [blocking("缺陷 A")], summary: "退回 4" },
    ],
    fix: [1, 2, 3].map((round) => () => {
      forge.pushTo(5, `eeee000${round}`);
      return { status: "pushed", summary: `第 ${round} 次修复` };
    }),
    adjudicate: [
      {
        verdict: "terminate",
        reasons: ["问题反复出现，方案不可行"],
        rejectedFindingIds: [],
        orders: [],
        acceptance: [],
        summary: "终止",
      },
    ],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 5);

  for (let index = 0; index < 12; index += 1) {
    await service.tick();
    const job = service.store.getJob(patrolJobId(REPO, 5));
    if (job.status === "terminated") break;
    if (index > 0) {
      // fix 队列空了以后默认 failed，这里保证脚本 fix 每轮都生效
    }
  }
  const job = service.store.getJob(patrolJobId(REPO, 5));
  assert.equal(job.status, "terminated");
  assert.match(job.terminatedReason, /不可行/);
  assert.equal(job.fixRounds, 3, "普通修改恰好 3 轮后升级");
  assert.equal(job.adjudicationRounds, 1);
});

test("闭环：fix 连续失败按次数升级裁决，不会无限重试", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(6, "aaaa1111")]);
  const { runners, calls } = scriptRunners({
    review: [{ verdict: "changes_required", findings: [blocking("缺陷 B")], summary: "退回" }],
    adjudicate: [
      {
        verdict: "terminate",
        reasons: ["连续失败，无法继续"],
        rejectedFindingIds: [],
        orders: [],
        acceptance: [],
        summary: "终止",
      },
    ],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 6);

  for (let index = 0; index < 12; index += 1) {
    await service.tick();
    const job = service.store.getJob(patrolJobId(REPO, 6));
    if (job.status === "terminated") break;
  }
  const job = service.store.getJob(patrolJobId(REPO, 6));
  assert.equal(job.status, "terminated");
  assert.match(job.terminatedReason, /连续失败/);
  // fix 队列为空时脚本 runner 默认返回 failed：连续 3 次失败后必须升级，而不是无限重试。
  assert.equal(calls.fix.length, 4, "连续第 4 次失败（>maxRunRetries=3）后升级裁决");
  assert.equal(job.adjudicationRounds, 1);
  const failedRuns = job.runs.filter((run) => run.role === "fix");
  assert.equal(failedRuns.length, 4);
  assert.ok(
    failedRuns.every((run) => run.status === "failed"),
    "结果失败的 run 应记为 failed",
  );
});

test("审查期间新增提交：旧结论作废并重审", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(6, "ffff1111")]);
  const { runners } = scriptRunners({
    review: [{ verdict: "pass", findings: [], summary: "通过旧版本" }],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 6);

  await service.tick(); // 旧版本审查通过 → ready_to_merge
  forge.pushTo(6, "ffff9999"); // 在合并前有人推了新提交
  const t = await service.tick();
  const job = service.store.getJob(patrolJobId(REPO, 6));
  assert.notEqual(job.status, "merged", "绝不能基于旧结论合并新提交");
  assert.equal(job.version.headSha, "ffff9999");
  assert.ok(t.events.some((event) => event.includes("旧结论作废")));
  assert.equal(forge.mergeCalls.length, 0);
});

test("服务重启恢复：新实例从持久化状态继续闭环", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(7, "abab1111")]);
  const first = scriptRunners({
    review: [{ verdict: "changes_required", findings: [blocking("缺陷")], summary: "退回" }],
  });
  const service1 = makeService(tmp, forge, first.runners);
  register(service1.store, 7);
  await service1.tick();
  assert.equal(service1.store.getJob(patrolJobId(REPO, 7)).status, "awaiting_changes");

  // 重启：同一目录、新 store、新 service（runner 换成修复+通过剧本）
  const second = scriptRunners({
    fix: [
      () => {
        forge.pushTo(7, "abab2222");
        return { status: "pushed", summary: "修复", pushedHeadSha: "abab2222" };
      },
    ],
  });
  const service2 = new PatrolService({
    cwd: tmp,
    store: new PatrolStore(path.join(tmp, ".haji", "patrol")),
    adapter: forge,
    runners: second.runners,
    config: {
      repo: REPO,
      requiredChecks: ["ci"],
      trustedApps: ["github-actions"],
      limits: normalizePatrolLimits(),
    },
  });
  await service2.tick(); // 修改推送
  await service2.tick(); // 对账 + 重审（默认 pass）
  await service2.tick(); // 合并
  const job = service2.store.getJob(patrolJobId(REPO, 7));
  assert.equal(job.status, "merged");
});

test("幂等合并：合并已执行但确认前崩溃，恢复后不重复合并", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(8, "bcbc1111")]);
  const { runners } = scriptRunners({
    review: [{ verdict: "pass", findings: [], summary: "通过" }],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 8);
  await service.tick(); // ready_to_merge
  await service.tick(); // 合并完成

  // 模拟崩溃：合并动作已 done，但任务状态停在 merging（确认前丢失）。
  // 同时让 PR 重新显示为 open（模拟合并队列 / 状态最终一致的窗口），
  // 强制走「beginAction 命中 done → 直接收敛」的幂等路径。
  const job = service.store.getJob(patrolJobId(REPO, 8));
  job.status = "merging";
  job.mergedAt = undefined;
  service.store.saveJob(job);
  const pr8 = forge.prs.find((pr) => pr.number === 8);
  pr8.state = "open";
  pr8.merged = false;

  const t = await service.tick();
  const after = service.store.getJob(patrolJobId(REPO, 8));
  assert.equal(after.status, "merged");
  assert.equal(forge.mergeCalls.length, 1, "不能重复调用 merge");
  assert.ok(t.events.some((event) => event.includes("此前已完成")));
});

test("未登记来源的 PR 不被接管；PR 被关闭则终止", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(9, "cdcd1111"), makePr(10, "efef1111")]);
  const { runners } = scriptRunners({});
  const service = makeService(tmp, forge, runners);
  register(service.store, 10); // 只登记 10

  await service.tick();
  assert.equal(service.store.getJob(patrolJobId(REPO, 9)), null, "未登记不建任务");

  // 关闭 PR 10
  const pr10 = forge.prs.find((pr) => pr.number === 10);
  pr10.state = "closed";
  await service.tick();
  const job = service.store.getJob(patrolJobId(REPO, 10));
  assert.equal(job.status, "terminated");
  assert.match(job.terminatedReason, /关闭/);
});

test("暂停时不推进；CI 未通过时不合并", async () => {
  const tmp = tmpHome();
  const forge = new FakeForge([makePr(11, "dada1111")]);
  const { runners } = scriptRunners({
    review: [{ verdict: "pass", findings: [], summary: "通过" }],
  });
  const service = makeService(tmp, forge, runners);
  register(service.store, 11);
  await service.tick(); // ready_to_merge

  forge.checksByHead.set("dada1111", [
    { name: "ci", status: "pending", appSlug: "github-actions" },
  ]);
  await service.tick();
  assert.equal(
    service.store.getJob(patrolJobId(REPO, 11)).status,
    "ready_to_merge",
    "CI pending 不能合并",
  );
  assert.equal(forge.mergeCalls.length, 0);

  service.store.setPaused(true);
  const paused = await service.tick();
  assert.equal(paused.skipped, "paused");
  forge.checksByHead.set("dada1111", [
    { name: "ci", status: "success", appSlug: "github-actions" },
  ]);
  await service.tick();
  assert.equal(
    service.store.getJob(patrolJobId(REPO, 11)).status,
    "ready_to_merge",
    "暂停期间不推进",
  );

  service.store.setPaused(false);
  await service.tick();
  assert.equal(service.store.getJob(patrolJobId(REPO, 11)).status, "merged");
});
