import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PatrolHint } from "../dist/patrol/hint.js";

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

test("start：后台启动巡检并上报 running，dispose 后停止", async () => {
  const sink = collect();
  const hint = new PatrolHint({
    cwd: gitRepo(),
    resolveToken: async () => "token",
    onChange: sink.onChange,
    pollIntervalMs: 10,
    createAdapter: () => fakeAdapter([]),
    createRunners: () => ({
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
    }),
  });
  await hint.start();
  assert.equal(sink.last().status, "running");
  assert.equal(sink.last().repo, "owner/repo");
  // 运行中会周期性刷新任务计数（空 store → 0）。
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(sink.states.some((state) => state?.status === "running" && state.tasks === 0));
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
