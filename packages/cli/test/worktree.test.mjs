import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizePathKey } from "@hajicli/core";
import {
  archivedSessionStoreDirs,
  detectGitRepo,
  listHajiWorktrees,
  loadWorktreeSetting,
  parseWorktreeArgs,
  prepareSessionWorktree,
  removeWorktree,
  resolveWorktreePath,
  saveWorktreeEnabled,
  siblingSessionStoreDirs,
  WORKTREE_BRANCH_PREFIX,
  worktreeTargetCwd,
} from "../dist/worktree.js";
import { handleWorktreeCommand } from "../dist/worktree-commands.js";

function makeDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * 目录身份断言：同一目录在 Windows 上可能有不同大小写——TEMP 环境变量常是
 * `C:\WINDOWS\TEMP`，而 git / 文件系统回读的是真实大小写 `C:\Windows\Temp`。
 * 复用产品里的 normalizePathKey，按「是否同一个目录」比较而不是字符串字面量。
 */
function assertSamePath(actual, expected, message) {
  assert.equal(typeof actual, "string", `实际路径缺失${message ? `：${message}` : ""}`);
  assert.equal(normalizePathKey(actual), normalizePathKey(expected), message);
}

/** 把多行文本里的路径压成与 normalizePathKey 同口径（正斜杠 + Windows 小写）。 */
function normalizePathText(value) {
  const text = value.replace(/\\/g, "/");
  return process.platform === "win32" ? text.toLowerCase() : text;
}

/** 覆盖 HOME/USERPROFILE，让 ~/.haji 落到临时目录。 */
function withIsolatedHome(run) {
  const home = makeDir("haji-wt-home-");
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

/** 一个带提交的真实仓库：含 .haji/preferences.json 与未跟踪 .env，用于验证拷贝。 */
function makeRepo() {
  const dir = makeDir("haji-wt-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".haji/\n.env\n");
  fs.mkdirSync(path.join(dir, ".haji"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".haji", "preferences.json"), '{"model":"demo"}\n');
  fs.writeFileSync(path.join(dir, ".env"), "TOKEN=demo\n");
  git(dir, ["add", "README.md", ".gitignore"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

test("parseWorktreeArgs 识别 --worktree / --no-worktree，并拒绝冲突", () => {
  assert.deepEqual(parseWorktreeArgs([]), {});
  assert.deepEqual(parseWorktreeArgs(["--worktree"]), { mode: "on" });
  assert.deepEqual(parseWorktreeArgs(["--no-worktree"]), { mode: "off" });
  assert.match(parseWorktreeArgs(["--worktree", "--no-worktree"]).error, /不能同时使用/);
});

test("detectGitRepo 区分主工作树、子目录与 linked worktree", () =>
  withIsolatedHome(() => {
    const repo = makeRepo();
    const main = detectGitRepo(repo);
    assert.equal(main?.linked, false);
    assertSamePath(main?.root, repo);
    assertSamePath(main?.mainRoot, repo);

    const sub = path.join(repo, "src");
    fs.mkdirSync(sub);
    const fromSub = detectGitRepo(sub);
    assert.equal(fromSub?.linked, false);
    assertSamePath(fromSub?.root, repo);
    assertSamePath(fromSub?.mainRoot, repo);

    const prepared = prepareSessionWorktree({
      cwd: repo,
      setting: { enabled: true, copy: [] },
      name: "linked-check",
    });
    assert.equal(prepared.ok, true);
    const detected = detectGitRepo(prepared.info.path);
    assert.equal(detected?.linked, true);
    assertSamePath(detected?.mainRoot, repo);
  }));

test("配置默认关闭；saveWorktreeEnabled 写主仓库项目级配置并可回读", () =>
  withIsolatedHome((home) => {
    const repo = makeRepo();
    assert.equal(loadWorktreeSetting(repo).enabled, false);

    const saved = saveWorktreeEnabled(repo, true);
    assert.equal(saved.ok, true);
    assert.equal(saved.path, path.join(repo, ".haji", "config.json"));
    assert.equal(loadWorktreeSetting(repo).enabled, true);

    // 用户级配置也可启用（项目级缺省时回落到用户级）。
    const other = makeRepo();
    fs.mkdirSync(path.join(home, ".haji"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".haji", "config.json"),
      JSON.stringify({ worktree: { enabled: true, root: "~/.haji/custom" } }),
    );
    const setting = loadWorktreeSetting(other);
    assert.equal(setting.enabled, true);
    assert.equal(setting.root, "~/.haji/custom");
  }));

test("prepareSessionWorktree 建工作树、开 haji 分支并带过项目配置", () =>
  withIsolatedHome(() => {
    const repo = makeRepo();
    const prepared = prepareSessionWorktree({
      cwd: repo,
      setting: { enabled: true, copy: [".env"] },
      name: "session-a",
    });
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.error);
    const { info } = prepared;
    assert.equal(info.branch, `${WORKTREE_BRANCH_PREFIX}session-a`);
    assert.ok(fs.statSync(info.path).isDirectory());
    // 分支已创建，工作树内容是当前提交。
    assert.equal(git(info.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "haji/session-a");
    assert.ok(fs.existsSync(path.join(info.path, "README.md")));
    // 项目配置与未跟踪的本地环境文件被带过去；运行数据不拷。
    assert.equal(
      fs.readFileSync(path.join(info.path, ".haji", "preferences.json"), "utf8"),
      '{"model":"demo"}\n',
    );
    assert.equal(fs.readFileSync(path.join(info.path, ".env"), "utf8"), "TOKEN=demo\n");
    assert.deepEqual(info.copied.sort(), [".env", ".haji/preferences.json"].sort());

    const listed = listHajiWorktrees(repo);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].branch, "haji/session-a");
    assertSamePath(listed[0].path, info.path);
  }));

test("已经在 linked worktree 中启动时跳过，避免嵌套", () =>
  withIsolatedHome(() => {
    const repo = makeRepo();
    const first = prepareSessionWorktree({
      cwd: repo,
      setting: { enabled: true, copy: [] },
      name: "first",
    });
    assert.equal(first.ok, true);
    const nested = prepareSessionWorktree({
      cwd: first.info.path,
      setting: { enabled: true, copy: [] },
      name: "second",
    });
    assert.equal(nested.ok, false);
    assert.equal(nested.skipped, "already-linked");
  }));

test("仓库没有提交时跳过并给出原因", () =>
  withIsolatedHome(() => {
    const repo = makeDir("haji-wt-empty-");
    git(repo, ["init", "-q"]);
    const prepared = prepareSessionWorktree({
      cwd: repo,
      setting: { enabled: true, copy: [] },
      name: "empty",
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.skipped, "unborn");
  }));

test("worktreeTargetCwd 对齐启动时的仓库子目录", () =>
  withIsolatedHome(() => {
    const repo = makeRepo();
    const sub = path.join(repo, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "index.ts"), "export {};\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "add app"]);
    const prepared = prepareSessionWorktree({
      cwd: sub,
      setting: { enabled: true, copy: [] },
      name: "subdir",
    });
    assert.equal(prepared.ok, true);
    assert.equal(
      worktreeTargetCwd(prepared.info, sub),
      path.join(prepared.info.path, "packages", "app"),
    );
  }));

test("resolveWorktreePath 支持 ~ 与 {repo}/{name} 占位", () =>
  withIsolatedHome(() => {
    const repo = makeRepo();
    const setting = { enabled: true, copy: [], root: "~/wt/{repo}/{name}" };
    const resolved = resolveWorktreePath(setting, detectGitRepo(repo), "abc");
    assert.equal(resolved, path.join(os.homedir(), "wt", path.basename(repo), "abc"));
  }));

test("removeWorktree 只清理 haji 分支，并拒绝主工作树", () =>
  withIsolatedHome(() => {
    const repo = makeRepo();
    const prepared = prepareSessionWorktree({
      cwd: repo,
      setting: { enabled: true, copy: [] },
      name: "gone",
    });
    assert.equal(prepared.ok, true);
    // 工作树里的会话记录在移除时归档，不随目录一起消失。
    fs.mkdirSync(path.join(prepared.info.path, ".haji", "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(prepared.info.path, ".haji", "sessions", "session_demo.json"),
      '{"id":"demo"}\n',
    );

    const mainAttempt = removeWorktree(repo, repo);
    assert.equal(mainAttempt.ok, false);

    const removed = removeWorktree(repo, "gone");
    assert.equal(removed.ok, true, removed.ok ? "" : removed.error);
    assert.equal(fs.existsSync(prepared.info.path), false);
    assert.equal(listHajiWorktrees(repo).length, 0);
    assert.equal(removed.branchRemoved, true);
    assert.ok(removed.archivePath);
    assert.ok(
      fs.existsSync(path.join(removed.archivePath, "sessions", "session_demo.json")),
      "会话记录应归档到主仓库 .haji/worktree-archive",
    );
    // 归档目录随即进入 /resume 的检索范围。
    const archived = archivedSessionStoreDirs(repo);
    assert.equal(archived.length, 1);
    assertSamePath(archived[0], path.join(removed.archivePath, "sessions"));
  }));

test("/worktree on|off 写主仓库配置，list 展示 haji 工作树", () =>
  withIsolatedHome(() => {
    const repo = makeRepo();
    const lines = [];
    const chats = [];
    const ctx = {
      cwd: repo,
      writeLine: (text) => lines.push(text),
      writeChat: (text) => chats.push(text),
    };

    handleWorktreeCommand(ctx, ["/worktree", "on"]);
    assert.equal(loadWorktreeSetting(repo).enabled, true);
    assert.match(lines.join("\n"), /已启用自动 worktree/);

    const prepared = prepareSessionWorktree({
      cwd: repo,
      setting: { enabled: true, copy: [] },
      name: "listed",
    });
    assert.equal(prepared.ok, true);
    chats.length = 0;
    handleWorktreeCommand(ctx, ["/worktree", "list"]);
    assert.match(chats.join("\n"), /haji\/listed/);
    assert.ok(
      normalizePathText(chats.join("\n")).includes(normalizePathKey(prepared.info.path)),
      `list 应展示工作树路径，实际输出：${chats.join("\n")}`,
    );

    lines.length = 0;
    handleWorktreeCommand(ctx, ["/worktree", "off"]);
    assert.equal(loadWorktreeSetting(repo).enabled, false);
    assert.match(lines.join("\n"), /已关闭自动 worktree/);

    // 在 worktree 内执行 on/off 也写回主仓库，不会随工作树一起消失。
    lines.length = 0;
    handleWorktreeCommand({ ...ctx, cwd: prepared.info.path }, ["/worktree", "on"]);
    assert.equal(loadWorktreeSetting(repo).enabled, true);
  }));

test("siblingSessionStoreDirs 列出其他 haji 工作树的会话目录（跨树 resume 的基础）", () =>
  withIsolatedHome(() => {
    const repo = makeRepo();
    const w1 = prepareSessionWorktree({
      cwd: repo,
      setting: { enabled: true, copy: [] },
      name: "resume-w1",
    });
    const w2 = prepareSessionWorktree({
      cwd: repo,
      setting: { enabled: true, copy: [] },
      name: "resume-w2",
    });
    assert.equal(w1.ok, true);
    assert.equal(w2.ok, true);
    // 只有 w1 里有会话目录；w2 还没开过会话。
    fs.mkdirSync(path.join(w1.info.path, ".haji", "sessions"), { recursive: true });
    const expected = [path.join(w1.info.path, ".haji", "sessions")];

    const previousCwd = process.cwd();
    try {
      // 主仓库视角与 w2 视角都只看到 w1 的会话目录；看不到自己。
      process.chdir(repo);
      assert.deepEqual(
        siblingSessionStoreDirs(repo).map(normalizePathKey),
        expected.map(normalizePathKey),
      );
      process.chdir(w2.info.path);
      assert.deepEqual(
        siblingSessionStoreDirs(w2.info.path).map(normalizePathKey),
        expected.map(normalizePathKey),
      );
    } finally {
      process.chdir(previousCwd);
    }
  }));
