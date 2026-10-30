import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeActivity, PatrolHint } from "../dist/patrol/hint.js";

function tmpDir(prefix = "haji-patrol-hint-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitRepo(remote = "https://github.com/owner/repo.git") {
  const cwd = tmpDir();
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  if (remote) git("remote", "add", "origin", remote);
  return cwd;
}

function pullRequest(number, branch) {
  return {
    repo: "owner/repo",
    number,
    state: "open",
    draft: false,
    merged: false,
    branch,
    targetBranch: "master",
    headSha: `head${number}`,
    baseSha: "base0000000",
    title: `PR ${number}`,
    mergeable: true,
    updatedAt: new Date().toISOString(),
  };
}

function fakeAdapter(prs = []) {
  return {
    repo: "owner/repo",
    listOpenPullRequests: async () => prs,
    getPullRequest: async () => null,
    listCheckRuns: async () => [],
    getDiff: async () => "",
    postStatusComment: async () => {},
    merge: async () => ({ merged: true }),
    close: async () => {},
  };
}

function collect() {
  const states = [];
  return {
    states,
    onChange: (state) => states.push(state),
    last: () => states[states.length - 1],
  };
}

test("probe：非 git 目录不显示入口", async () => {
  const sink = collect();
  const hint = new PatrolHint({
    cwd: tmpDir(),
    resolveToken: async () => "token",
    onChange: sink.onChange,
  });
  await hint.probe();
  hint.dispose();
  assert.deepEqual(sink.states, [null]);
});

test("probe：没有令牌时提示需令牌，不联网", async () => {
  const sink = collect();
  let called = false;
  const hint = new PatrolHint({
    cwd: gitRepo(),
    resolveToken: async () => undefined,
    onChange: sink.onChange,
    createAdapter: () => {
      called = true;
      return fakeAdapter();
    },
  });
  await hint.probe();
  hint.dispose();
  assert.equal(called, false);
  assert.equal(sink.last().status, "no-token");
  assert.equal(sink.last().repo, "owner/repo");
});

test("probe：数出待接管的 agent PR，忽略其它分支", async () => {
  const sink = collect();
  const hint = new PatrolHint({
    cwd: gitRepo(),
    resolveToken: async () => "token",
    onChange: sink.onChange,
    createAdapter: () =>
      fakeAdapter([
        pullRequest(1, "haji/session-a"),
        pullRequest(2, "haji/session-b"),
        pullRequest(3, "feat/manual"),
      ]),
  });
  await hint.probe();
  hint.dispose();
  assert.equal(sink.last().status, "ready");
  assert.equal(sink.last().pending, 2);
});

test("probe：按接管策略计数（label 授权），不只认分支前缀", async () => {
  const cwd = gitRepo();
  fs.mkdirSync(path.join(cwd, ".haji", "patrol"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".haji", "patrol", "config.json"),
    JSON.stringify({ repo: "owner/repo", autoAdoptLabels: ["patrol"] }),
  );
  const sink = collect();
  const hint = new PatrolHint({
    cwd,
    resolveToken: async () => "token",
    onChange: sink.onChange,
    createAdapter: () => ({
      ...fakeAdapter([
        { ...pullRequest(1, "feat/labeled"), author: "someone", labels: ["patrol"] },
        { ...pullRequest(2, "feat/plain"), author: "someone", labels: [] },
        { ...pullRequest(3, "haji/session-c"), author: "someone" },
      ]),
      getViewerLogin: async () => "me",
    }),
  });
  await hint.probe();
  hint.dispose();
  assert.equal(sink.last().status, "ready");
  assert.equal(sink.last().pending, 2, "label 命中与前缀命中的 PR 都算待接管");
});

test("probe：远端失败时静默隐藏入口", async () => {
  const sink = collect();
  const hint = new PatrolHint({
    cwd: gitRepo(),
    resolveToken: async () => "token",
    onChange: sink.onChange,
    createAdapter: () => ({
      ...fakeAdapter(),
      listOpenPullRequests: async () => {
        throw new Error("GitHub API 401：Bad credentials");
      },
    }),
  });
  await hint.probe();
  hint.dispose();
  assert.deepEqual(sink.states, [null]);
});

function fakeRunners() {
  return {
    review: async () => ({ verdict: "pass", findings: [], summary: "" }),
    fix: async () => ({ status: "failed", summary: "" }),
    adjudicate: async () => ({
      verdict: "terminate",
      reasons: [],
      rejectedFindingIds: [],
      orders: [],
      acceptance: [],
      summary: "",
    }),
  };
}

function residentHint(sink, cwd = gitRepo(), prs = []) {
  return new PatrolHint({
    cwd,
    resolveToken: async () => "token",
    onChange: sink.onChange,
    pollIntervalMs: 10,
    minRunningMs: 5,
    createAdapter: () => fakeAdapter(prs),
    createRunners: fakeRunners,
  });
}

test("start：点击即进入常驻，没活时转为 waiting", async () => {
  const sink = collect();
  const hint = residentHint(sink);
  await hint.start();
  // 点击瞬间进入 running；空仓库没有可推进任务，随后转 waiting 并保持常驻。
  assert.equal(sink.states[0].status, "running");
  assert.equal(sink.states[0].repo, "owner/repo");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sink.last().status, "waiting");
  assert.equal(hint.isRunning(), true, "waiting 期间循环仍在跑，不能被当成已结束");
  hint.dispose();
});

test("start：再点一次即停止并回到 ready", async () => {
  const sink = collect();
  const hint = residentHint(sink);
  await hint.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hint.isRunning(), true);

  await hint.start();
  assert.equal(hint.isRunning(), false, "再次点击应停止常驻巡查");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sink.last().status, "ready");
  hint.dispose();
});

test("start：缺令牌时不启动，只把入口切成需令牌", async () => {
  const sink = collect();
  const logs = [];
  const hint = new PatrolHint({
    cwd: gitRepo(),
    resolveToken: async () => undefined,
    onChange: sink.onChange,
    log: (line) => logs.push(line),
  });
  await hint.start();
  hint.dispose();
  assert.equal(sink.last().status, "no-token");
  assert.ok(logs.some((line) => line.includes("gh auth login")));
});

// ---- 侧栏「当前在做什么」 ----

function activityJob(overrides = {}) {
  return {
    jobId: "owner/repo#12",
    repo: "owner/repo",
    prNumber: 12,
    branch: "haji/task-12",
    targetBranch: "master",
    status: "reviewing",
    draft: false,
    version: { headSha: "a".repeat(40), baseSha: "base", ruleVersion: "v1" },
    runs: [],
    ...overrides,
  };
}

test("describeActivity：运行中的 run 显示阶段与已耗时", () => {
  const startedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  const job = activityJob({
    runs: [{ runId: "run-1", role: "review", status: "running", startedAt, attempt: 1 }],
  });
  assert.equal(describeActivity([job]), "#12 审查中 · 3m");
});

test("describeActivity：刚启动的 run 不显示耗时", () => {
  const job = activityJob({
    runs: [
      {
        runId: "run-1",
        role: "fix",
        status: "running",
        startedAt: new Date().toISOString(),
        attempt: 1,
      },
    ],
  });
  assert.equal(describeActivity([job]), "#12 修复中");
});

test("describeActivity：合并门禁 / 草稿等待 / 终态", () => {
  assert.equal(describeActivity([activityJob({ status: "ready_to_merge" })]), "#12 合并门禁");
  assert.equal(
    describeActivity([activityJob({ status: "discovered", draft: true })]),
    "#12 草稿等待",
  );
  assert.equal(describeActivity([activityJob({ status: "merged" })]), undefined);
  assert.equal(describeActivity([]), undefined);
});
