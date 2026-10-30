import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseNumstat,
  parseWorkspaceChanges,
  parseWorkspaceFiles,
  readWorkspaceStatus,
} from "../dist/workspace-status.js";

const zero = { modified: 0, added: 0, deleted: 0, untracked: 0, conflicted: 0 };

test("numstat counts added and removed lines and skips binary rows", () => {
  assert.deepEqual(parseNumstat("26\t5\tsrc/a.ts\n1\t0\tsrc/b.ts\n"), {
    insertions: 27,
    deletions: 5,
  });
  assert.deepEqual(parseNumstat("-\t-\timage.png\n3\t1\tsrc/c.ts"), {
    insertions: 3,
    deletions: 1,
  });
  assert.deepEqual(parseNumstat(""), { insertions: 0, deletions: 0 });
});

test("porcelain counts files once, including renamed paths, conflicts and unusual names", () => {
  const output =
    " M space name\0AM staged\0 D removed\0?? line\nbreak\0R  destination\0source\0UU conflict\0!! ignored\0";
  assert.deepEqual(parseWorkspaceChanges(output), {
    modified: 2,
    added: 1,
    deleted: 1,
    untracked: 1,
    conflicted: 1,
  });
  assert.deepEqual(parseWorkspaceChanges(""), zero);
  assert.deepEqual(parseWorkspaceChanges("C  copied\0source\0?? next\0"), {
    ...zero,
    added: 1,
    untracked: 1,
  });
});

test("changed file list keeps one entry per file, including renames and untracked", () => {
  const output =
    " M space name\0AM staged\0 D removed\0?? line\nbreak\0R  destination\0source\0UU conflict\0!! ignored\0";
  assert.deepEqual(parseWorkspaceFiles(output), [
    "space name",
    "staged",
    "removed",
    "line\nbreak",
    "destination",
    "conflict",
  ]);
  assert.deepEqual(parseWorkspaceFiles(""), []);
});

test("workspace reader reports real git changes and gracefully handles non repositories", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-workspace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal((await readWorkspaceStatus(dir)).gitStatus, "not-repository");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "home-test");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "before\n");
  fs.writeFileSync(path.join(dir, "removed.txt"), "remove\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
  const clean = await readWorkspaceStatus(dir);
  assert.equal(clean.branch, "home-test");
  assert.equal(clean.gitStatus, "ready");
  assert.equal(clean.modified + clean.added + clean.deleted + clean.untracked, 0);
  assert.deepEqual(clean.files, []);
  assert.deepEqual(
    { insertions: clean.insertions, deletions: clean.deletions },
    {
      insertions: 0,
      deletions: 0,
    },
  );
  fs.writeFileSync(path.join(dir, "tracked.txt"), "after\n");
  fs.unlinkSync(path.join(dir, "removed.txt"));
  fs.writeFileSync(path.join(dir, "new file.txt"), "new\n");
  git("add", "new file.txt");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n");
  const status = await readWorkspaceStatus(dir);
  assert.deepEqual(
    {
      modified: status.modified,
      added: status.added,
      deleted: status.deleted,
      untracked: status.untracked,
      conflicted: status.conflicted,
    },
    { modified: 1, added: 1, deleted: 1, untracked: 1, conflicted: 0 },
  );
  // 增删行数只统计已跟踪文件：tracked 改 1 行、removed 删 1 行、new file 增 1 行，未跟踪文件不计入。
  assert.deepEqual(
    { insertions: status.insertions, deletions: status.deletions },
    {
      insertions: 2,
      deletions: 2,
    },
  );
  // 「改动」列表含未跟踪文件，与文件计数同一份 porcelain 输出。
  assert.deepEqual(status.files.slice().sort(), [
    "new file.txt",
    "removed.txt",
    "tracked.txt",
    "untracked.txt",
  ]);
  git("checkout", "--detach");
  assert.match((await readWorkspaceStatus(dir)).branch, /^detached · [a-f0-9]+$/);
  assert.equal((await readWorkspaceStatus(path.join(dir, "missing"))).gitStatus, "unavailable");
});

test("line counts work before the first commit when HEAD does not exist yet", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-workspace-unborn-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "unborn");
  fs.writeFileSync(path.join(dir, "staged.txt"), "one\ntwo\nthree\n");
  git("add", "staged.txt");
  fs.writeFileSync(path.join(dir, "staged.txt"), "one\nthree\n");
  const status = await readWorkspaceStatus(dir);
  assert.equal(status.gitStatus, "ready");
  // 暂存区 3 行新增 + 工作区再删 1 行：与 diff HEAD 的结果一致。
  assert.deepEqual(
    { insertions: status.insertions, deletions: status.deletions },
    {
      insertions: 3,
      deletions: 1,
    },
  );
});
