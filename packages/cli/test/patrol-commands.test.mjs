import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PatrolStore, patrolJobId } from "@hajicli/core";
import { handlePatrolCommand } from "../dist/patrol/commands.js";
import { DEFAULT_PATROL_CONFIG, loadPatrolConfig } from "../dist/patrol/config.js";

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
  assert.ok(ctx.lines.some((line) => line.includes("无法确定巡检仓库")));

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
  assert.equal(registration.mergeAuthorized, true, "手动登记是显式授权，允许自动合并");

  await handlePatrolCommand(ctx, { parts: ["patrol", "unregister", "7"] });
  assert.equal(store.getRegistration(patrolJobId("owner/repo", 7)), null);
});

test("/patrol stop：有常驻巡查时停止，没有时只提示", async () => {
  const ctx = makeCtx();
  let running = true;
  let stopped = 0;
  const ctxWithLoop = {
    ...ctx,
    stopLoop: () => {
      if (!running) return false;
      running = false;
      stopped += 1;
      return true;
    },
  };

  await handlePatrolCommand(ctxWithLoop, { parts: ["patrol", "stop"] });
  assert.equal(stopped, 1);
  assert.ok(ctx.lines.some((line) => line.includes("已停止")));

  await handlePatrolCommand(ctxWithLoop, { parts: ["patrol", "stop"] });
  assert.equal(stopped, 1, "没有在跑的循环不应重复停止");
  assert.ok(ctx.lines.some((line) => line.includes("没有侧栏启动的常驻巡查")));

  // 无头场景（ctx 没有 stopLoop）也不能崩。
  const headless = makeCtx();
  await handlePatrolCommand(headless, { parts: ["patrol", "stop"] });
  assert.ok(headless.lines.some((line) => line.includes("没有侧栏启动的常驻巡查")));
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

test("巡检配置 trustedApps：省略时保留默认，显式空数组禁用信任", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "patrol-config-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const dir = path.join(cwd, ".haji", "patrol");
  fs.mkdirSync(dir, { recursive: true });
  const write = (raw) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(raw));
  assert.deepEqual(loadPatrolConfig(cwd).trustedApps, ["github-actions"]);
  write({ repo: "owner/repo" });
  assert.deepEqual(loadPatrolConfig(cwd).trustedApps, ["github-actions"]);
  const loaded = loadPatrolConfig(cwd);
  loaded.trustedApps.push("custom");
  assert.deepEqual(DEFAULT_PATROL_CONFIG.trustedApps, ["github-actions"]);
  write({ trustedApps: [] });
  assert.deepEqual(loadPatrolConfig(cwd).trustedApps, []);
  write({ trustedApps: [" ci-app ", "other"] });
  assert.deepEqual(loadPatrolConfig(cwd).trustedApps, ["ci-app", "other"]);
});
test("/patrol register：无 config.json 时从 git remote 推断仓库", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-patrol-noremote-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("remote", "add", "origin", "https://github.com/from/remote.git");

  const lines = [];
  const ctx = { cwd, writeLine: (text) => lines.push(text) };
  await handlePatrolCommand(ctx, {
    parts: ["patrol", "register", "8", "--task", "t-8", "--brief", "零配置登记"],
  });
  assert.ok(
    lines.some((line) => line.includes("已登记 PR #8")),
    `应登记成功：${lines.join(" | ")}`,
  );
  const store = new PatrolStore(path.join(cwd, ".haji", "patrol"));
  const registration = store.getRegistration(patrolJobId("from/remote", 8));
  assert.equal(registration.repo, "from/remote");
  assert.equal(registration.taskId, "t-8");
});
test("/patrol：配置损坏时给出可读错误而不抛异常", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-patrol-broken-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".haji", "patrol"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".haji", "patrol", "config.json"), "{ not json");

  const lines = [];
  const ctx = { cwd, writeLine: (text) => lines.push(text) };
  await handlePatrolCommand(ctx, {
    parts: ["patrol", "register", "9", "--task", "t-9", "--brief", "损坏配置"],
  });
  assert.ok(
    lines.some((line) => line.includes("巡检命令失败")),
    `应给出可读错误：${lines.join(" | ")}`,
  );
});
