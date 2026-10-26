import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HookEngine, PermissionEngine, SnapshotEngine, TaskStore } from "@hajicli/core";
import {
  BashTool,
  classifyBashMutationScope,
  EditFileTool,
  GlobalFindFilesTool,
  GrepSearchTool,
  ReadFileTool,
  WriteFileTool,
} from "@hajicli/plugins";
import { runRipgrep } from "../../plugins/dist/ripgrep.js";
import { SharedToolExecutor } from "../dist/tool-executor.js";

const definition = (name) => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});

test("file and search tools honor an already-aborted execution context", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-tool-abort-"));
  const previousCwd = process.cwd();
  const target = path.join(cwd, "target.txt");
  fs.writeFileSync(target, "before\n");
  process.chdir(cwd);

  try {
    const controller = new AbortController();
    controller.abort();
    const context = { abortSignal: controller.signal };

    assert.equal(
      await new ReadFileTool().execute({ path: "target.txt" }, context),
      "[文件读取已中止]",
    );
    assert.equal(
      await new WriteFileTool().execute({ path: "target.txt", content: "after\n" }, context),
      "[文件写入已中止]",
    );
    assert.equal(
      await new EditFileTool().execute(
        { path: "target.txt", oldText: "before", newText: "after" },
        context,
      ),
      "[文件编辑已中止]",
    );
    assert.equal(await new GlobalFindFilesTool().execute({}, context), "[文件查找已中止]");
    assert.equal(
      await new GrepSearchTool().execute({ query: "before" }, context),
      "[Grep 搜索已中止]",
    );
    assert.equal(fs.readFileSync(target, "utf8"), "before\n");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("ripgrep helper terminates an active child when aborted", async () => {
  const controller = new AbortController();
  const promise = runRipgrep(
    ["-e", "setTimeout(() => {}, 10000)"],
    process.cwd(),
    controller.signal,
    process.execPath,
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise, (error) => error instanceof Error && error.name === "AbortError");
});

test("shared executor does not start a tool if abort fires during pre-hook", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-executor-abort-"));
  let releaseHook;
  let executed = false;
  const hookEngine = new HookEngine();
  hookEngine.register(
    "PreToolUse",
    () =>
      new Promise((resolve) => {
        releaseHook = resolve;
      }),
  );
  const tool = {
    name: "read",
    definition: definition("read"),
    async execute() {
      executed = true;
      return "unexpected";
    },
  };
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([["read", tool]]),
    hookEngine,
    permissionEngine: new PermissionEngine(),
    snapshotEngine: new SnapshotEngine(cwd),
    taskStore: new TaskStore(path.join(cwd, ".haji", "tasks")),
  });
  const controller = new AbortController();

  try {
    const pending = executor.execute("read", {}, { abortSignal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    releaseHook();
    const result = await pending;
    assert.equal(result.output, "[工具执行已中止]");
    assert.equal(result.blocked, true);
    assert.equal(executed, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("shared executor stops reporting once aborted even if the tool finishes later", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-executor-late-abort-"));
  let releaseTool;
  let postHookCalls = 0;
  let executedCalls = 0;
  const hookEngine = new HookEngine();
  hookEngine.register("PostToolUse", () => {
    postHookCalls += 1;
  });
  const tool = {
    name: "read",
    definition: definition("read"),
    async execute() {
      await new Promise((resolve) => {
        releaseTool = resolve;
      });
      return "late result";
    },
  };
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([["read", tool]]),
    hookEngine,
    permissionEngine: new PermissionEngine(),
    snapshotEngine: new SnapshotEngine(cwd),
    taskStore: new TaskStore(path.join(cwd, ".haji", "tasks")),
    onToolExecuted: () => {
      executedCalls += 1;
    },
  });
  const controller = new AbortController();

  try {
    const pending = executor.execute("read", {}, { abortSignal: controller.signal });
    for (let tick = 0; tick < 100 && !releaseTool; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    releaseTool();
    const result = await pending;
    // 工具确实跑完了，但中止后的回合不应再收到 PostToolUse 或执行证据。
    assert.equal(result.output, "late result");
    assert.equal(result.blocked, false);
    assert.equal(postHookCalls, 0);
    assert.equal(executedCalls, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("shared executor appends mutation warnings instead of silently discarding them", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-mutation-warning-"));
  const tool = {
    name: "edit",
    definition: definition("edit"),
    async execute() {
      return "[文件精准编辑成功]";
    },
  };
  const snapshotEngine = {
    beginMutation() {
      return { anchorSnapshotId: "anchor-1", beforeSnapshotId: "before-1", paths: ["target.txt"] };
    },
    completeMutation() {
      return {
        recordId: "mutation-1",
        headChanged: true,
        warning:
          "[快照警告] 工具执行期间 Git HEAD 发生变化；本次 mutation 已记录并标记为不可自动回退。",
      };
    },
  };
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([["edit", tool]]),
    hookEngine: new HookEngine(),
    permissionEngine: new PermissionEngine(),
    snapshotEngine,
    taskStore: new TaskStore(path.join(cwd, ".haji", "tasks")),
  });

  try {
    const result = await executor.execute(
      "edit",
      { path: "target.txt" },
      {
        anchorSnapshotId: "anchor-1",
        permissionMode: "bypass-permissions",
      },
    );
    assert.match(result.output, /HEAD.*mutation.*不可自动回退/);
    assert.equal(result.blocked, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("successful parent tools expose their verification evidence ID", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-evidence-id-"));
  const tool = {
    name: "read",
    definition: definition("read"),
    async execute() {
      return "file contents";
    },
  };
  const recorded = [];
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([["read", tool]]),
    hookEngine: new HookEngine(),
    permissionEngine: new PermissionEngine(),
    snapshotEngine: new SnapshotEngine(cwd),
    taskStore: new TaskStore(path.join(cwd, ".haji", "tasks")),
    onToolExecuted: (event) => recorded.push(event),
  });

  try {
    const result = await executor.execute("read", {}, { toolCallId: "call-parent-read-1" });
    assert.equal(result.blocked, false);
    assert.match(result.output, /\[verification_evidence_id: call-parent-read-1\]$/);
    assert.equal(recorded[0].output, result.output);

    const childResult = await executor.execute(
      "read",
      {},
      {
        agentId: "sub-child",
        toolCallId: "call-child-read-1",
      },
    );
    assert.doesNotMatch(childResult.output, /verification_evidence_id/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash aborts instantly and still cleans up the process tree in the background", async () => {
  const controller = new AbortController();
  const killSignals = [];
  const child = {
    pid: 4242,
    exitCode: null,
    kill(signal) {
      killSignals.push(signal);
      return true;
    },
  };
  const commandExecutor = () => child;
  const cleanupCalls = [];
  const killedPids = [];
  const pendingPowerShellCallbacks = [];
  const fileExecutor = (file, _args, _options, callback) => {
    cleanupCalls.push(file);
    if (file === "taskkill.exe") {
      queueMicrotask(() => {
        const error = Object.assign(new Error("access denied"), { code: 5 });
        callback(error, "", "");
      });
      return {};
    }
    // 挂起兜底链的回调，由测试主动放行，验证 resolve 不依赖它。
    pendingPowerShellCallbacks.push(callback);
    return {};
  };
  // 进程树清理只在 win32 走 taskkill + PowerShell 兜底链：显式指定平台，
  // 这样在 POSIX 上跑测试也能覆盖这段逻辑。
  const tool = new BashTool(
    commandExecutor,
    fileExecutor,
    (pid, signal) => {
      killedPids.push([pid, signal]);
      return true;
    },
    undefined,
    "win32",
  );

  const pending = tool.execute(
    { command: "long-running-command" },
    { abortSignal: controller.signal },
  );
  controller.abort();
  const output = await pending;

  // 中止标记立即返回，此时 PowerShell 兜底链还未放行、不可能已完成。
  assert.equal(output, "[命令已中止]");
  assert.equal(pendingPowerShellCallbacks.length, 1);
  assert.deepEqual(killedPids, []);

  for (const callback of pendingPowerShellCallbacks.splice(0)) {
    callback(null, "5002,5001\n", "");
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cleanupCalls, ["taskkill.exe", "powershell.exe"]);
  assert.deepEqual(killedPids, [
    [5002, "SIGTERM"],
    [5001, "SIGTERM"],
  ]);
  assert.deepEqual(killSignals, ["SIGTERM"]);
});

test("bash mutation scope only skips snapshots for strict read-only commands", () => {
  assert.equal(classifyBashMutationScope("git status --short"), "none");
  assert.equal(classifyBashMutationScope('rg -n "needle" packages'), "none");
  assert.equal(classifyBashMutationScope("Get-Content package.json"), "none");
  assert.equal(classifyBashMutationScope("git diff --output report.patch"), "workspace");
  assert.equal(classifyBashMutationScope("rg needle . | Set-Content matches.txt"), "workspace");
  assert.equal(classifyBashMutationScope("npm run build"), "workspace");
});

test("shared executor skips mutation snapshots for tools declaring none scope", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-readonly-scope-"));
  let beginCount = 0;
  const tool = {
    name: "bash",
    definition: definition("bash"),
    getMutationScope() {
      return "none";
    },
    async execute() {
      return "clean";
    },
  };
  const snapshotEngine = {
    beginMutation() {
      beginCount += 1;
      return null;
    },
    completeMutation() {
      throw new Error("unexpected completion");
    },
  };
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([["bash", tool]]),
    hookEngine: new HookEngine(),
    permissionEngine: new PermissionEngine(),
    snapshotEngine,
    taskStore: new TaskStore(path.join(cwd, ".haji", "tasks")),
  });

  try {
    const result = await executor.execute(
      "bash",
      { command: "git status" },
      {
        anchorSnapshotId: "anchor-1",
        permissionMode: "bypass-permissions",
      },
    );
    assert.equal(result.blocked, false);
    assert.equal(beginCount, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("shared executor forwards tool progress without changing final output", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-tool-progress-"));
  const progressEvents = [];
  const tool = {
    name: "progress",
    definition: definition("progress"),
    getMutationScope() {
      return "none";
    },
    async execute(_args, context) {
      context.onProgress?.({ type: "stdout", chunk: "building 1/2" });
      return "done";
    },
  };
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([["progress", tool]]),
    hookEngine: new HookEngine(),
    permissionEngine: new PermissionEngine(),
    snapshotEngine: new SnapshotEngine(cwd),
    taskStore: new TaskStore(path.join(cwd, ".haji", "tasks")),
    onToolProgress: (event) => progressEvents.push(event),
  });

  try {
    const result = await executor.execute("progress", {}, {});
    assert.equal(result.output, "done");
    assert.equal(progressEvents.length, 1);
    assert.equal(progressEvents[0].progress.chunk, "building 1/2");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("tool duration excludes the permission wait and start fires only after approval", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-tool-duration-"));
  const events = [];
  const hookEngine = new HookEngine();
  hookEngine.register("PreToolUse", async (ctx) => {
    events.push("permission");
    // 模拟用户在授权卡片前停留了一段时间。
    await new Promise((resolve) => setTimeout(resolve, 120));
    return ctx.args?.deny ? "错误: 用户拒绝了此命令的执行请求。" : null;
  });
  const tool = {
    name: "quick",
    definition: definition("quick"),
    getMutationScope() {
      return "none";
    },
    async execute() {
      events.push("execute");
      return "done";
    },
  };
  const executor = new SharedToolExecutor({
    cwd,
    tools: new Map([["quick", tool]]),
    hookEngine,
    permissionEngine: new PermissionEngine(),
    snapshotEngine: new SnapshotEngine(cwd),
    taskStore: new TaskStore(path.join(cwd, ".haji", "tasks")),
    onToolStart: ({ toolName }) => events.push(`start:${toolName}`),
  });

  try {
    const approved = await executor.execute("quick", {}, {});
    assert.deepEqual(events, ["permission", "start:quick", "execute"]);
    assert.ok(approved.duration < 100, `duration ${approved.duration}ms includes the wait`);
    assert.equal(approved.rejected, undefined);

    events.length = 0;
    const denied = await executor.execute("quick", { deny: true }, {});
    assert.deepEqual(events, ["permission"]);
    assert.equal(denied.rejected, true);
    assert.equal(denied.blocked, true);
    assert.equal(denied.duration, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
