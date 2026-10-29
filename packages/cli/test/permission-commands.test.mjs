import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handlePermissionCommand } from "../dist/permission-commands.js";
import { loadAllPermissionRules, savePermissionRule } from "../dist/permission-rules.js";
import { TerminalInputCancelledError } from "../dist/terminal-input.js";

/** 规则文件路径基于 HOME 与 cwd：切到临时目录，结束后恢复（不碰真实 ~/.haji）。 */
async function withIsolatedPaths(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-permcmd-"));
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const previous = { cwd: process.cwd(), home: process.env.HOME, profile: process.env.USERPROFILE };
  process.chdir(proj);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await run();
  } finally {
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.profile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.profile;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createContext(select) {
  const state = { mode: "default", risk: "medium", lines: [], removed: [], planReset: 0 };
  const ctx = {
    ui: { writeLine: (line) => state.lines.push(line) },
    readSelectionSafely: async (options) => select(options),
    getPermissionMode: () => state.mode,
    getRiskThreshold: () => state.risk,
    setRiskThreshold: (level) => {
      state.risk = level;
    },
    applyPermissionMode: async (mode) => {
      state.mode = mode;
    },
    resetPlanReview: () => {
      state.planReset += 1;
    },
    onRuleRemoved: (key) => state.removed.push(key),
  };
  return { ctx, state };
}

const noPicker = () => {
  throw new Error("不应弹出选择器");
};

test("/permission <档位> 直接切换并清掉计划审批状态", async () => {
  const { ctx, state } = createContext(noPicker);
  await handlePermissionCommand(["plan"], ctx);
  assert.equal(state.mode, "plan");
  assert.equal(state.planReset, 1);
  assert.ok(state.lines.some((line) => line.includes("Plan 模式只允许只读调研")));
});

test("/permission 非法档位只提示，不改状态", async () => {
  const { ctx, state } = createContext(noPicker);
  await handlePermissionCommand(["root"], ctx);
  assert.equal(state.mode, "default");
  assert.ok(state.lines.some((line) => line.includes("无效权限模式：root")));
});

test("/permission 无参数走选择器：同时设置档位与回退阈值；取消不改状态", async () => {
  const picked = createContext(() => ({ value: "accept-edit", secondaryValue: "high" }));
  await handlePermissionCommand([], picked.ctx);
  assert.equal(picked.state.mode, "accept-edit");
  assert.equal(picked.state.risk, "high");

  const cancelled = createContext(() => {
    throw new TerminalInputCancelledError();
  });
  await handlePermissionCommand([], cancelled.ctx);
  assert.equal(cancelled.state.mode, "default");
  assert.ok(cancelled.state.lines.some((line) => line.includes("已取消切换权限模式")));
});

test("/permission rules：选中即删除并通知调用方撤销会话授权", async () => {
  await withIsolatedPaths(async () => {
    const empty = createContext(noPicker);
    await handlePermissionCommand(["rules"], empty.ctx);
    assert.ok(empty.state.lines.some((line) => line.includes("暂无永久放行规则")));

    savePermissionRule(
      { key: "bash:npm test", scope: "npm test 开头的命令", createdAt: new Date().toISOString() },
      "user",
    );
    const { ctx, state } = createContext((options) => {
      assert.ok(options.items.some((item) => item.value === "user::bash:npm test"));
      return { value: "user::bash:npm test" };
    });
    await handlePermissionCommand(["rules"], ctx);
    assert.deepEqual(state.removed, ["bash:npm test"]);
    assert.deepEqual(loadAllPermissionRules().user, []);
  });
});
