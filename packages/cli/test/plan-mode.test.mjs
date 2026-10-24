import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isReadOnlyShellCommand,
  PERMISSION_MODES,
  PermissionEngine,
  SystemPromptManager,
  TaskStore,
} from "@hajicli/core";
import {
  ALL_TASKS_COMPLETE_MARKER,
  PLAN_READY_MARKER,
  TaskCreateTool,
  TaskFinishTool,
  UpdateTaskTool,
} from "@hajicli/plugins";

test("Plan Mode exposes planning tools but blocks implementation tools", async () => {
  assert.ok(PERMISSION_MODES.some((mode) => mode.value === "plan"));
  const engine = new PermissionEngine();
  const base = { mode: "plan", args: {}, userIntent: "inspect and plan" };
  for (const toolName of [
    "read",
    "grep",
    "taskcreate",
    "tasklist",
    "updatetask",
    "subagent",
    "verifyagent",
  ]) {
    assert.equal((await engine.evaluate({ ...base, toolName })).action, "allow");
  }
  for (const toolName of ["write", "edit", "bash", "taskfinish"]) {
    assert.equal((await engine.evaluate({ ...base, toolName })).action, "deny");
  }
});

test("Plan prompt describes incremental task creation and approval boundary", async () => {
  const manager = new SystemPromptManager();
  const context = {
    cwd: "C:/repo",
    os: "Windows",
    tools: ["read", "taskcreate", "tasklist", "updatetask"],
    reasoningEffort: "medium",
  };
  const prompt = await manager.generatePrompt({ ...context, permissionMode: "plan" });
  assert.match(prompt, /当前权限模式：Plan/);
  assert.match(prompt, /一条一条创建任务/);
  assert.match(prompt, /finalize=true/);
  assert.match(prompt, /优先 4-8 个汉字/);
  assert.match(prompt, /最多 12 个字符/);
  assert.match(prompt, /单独输出一次面向用户审阅的方案正文/);
  assert.match(prompt, /此轮不得调用工具/);
  assert.match(prompt, /创建任务前必须先调用 tasklist/);
});

test("taskfinish prompt keeps orchestration guidance without repeating its schema", async () => {
  const manager = new SystemPromptManager();
  const prompt = await manager.generatePrompt({
    cwd: "C:/repo",
    os: "Windows",
    tools: ["updatetask", "taskfinish"],
    reasoningEffort: "medium",
    permissionMode: "default",
  });

  assert.match(prompt, /taskfinish：提交该任务的实际验证结果/);
  assert.doesNotMatch(prompt, /taskfinish：.*updatetask\(in_progress\).*taskfinish/);
});

test("plan titles are kept concise", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-plan-title-"));
  try {
    const store = new TaskStore(cwd);
    store.setTaskScope("session-a");
    const create = new TaskCreateTool(store);
    const output = await create.execute({
      title: "hajicli 代码重构实施计划",
      id: "inspect",
      content: "inspect flow",
    });
    assert.match(output, /^错误: 计划标题最多 12 个字符/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("task workflow enforces dependencies, verification and removal from active list", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-plan-"));
  try {
    const store = new TaskStore(cwd);
    store.setTaskScope("session-a");
    const create = new TaskCreateTool(store);
    const update = new UpdateTaskTool(store);
    const finish = new TaskFinishTool(store);
    await create.execute({ title: "Plan mode", id: "inspect", content: "inspect flow" });
    const ready = await create.execute({
      id: "implement",
      content: "implement flow",
      blockedBy: ["inspect"],
      finalize: true,
    });
    assert.match(ready, new RegExp(PLAN_READY_MARKER.replace(/[[\]]/g, "\\$&")));
    assert.match(
      await finish.execute({ taskId: "inspect", verification: "tests passed" }),
      /updatetask.*in_progress/,
    );
    assert.match(
      finish.definition.function.description,
      /updatetask\(in_progress\).*实施.*验证.*taskfinish/,
    );
    assert.match(await update.execute({ taskId: "implement", status: "in_progress" }), /^错误:/);
    await update.execute({ taskId: "inspect", status: "in_progress" });
    await finish.execute({ taskId: "inspect", verification: "tests passed" });
    assert.equal(
      store.getPlan().tasks.some((task) => task.id === "inspect"),
      false,
    );
    await update.execute({ taskId: "implement", status: "in_progress" });
    const completed = await finish.execute({ taskId: "implement", verification: "build passed" });
    assert.match(completed, new RegExp(ALL_TASKS_COMPLETE_MARKER.replace(/[[\]]/g, "\\$&")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("TaskStore keeps plans isolated by session scope", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-plan-scope-"));
  try {
    const store = new TaskStore(cwd);
    store.setTaskScope("session-a");
    store.createTask({ title: "计划A", id: "task-a", content: "first session" });
    store.setTaskScope("session-b");
    assert.equal(store.getPlan(), null);
    store.createTask({ title: "计划B", id: "task-b", content: "second session" });
    store.setTaskScope("session-a");
    assert.deepEqual(
      store.getPlan().tasks.map((task) => task.id),
      ["task-a"],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("approval offers exactly three Chinese choices and defaults to auto", () => {
  // Plan 审批流已抽到 turn-runner.ts，源码断言跟随迁移。
  const source = fs.readFileSync(new URL("../src/turn-runner.ts", import.meta.url), "utf8");
  assert.match(source, /\[系统计划审阅要求\].*停止调用工具.*方案正文/);
  assert.match(
    source,
    /getPermissionMode\(\) === "plan" && deps\.isPlanReadyForReview\(\)[\s\S]*!textContent\.trim\(\)[\s\S]*本次不进入审批/,
  );
  assert.match(source, /value: "auto",\s*label: "批准并自动执行"/);
  assert.match(source, /value: "manual",\s*label: "批准，逐步审批"/);
  assert.match(source, /value: "no",\s*label: "修改计划…"/);
  assert.match(source, /selectedValue: "auto"/);
  assert.match(source, /review\.value === "auto" \? "auto" : "default"/);
  assert.match(source, /每个任务都严格按 updatetask\(in_progress\).*实际验证.*taskfinish/);
  // “修改计划…”分支：输入的意见作为下一条用户消息排队提交。
  assert.match(source, /修改意见 › /);
  assert.match(source, /pendingInputs\.push\(trimmedFeedback\)/);
});

test("Plan Mode sends only read-only, planning and isolated subagent tool definitions", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /permissionMode === "plan"/);
  assert.match(source, /\["subagent", "verifyagent"\]\.includes\(tool\.name\)/);
  assert.match(source, /\["taskcreate", "tasklist", "updatetask"\]/);
  assert.doesNotMatch(source, /\["taskcreate", "tasklist", "updatetask", "taskfinish"\]/);
});

test("the large HAJI logo remains until the first ordinary user message", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const terminalSource = fs.readFileSync(
    new URL("../src/terminal-input.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /console\.log\(buildLogo\(\)\)/);
  // 无头模式下 compactHeader 置空（stdout 只留正文），交互模式仍是单行 HAJI。
  assert.match(
    source,
    /header: buildLogo\(\)\.trim\(\),\s*\/\/ 无头模式下[^\n]*\n\s*compactHeader: headlessRequest \? "" : colors\.boldPurple\("HAJI"\)/,
  );
  assert.match(
    source,
    /if \(!trimmedInput\.startsWith\("\/"\)\) \{\s*ui\.dismissStartupHeader\(\)/,
  );
  assert.match(terminalSource, /dismissStartupHeader\(\): void/);
  assert.doesNotMatch(terminalSource, /startupHeaderDurationMs/);
  // 完整页眉包含 Logo + headerInfo；紧凑模式只保留单行会话标题。
  assert.match(
    terminalSource,
    /const headerInfo =[\s\S]*?this\.startupHeaderVisible && layout\.headerMode === "full" \? this\.headerInfo : \[\]/,
  );
  assert.match(terminalSource, /\.\.\.wrapAnsi\(header, width\),\s*\.\.\.\(headerInfo\.length/);
});

test("strict read-only shell commands skip approval outside Plan Mode", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "haji-ro-"));
  try {
    fs.writeFileSync(path.join(workspace, "a.txt"), "hi");
    for (const command of [
      "ls -la",
      "git status",
      "git log --oneline -5",
      "git branch",
      "cat a.txt",
      "rg foo src",
      "Get-ChildItem",
    ]) {
      assert.ok(isReadOnlyShellCommand(command, workspace), command);
    }
    for (const command of [
      "npm test",
      "ls; rm -rf .",
      "cat a.txt > b.txt",
      "cat $HOME/x",
      "cat ~/.ssh/id_rsa",
      "cat /etc/passwd",
      "cat ../secret",
      "cat *.txt",
      "git branch -D main",
      "git diff --output=x",
      "git -c core.pager=sh log",
      "rg --pre sh foo",
      "tail -f log.txt",
      "type C:\\secret",
    ]) {
      assert.ok(!isReadOnlyShellCommand(command, workspace), command);
    }
    // 指向工作区外的符号链接不能被 cat 自动读取。
    try {
      fs.symlinkSync(os.homedir(), path.join(workspace, "home-link"));
      assert.ok(!isReadOnlyShellCommand("cat home-link/.bashrc", workspace));
      assert.ok(isReadOnlyShellCommand("ls home-link", workspace));
    } catch (error) {
      if (error.code !== "EPERM") throw error;
    }

    const engine = new PermissionEngine();
    const evaluate = (mode, command) =>
      engine.evaluate({ mode, toolName: "bash", args: { command }, userIntent: "" });
    assert.equal((await evaluate("default", "git status")).action, "allow");
    assert.equal((await evaluate("accept-edit", "ls")).action, "allow");
    assert.equal((await evaluate("default", "npm test")).action, "prompt");
    // Plan 模式仍按原规则禁止 bash。
    assert.equal((await evaluate("plan", "ls")).action, "deny");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
