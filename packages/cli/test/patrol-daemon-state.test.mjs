import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearDaemonState,
  DAEMON_STALE_MS,
  daemonStatePath,
  readDaemonState,
  writeDaemonState,
} from "../dist/patrol/daemon-state.js";
import { PatrolHint } from "../dist/patrol/hint.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "haji-patrol-daemon-"));
}

/** 用当前进程 pid：真实存活，避免依赖 mock。 */
function aliveState(overrides = {}) {
  return {
    pid: process.pid,
    repo: "owner/repo",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    tasks: 2,
    merged: 1,
    ...overrides,
  };
}

test("writeDaemonState / readDaemonState：写入后可原样读回", () => {
  const cwd = tmpDir();
  writeDaemonState(cwd, aliveState({ activity: "#12 审查中 · 3m" }));
  const state = readDaemonState(cwd);
  assert.equal(state?.repo, "owner/repo");
  assert.equal(state?.status, "running");
  assert.equal(state?.tasks, 2);
  assert.equal(state?.merged, 1);
  assert.equal(state?.activity, "#12 审查中 · 3m");
});

test("readDaemonState：文件不存在时返回 undefined", () => {
  assert.equal(readDaemonState(tmpDir()), undefined);
});

test("readDaemonState：坏 JSON / 结构非法都当没有守护进程", () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.dirname(daemonStatePath(cwd)), { recursive: true });
  fs.writeFileSync(daemonStatePath(cwd), "{ 半截");
  assert.equal(readDaemonState(cwd), undefined);

  // status 不在枚举里 → 坏文件。
  writeDaemonState(cwd, { ...aliveState(), status: "paused" });
  assert.equal(readDaemonState(cwd), undefined);

  // pid 不是正整数 → 坏文件。
  fs.writeFileSync(daemonStatePath(cwd), JSON.stringify({ ...aliveState(), pid: 0 }));
  assert.equal(readDaemonState(cwd), undefined);
});

test("readDaemonState：心跳停更超过阈值即失效（进程卡死但 pid 还在）", () => {
  const cwd = tmpDir();
  const updatedAt = new Date(Date.now() - DAEMON_STALE_MS - 1_000).toISOString();
  writeDaemonState(cwd, aliveState({ updatedAt }));
  // pid 是真实存活的，这里只能靠陈旧判定拦下。
  assert.equal(readDaemonState(cwd, { isAlive: () => true }), undefined);
  // 阈值内则照常读出。
  assert.ok(readDaemonState(cwd, { isAlive: () => true, staleMs: DAEMON_STALE_MS + 2_000 }));
});

test("readDaemonState：pid 已消失时失效（文件残留）", () => {
  const cwd = tmpDir();
  writeDaemonState(cwd, aliveState());
  assert.equal(readDaemonState(cwd, { isAlive: () => false }), undefined);
});

test("clearDaemonState：只删自己写的状态，不误删别的守护进程", () => {
  const cwd = tmpDir();
  writeDaemonState(cwd, aliveState({ pid: process.pid + 1 }));
  clearDaemonState(cwd, process.pid);
  assert.ok(readDaemonState(cwd, { isAlive: () => true }), "别的 pid 的状态不该被删");

  writeDaemonState(cwd, aliveState());
  clearDaemonState(cwd, process.pid);
  assert.equal(readDaemonState(cwd, { isAlive: () => true }), undefined);
});

/** 侧栏集成：守护进程在跑时，probe 直接反映它的状态，且不联网。 */
test("probe：外部守护进程在跑时直接显示 running，不发起网络探测", async () => {
  const cwd = tmpDir();
  writeDaemonState(cwd, aliveState({ status: "running", tasks: 3, activity: "#7 修复中 · 2m" }));
  const states = [];
  let probed = false;
  const hint = new PatrolHint({
    cwd,
    resolveToken: async () => "token",
    onChange: (state) => states.push(state),
    createAdapter: () => {
      probed = true;
      throw new Error("守护进程在跑时不该联网探测");
    },
  });
  await hint.probe();
  hint.dispose();
  assert.equal(probed, false, "不该调用适配器");
  const last = states[states.length - 1];
  assert.equal(last.status, "running");
  assert.equal(last.tasks, 3);
  assert.equal(last.activity, "#7 修复中 · 2m");
  assert.equal(last.repo, "owner/repo");
});

test("probe：守护进程心跳陈旧时退回正常探测（按就绪渲染）", async () => {
  const cwd = tmpDir();
  // 没有 git remote 时靠配置里的 repo 推断仓库，才能走到「令牌判定」这一步。
  fs.mkdirSync(path.join(cwd, ".haji", "patrol"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".haji", "patrol", "config.json"),
    JSON.stringify({ repo: "owner/repo" }),
  );
  writeDaemonState(cwd, aliveState({ updatedAt: new Date(0).toISOString() }));
  const states = [];
  const hint = new PatrolHint({
    cwd,
    resolveToken: async () => undefined,
    onChange: (state) => states.push(state),
  });
  await hint.probe();
  hint.dispose();
  // 没有令牌 → no-token，而不是 running：说明陈旧状态没被采信。
  assert.equal(states[states.length - 1]?.status, "no-token");
});

test("start：守护进程在跑时拒绝起第二个循环，并提示用 systemctl", async () => {
  const cwd = tmpDir();
  writeDaemonState(cwd, aliveState());
  const logs = [];
  const hint = new PatrolHint({
    cwd,
    resolveToken: async () => "token",
    onChange: () => {},
    log: (line) => logs.push(line),
  });
  await hint.start();
  hint.dispose();
  assert.equal(hint.isRunning(), false, "不该启动本会话的循环");
  assert.ok(
    logs.some((line) => line.includes("systemctl --user stop haji-patrol")),
    "应提示改由 systemctl 接管",
  );
});

test("stop：没有本会话常驻但守护进程在跑时，提示 systemctl 而不是「没有运行」", () => {
  const cwd = tmpDir();
  writeDaemonState(cwd, aliveState());
  const logs = [];
  const hint = new PatrolHint({
    cwd,
    resolveToken: async () => "token",
    onChange: () => {},
    log: (line) => logs.push(line),
  });
  assert.equal(hint.isDaemonRunning(), true);
  hint.stop();
  hint.dispose();
  assert.ok(logs.some((line) => line.includes("systemctl --user stop haji-patrol")));
  assert.ok(!logs.some((line) => line.includes("PR 巡查没有在运行")));
});
