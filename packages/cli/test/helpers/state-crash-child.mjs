import fs from "node:fs";
import path from "node:path";
import { SessionManager, SnapshotEngine, TaskStore } from "@hajicli/core";

const [dir, boundary] = process.argv.slice(2);
const manager = new SessionManager(path.join(dir, ".haji", "sessions"));
const id = manager.getCurrentSession().id;
const tasks = new TaskStore(path.join(dir, ".haji", "tasks"));
tasks.setTaskScope(id);
const snapshots = new SnapshotEngine(dir);
snapshots.setScope(id);
const anchor = snapshots.createAnchor("start");
manager.saveCurrentSession([{ role: "user", content: "change file", snapshotId: anchor }]);
await manager.flush();
tasks.createTask({ id: "edit", content: "edit file", title: "恢复验证" });
tasks.updateTask("edit", { status: "in_progress" });
const checkpoint = snapshots.beginMutation(anchor, ["file.txt"]);
fs.writeFileSync(path.join(dir, "file.txt"), "after\n");
snapshots.completeMutation(checkpoint);
if (boundary === "completed") {
  tasks.finishTask("edit", "file verified");
  manager.saveCurrentSession([
    ...manager.getCurrentSession().messages,
    { role: "assistant", content: "done" },
  ]);
  await manager.flush();
}
process.send({ id, anchor });
// 父进程在明确边界杀死，禁止定时器偶然把数据冲盘。
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
