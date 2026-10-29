import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, SnapshotEngine, TaskStore } from "@hajicli/core";

test("两个真实进程同时保存同一会话只允许一个版本写入", { timeout: 15000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-concurrent-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new SessionManager(dir);
  manager.saveCurrentSession([{ role: "user", content: "base" }]);
  await manager.flush();
  const id = manager.getCurrentSession().id;
  const children = ["first", "second"].map((content) =>
    fork(new URL("./helpers/concurrent-session-child.mjs", import.meta.url), [dir, id, content], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
  );
  t.after(() => {
    for (const child of children) child.kill("SIGKILL");
  });
  await Promise.all(children.map((child) => once(child, "message")));
  const outcomes = children.map((child) => once(child, "message"));
  const exits = children.map((child) => once(child, "exit"));
  for (const child of children) child.send("save");
  const results = (await Promise.all(outcomes)).map(([message]) => message);
  await Promise.all(exits);
  assert.equal(results.filter((r) => !r.pending).length, 1);
  assert.match(results.find((r) => r.pending).warnings.join("\n"), /写入冲突/);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, `session_${id}.json`)));
  assert.ok(["first", "second"].includes(stored.messages[0].content));
  assert.equal(
    fs.readdirSync(dir).some((f) => f.endsWith(".lock")),
    false,
  );
});

for (const boundary of ["mutation", "completed"]) {
  test(`强退 ${boundary} 后任务、会话和快照可恢复`, { timeout: 15000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-state-crash-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    fs.writeFileSync(path.join(dir, ".gitignore"), ".haji/\n");
    fs.writeFileSync(path.join(dir, "file.txt"), "before\n");
    git("add", ".");
    git("commit", "-m", "initial");
    const child = fork(
      new URL("./helpers/state-crash-child.mjs", import.meta.url),
      [dir, boundary],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    t.after(() => child.kill("SIGKILL"));
    const [{ id, anchor }] = await once(child, "message");
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    const manager = new SessionManager(path.join(dir, ".haji", "sessions"));
    assert.ok(manager.loadSession(id));
    const tasks = new TaskStore(path.join(dir, ".haji", "tasks"));
    tasks.setTaskScope(id);
    const plan = tasks.getPlan();
    assert.equal(
      boundary === "completed" ? plan.completedTasks[0].status : plan.tasks[0].status,
      boundary === "completed" ? "completed" : "in_progress",
    );
    assert.equal(
      manager.getCurrentSession().messages.at(-1).content,
      boundary === "completed" ? "done" : "change file",
    );
    assert.equal(fs.readFileSync(path.join(dir, "file.txt"), "utf8"), "after\n");
    const snapshots = new SnapshotEngine(dir);
    snapshots.setScope(id);
    assert.equal(snapshots.listOwnedChanges(0).length, 1);
    const result = snapshots.rollbackOwnedChanges(anchor);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, "file.txt"), "utf8"), "before\n");
  });
}
