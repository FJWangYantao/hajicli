import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PatrolStore, patrolJobId } from "@hajicli/core";
import { handlePatrolCommand } from "../dist/patrol/commands.js";

function makeCtx() {
  const lines = [];
  return {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "haji-patrol-cmd-")),
    writeLine: (text) => lines.push(text),
    lines,
  };
}

function withConfig(ctx) {
  fs.mkdirSync(path.join(ctx.cwd, ".haji", "patrol"), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.cwd, ".haji", "patrol", "config.json"),
    JSON.stringify({ repo: "owner/repo", requiredChecks: ["ci"] }),
  );
}

test("/patrol：空状态与未知子命令", async () => {
  const ctx = makeCtx();
  await handlePatrolCommand(ctx, { parts: ["patrol"] });
  assert.ok(ctx.lines.some((line) => line.includes("暂无任务")));
  await handlePatrolCommand(ctx, { parts: ["patrol", "bogus"] });
  assert.ok(ctx.lines.some((line) => line.includes("未知子命令")));
});

test("/patrol register：写入来源登记；缺配置报错", async () => {
  const ctx = makeCtx();
  await handlePatrolCommand(ctx, {
    parts: [
      "patrol",
      "register",
      "7",
      "--task",
      "t-7",
      "--brief",
      "修复 X",
      "--accept",
      "测试覆盖",
    ],
  });
  assert.ok(ctx.lines.some((line) => line.includes("缺少仓库配置")));

  withConfig(ctx);
  await handlePatrolCommand(ctx, {
    parts: [
      "patrol",
      "register",
      "7",
      "--task",
      "t-7",
      "--brief",
      "修复 X",
      "--accept",
      "测试覆盖",
    ],
  });
  const store = new PatrolStore(path.join(ctx.cwd, ".haji", "patrol"));
  const registration = store.getRegistration(patrolJobId("owner/repo", 7));
  assert.equal(registration.taskId, "t-7");
  assert.deepEqual(registration.acceptance, ["测试覆盖"]);

  await handlePatrolCommand(ctx, { parts: ["patrol", "unregister", "7"] });
  assert.equal(store.getRegistration(patrolJobId("owner/repo", 7)), null);
});

test("/patrol pause / resume：切换暂停标记", async () => {
  const ctx = makeCtx();
  await handlePatrolCommand(ctx, { parts: ["patrol", "pause"] });
  const store = new PatrolStore(path.join(ctx.cwd, ".haji", "patrol"));
  assert.equal(store.isPaused(), true);
  await handlePatrolCommand(ctx, { parts: ["patrol", "resume"] });
  assert.equal(new PatrolStore(path.join(ctx.cwd, ".haji", "patrol")).isPaused(), false);
});

test("/patrol status / inspect / retry：任务展示与重置", async () => {
  const ctx = makeCtx();
  const store = new PatrolStore(path.join(ctx.cwd, ".haji", "patrol"));
  const now = new Date().toISOString();
  store.saveJob({
    jobId: patrolJobId("owner/repo", 7),
    repo: "owner/repo",
    prNumber: 7,
    branch: "agent/fix",
    targetBranch: "master",
    source: { taskId: "t-7", origin: "haji", verified: true },
    taskBrief: "修复 X",
    acceptance: [],
    scope: [],
    version: { headSha: "aaaa1111bbbb", baseSha: "b0000000000", ruleVersion: "v1" },
    status: "terminated",
    draft: false,
    fixRounds: 2,
    adjudicationRounds: 1,
    findings: [
      { findingId: "f-1", severity: "blocking", summary: "问题", evidence: "e", state: "open" },
    ],
    decisions: [],
    runs: [],
    usage: { promptTokens: 100, completionTokens: 50, costCny: 1.5 },
    createdAt: now,
    updatedAt: now,
    terminatedReason: "预算耗尽",
  });

  await handlePatrolCommand(ctx, { parts: ["patrol", "status"] });
  assert.ok(ctx.lines.some((line) => line.includes("#7")));
  assert.ok(ctx.lines.some((line) => line.includes("已终止")));

  await handlePatrolCommand(ctx, { parts: ["patrol", "inspect", "7"] });
  assert.ok(ctx.lines.some((line) => line.includes("aaaa111")));
  assert.ok(ctx.lines.some((line) => line.includes("预算耗尽")));

  await handlePatrolCommand(ctx, { parts: ["patrol", "retry", "7"] });
  const job = new PatrolStore(path.join(ctx.cwd, ".haji", "patrol")).getJob(
    patrolJobId("owner/repo", 7),
  );
  assert.equal(job.status, "discovered");
  assert.equal(job.terminatedReason, undefined);

  await handlePatrolCommand(ctx, { parts: ["patrol", "inspect", "99"] });
  assert.ok(ctx.lines.some((line) => line.includes("没有 PR #99")));
});
