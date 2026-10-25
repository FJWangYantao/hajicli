import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectPathScope,
  isReadOnlyShellCommand,
  matchPathRule,
  PermissionEngine,
  SnapshotEngine,
} from "@hajicli/core";
import { expandFileMentions } from "../dist/file-mentions.js";
import { parseAddDirArgs } from "../dist/headless.js";
import {
  isToolAllowedPersistently,
  loadAllPermissionRules,
  loadUserPathRules,
  removeUserPathRule,
  savePermissionRule,
  saveUserPathRule,
  userPermissionRulesPath,
} from "../dist/permission-rules.js";
import {
  addWorkspaceRoot,
  loadWorkspaceRoots,
  normalizeWorkspaceRoot,
  removeWorkspaceRoot,
  workspaceRootsFilePath,
} from "../dist/workspace-roots.js";

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 覆盖 HOME/USERPROFILE，让权限规则与工作区根配置落到临时目录。 */
function withIsolatedHome(run) {
  const root = makeDir("haji-ws-home-");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return run({ root, home });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("path glob rules match directories, recursive patterns and home expansion", () => {
  const home = os.homedir().replace(/\\/g, "/");
  assert.equal(matchPathRule("~/scratch/**", path.join(os.homedir(), "scratch", "a.ts")), true);
  assert.equal(matchPathRule("~/scratch/**", path.join(os.homedir(), "scratch")), false);
  assert.equal(matchPathRule("~/scratch", path.join(os.homedir(), "scratch", "a.ts")), true);
  assert.equal(matchPathRule("**/secrets/**", `${home}/a/b/secrets/key.txt`), true);
  assert.equal(matchPathRule("**/*.env", `${home}/proj/.env`), true);
  assert.equal(matchPathRule("**/*.env", `${home}/proj/.env.local`), false);
  assert.equal(matchPathRule(`${home}/scratch/**`, `${home}/other/a.ts`), false);
});

test("inspectPathScope separates inside roots, outside targets and rule hits", () => {
  const workspace = makeDir("haji-scope-ws-");
  const extra = makeDir("haji-scope-extra-");
  const outsideDir = makeDir("haji-scope-out-");
  const outsideFile = path.join(outsideDir, "note.txt");
  try {
    fs.writeFileSync(path.join(workspace, "inside.txt"), "hi");
    fs.writeFileSync(path.join(extra, "extra.txt"), "hi");

    const inside = inspectPathScope("write", { path: "inside.txt" }, { cwd: workspace });
    assert.equal(inside.status, "inside");
    assert.equal(inside.access, "write");

    const inExtra = inspectPathScope(
      "read",
      { path: path.join(extra, "extra.txt") },
      {
        cwd: workspace,
        roots: [extra],
      },
    );
    assert.equal(inExtra.status, "inside");

    const outside = inspectPathScope("write", { path: outsideFile }, { cwd: workspace });
    assert.equal(outside.status, "outside");
    assert.match(outside.grant.key, /^write:/);
    assert.match(outside.grant.scope, /写入 .+ 下的文件/);

    const denied = inspectPathScope(
      "read",
      { path: outsideFile },
      {
        cwd: workspace,
        rules: { deny: [`${outsideDir.replace(/\\/g, "/")}/**`] },
      },
    );
    assert.equal(denied.status, "deny");
    assert.ok(denied.rule);

    const allowed = inspectPathScope(
      "read",
      { path: outsideFile },
      {
        cwd: workspace,
        rules: { allow: [`${outsideDir.replace(/\\/g, "/")}/**`] },
      },
    );
    assert.equal(allowed.status, "allowed");

    // 非文件工具不参与路径判定
    const bash = inspectPathScope("bash", { command: "ls" }, { cwd: workspace });
    assert.equal(bash.applies, false);
    assert.equal(bash.status, "inside");
  } finally {
    for (const dir of [workspace, extra, outsideDir])
      fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("permission engine asks for outside paths instead of hard-rejecting them", async () => {
  const workspace = makeDir("haji-engine-ws-");
  const outsideDir = makeDir("haji-engine-out-");
  const outsideFile = path.join(outsideDir, "external.txt");
  const engine = new PermissionEngine();
  try {
    fs.writeFileSync(path.join(workspace, "inside.txt"), "hi");
    fs.writeFileSync(outsideFile, "secret");
    engine.configurePathScope({ cwd: workspace });

    for (const mode of ["default", "accept-edit", "auto"]) {
      const result = await engine.evaluate({
        mode,
        toolName: "write",
        args: { path: outsideFile, content: "changed" },
      });
      assert.equal(result.action, "prompt", mode);
      assert.match(result.grant.key, /^write:/);
      assert.match(result.reason, /工作区外/);
    }

    const readOutside = await engine.evaluate({
      mode: "default",
      toolName: "read",
      args: { path: outsideFile },
    });
    assert.equal(readOutside.action, "prompt");
    assert.match(readOutside.grant.key, /^read:/);

    assert.equal(
      (
        await engine.evaluate({
          mode: "bypass-permissions",
          toolName: "write",
          args: { path: outsideFile, content: "x" },
        })
      ).action,
      "allow",
    );

    const previous = process.env.HAJI_ALLOW_OUTSIDE_WORKSPACE;
    process.env.HAJI_ALLOW_OUTSIDE_WORKSPACE = "1";
    try {
      assert.equal(
        (
          await engine.evaluate({
            mode: "default",
            toolName: "write",
            args: { path: outsideFile, content: "x" },
          })
        ).action,
        "allow",
      );
    } finally {
      if (previous === undefined) delete process.env.HAJI_ALLOW_OUTSIDE_WORKSPACE;
      else process.env.HAJI_ALLOW_OUTSIDE_WORKSPACE = previous;
    }

    // 路径规则：deny 优先，allow 让越界路径按工作区内处理
    engine.configurePathScope({
      cwd: workspace,
      rules: { deny: [`${outsideDir.replace(/\\/g, "/")}/**`] },
    });
    assert.equal(
      (await engine.evaluate({ mode: "default", toolName: "read", args: { path: outsideFile } }))
        .action,
      "deny",
    );
    engine.configurePathScope({
      cwd: workspace,
      rules: { allow: [`${outsideDir.replace(/\\/g, "/")}/**`] },
    });
    assert.equal(
      (await engine.evaluate({ mode: "default", toolName: "read", args: { path: outsideFile } }))
        .action,
      "allow",
    );

    // 工作区内行为保持原样：accept-edit 自动放行编辑，default 仍需审批
    engine.configurePathScope({ cwd: workspace });
    const insideArgs = { path: "inside.txt", content: "next" };
    assert.equal(
      (await engine.evaluate({ mode: "accept-edit", toolName: "write", args: insideArgs })).action,
      "allow",
    );
    assert.equal(
      (await engine.evaluate({ mode: "default", toolName: "write", args: insideArgs })).action,
      "prompt",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("workspace roots persist per project under the user config", () => {
  withIsolatedHome(({ root, home }) => {
    const projectA = path.join(root, "a");
    const projectB = path.join(root, "b");
    const shared = path.join(root, "shared");
    for (const dir of [projectA, projectB, shared]) fs.mkdirSync(dir, { recursive: true });

    assert.equal(workspaceRootsFilePath(), path.join(home, ".haji", "workspaces.json"));
    assert.deepEqual(loadWorkspaceRoots(projectA), []);

    const added = addWorkspaceRoot("../shared", projectA);
    assert.equal(added.ok, true);
    assert.deepEqual(loadWorkspaceRoots(projectA), [fs.realpathSync(shared)]);
    // 另一个项目不受影响：根按项目分组，不写进项目文件
    assert.deepEqual(loadWorkspaceRoots(projectB), []);
    assert.equal(fs.existsSync(path.join(projectA, ".haji")), false);

    assert.equal(normalizeWorkspaceRoot("missing-dir", projectA).ok, false);
    const removed = removeWorkspaceRoot(shared, projectA);
    assert.equal(removed.ok, true);
    assert.deepEqual(loadWorkspaceRoots(projectA), []);
  });
});

test("workdir path rules live in the user scope and ignore project-level paths", () => {
  withIsolatedHome(({ root }) => {
    const project = path.join(root, "proj");
    fs.mkdirSync(path.join(project, ".haji"), { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      assert.deepEqual(loadUserPathRules(), { allow: [], deny: [] });
      assert.equal(saveUserPathRule("allow", "~/scratch/**"), true);
      assert.equal(saveUserPathRule("deny", "**/.ssh/**"), true);
      assert.deepEqual(loadUserPathRules(), {
        allow: ["~/scratch/**"],
        deny: ["**/.ssh/**"],
      });
      assert.equal(saveUserPathRule("allow", "~/scratch/**"), true);
      assert.equal(loadUserPathRules().allow.length, 1);

      // 项目级文件里的 paths 段不生效（防止克隆仓库自带扩权）
      fs.writeFileSync(
        path.join(project, ".haji", "permissions.json"),
        JSON.stringify({ version: 1, allow: [], paths: { allow: ["C:/"] } }),
      );
      assert.deepEqual(loadUserPathRules(), { allow: ["~/scratch/**"], deny: ["**/.ssh/**"] });

      assert.equal(removeUserPathRule("allow", "~/scratch/**"), true);
      assert.deepEqual(loadUserPathRules().allow, []);
      assert.equal(fs.existsSync(userPermissionRulesPath()), true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("snapshots and rewind cover authorized writes outside the workspace", () => {
  const workspace = makeDir("haji-snap-ws-");
  const outsideDir = makeDir("haji-snap-out-");
  const outsideFile = path.join(outsideDir, "external.txt");
  try {
    const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
    git("init");
    git("config", "user.name", "Haji Test");
    git("config", "user.email", "haji@example.test");
    fs.writeFileSync(path.join(workspace, ".gitignore"), ".haji/\n");
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "committed\n");
    git("add", ".gitignore", "tracked.txt");
    git("commit", "-m", "initial");

    fs.writeFileSync(outsideFile, "before\n");
    const engine = new SnapshotEngine(workspace);
    engine.setScope("session-outside");
    const anchor = engine.createAnchor("before outside write");
    assert.ok(anchor);

    const checkpoint = engine.beginMutation(anchor, [outsideFile]);
    assert.ok(checkpoint);
    fs.writeFileSync(outsideFile, "after\n");
    assert.ok(engine.completeMutation(checkpoint));

    // /diff 口径：外部文件显示为绝对路径，内容可读
    const changes = engine.listOwnedChanges(0);
    const entry = changes.find((item) => item.path === outsideFile);
    assert.ok(entry, JSON.stringify(changes));
    assert.equal(entry.kind, "modified");
    assert.equal(entry.beforeContent, "before\n");

    const rollback = engine.rollbackOwnedChanges(anchor);
    assert.equal(rollback.ok, true);
    assert.deepEqual(rollback.revertedPaths, [outsideFile]);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "before\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("read-only shell classification honors added roots for absolute paths", () => {
  const workspace = makeDir("haji-ro-ws-");
  const extra = makeDir("haji-ro-extra-");
  try {
    const extraFile = path.join(extra, "a.txt");
    fs.writeFileSync(extraFile, "hi");
    // 未追加的根：绝对路径仍需审批
    assert.equal(isReadOnlyShellCommand(`cat ${extraFile}`, workspace), false);
    // 追加后：位于根内的只读内容命令无需审批；目录列举仍按原规则
    assert.equal(isReadOnlyShellCommand(`cat ${extraFile}`, workspace, [extra]), true);
    assert.equal(isReadOnlyShellCommand(`ls ${extra}`, workspace, [extra]), false);
    // 工作区内绝对路径同样放行
    const insideFile = path.join(workspace, "inside.txt");
    fs.writeFileSync(insideFile, "hi");
    assert.equal(isReadOnlyShellCommand(`cat ${insideFile}`, workspace), true);
    // 根外绝对路径永远不自动放行
    assert.equal(isReadOnlyShellCommand("cat /etc/passwd", workspace, [extra]), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  }
});

test("--add-dir accepts repeated and inline values", () => {
  assert.deepEqual(parseAddDirArgs(["--add-dir", "../a", "--add-dir=../b"]).roots, [
    "../a",
    "../b",
  ]);
  assert.match(parseAddDirArgs(["--add-dir"]).error, /需要一个目录参数/);
});

test("@ mentions can attach files from added workspace roots", () => {
  const workspace = makeDir("haji-mention-ws-");
  const extra = makeDir("haji-mention-extra-");
  const file = path.join(extra, "notes.md");
  try {
    fs.writeFileSync(file, "outside notes\n");
    const denied = expandFileMentions(`看下 @${file}`, workspace);
    assert.equal(denied.attached.length, 0);
    assert.match(denied.skipped.join("\n"), /超出工作区/);

    const allowed = expandFileMentions(`看下 @${file}`, workspace, [extra]);
    assert.deepEqual(allowed.attached, [file]);
    assert.match(allowed.prompt, /outside notes/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  }
});

test("a persisted path grant scopes the session/persistent allowance to that directory", () => {
  withIsolatedHome(({ root }) => {
    const workspace = path.join(root, "ws");
    const outsideDir = path.join(root, "out");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "a.txt");
    fs.writeFileSync(outsideFile, "x");

    const scope = inspectPathScope("write", { path: outsideFile }, { cwd: workspace });
    assert.equal(scope.status, "outside");
    assert.ok(scope.grant);
    assert.equal(
      savePermissionRule({ ...scope.grant, createdAt: new Date().toISOString() }, "user"),
      true,
    );

    const hit = isToolAllowedPersistently(
      "write",
      { path: outsideFile },
      loadAllPermissionRules(),
      scope.grant,
    );
    assert.equal(hit?.scope, "user");

    // 同一目录下的另一个文件共享授权键；换目录不命中。
    const sibling = inspectPathScope(
      "write",
      { path: path.join(outsideDir, "b.txt") },
      {
        cwd: workspace,
      },
    );
    assert.equal(sibling.grant.key, scope.grant.key);
  });
});
