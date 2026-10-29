import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, TaskStore } from "@hajicli/core";
import { runShutdownSteps } from "../dist/shutdown.js";
import { recoveryCalls, recoveryHarness } from "./helpers/recovery-harness.mjs";

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-persistence-fault-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const fault of ["before-tools", "after-first-tool"]) {
  test(`保存失败 ${fault} 后停止工具执行且不报告完成`, async (t) => {
    const dir = temporary(t);
    const manager = new SessionManager(dir, () => {});
    let executed = 0;
    let completed = false;
    const original = fs.promises.rename;
    const fail = async () => {
      throw new Error("storage unavailable");
    };
    const provider = {
      async *completeStream(_messages, options) {
        options?.onRequestStart?.();
        options.onToolCall?.(recoveryCalls);
        options.onFinish?.({ reason: "tool_calls" });
      },
    };
    const harness = recoveryHarness(manager, provider, async () => {
      executed++;
      fs.promises.rename = fail;
      return { output: "side effect done", duration: 1 };
    });
    harness.deps.onTurnFinished = () => {
      completed = true;
    };
    if (fault === "before-tools") fs.promises.rename = fail;
    try {
      await harness.run();
    } finally {
      fs.promises.rename = original;
    }
    assert.equal(executed, fault === "before-tools" ? 0 : 1);
    assert.equal(completed, false);
    assert.equal(manager.hasPendingWrites(), true);
    const results = harness.messages().filter((m) => m.role === "tool");
    assert.equal(results.length, 2);
    assert.match(results.at(-1).content, /未执行/);
    await manager.flush();
    assert.equal(manager.hasPendingWrites(), false);
  });
}

test("退出超时发出取消信号，后续步骤仍继续", async () => {
  let signal;
  let cleaned = false;
  await runShutdownSteps(
    [
      {
        name: "挂起",
        timeoutMs: 10,
        run: (value) => {
          signal = value;
          return new Promise(() => {});
        },
      },
      {
        name: "清理",
        run: () => {
          cleaned = true;
        },
      },
    ],
    () => {},
  );
  assert.equal(signal.aborted, true);
  assert.equal(cleaned, true);
});

test("退出钩子异常或挂起后仍保存并清理", async () => {
  const calls = [];
  const warnings = [];
  const ok = await runShutdownSteps(
    [
      { name: "首次保存", run: () => calls.push("save") },
      {
        name: "异常钩子",
        run: () => {
          throw new Error("fault");
        },
      },
      { name: "挂起钩子", timeoutMs: 10, run: () => new Promise(() => {}) },
      { name: "最终保存", run: () => calls.push("retry") },
      { name: "清理", run: () => calls.push("cleanup") },
    ],
    (warning) => warnings.push(warning),
  );
  assert.equal(ok, false);
  assert.deepEqual(calls, ["save", "retry", "cleanup"]);
  assert.equal(warnings.length, 2);
});

test("替换失败保留旧会话和待保存数据，恢复后可重试", async (t) => {
  const dir = temporary(t);
  const warnings = [];
  const manager = new SessionManager(dir, (w) => warnings.push(w));
  manager.saveCurrentSession([{ role: "user", content: "old" }]);
  await manager.flush();
  const file = path.join(dir, `session_${manager.getCurrentSession().id}.json`);
  const original = fs.promises.rename;
  fs.promises.rename = async () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  try {
    manager.saveCurrentSession([{ role: "user", content: "new" }]);
    await manager.flush();
  } finally {
    fs.promises.rename = original;
  }
  assert.equal(JSON.parse(fs.readFileSync(file)).messages[0].content, "old");
  assert.equal(manager.hasPendingWrites(), true);
  assert.match(warnings.join("\n"), /持久化失败/);
  assert.equal(
    fs.readdirSync(dir).some((f) => /\.tmp$|\.lock$/.test(f)),
    false,
  );
  await manager.flush();
  assert.equal(manager.hasPendingWrites(), false);
  assert.equal(JSON.parse(fs.readFileSync(file)).messages[0].content, "new");
});

test("任务原子替换失败不损坏已完成计划", (t) => {
  const dir = temporary(t);
  const store = new TaskStore(dir);
  store.createTask({ id: "one", content: "first", title: "验证" });
  const rename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("replace failed");
  };
  try {
    assert.throws(() => store.updateTask("one", { status: "in_progress" }), /replace failed/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(store.getPlan().tasks[0].status, "pending");
  assert.equal(
    fs.readdirSync(dir).some((f) => f.endsWith(".tmp")),
    false,
  );
});

test("旧版本写入者不能覆盖另一个会话实例的新内容", async (t) => {
  const dir = temporary(t);
  const first = new SessionManager(dir);
  first.saveCurrentSession([{ role: "user", content: "base" }]);
  await first.flush();
  const warnings = [];
  const second = new SessionManager(dir, (w) => warnings.push(w));
  const id = first.getCurrentSession().id;
  assert.ok(second.loadSession(id));
  first.saveCurrentSession([{ role: "user", content: "first wins" }]);
  await first.flush();
  second.saveCurrentSession([{ role: "user", content: "stale" }]);
  await second.flush();
  assert.equal(second.hasPendingWrites(), true);
  assert.match(warnings.join("\n"), /写入冲突/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, `session_${id}.json`))).messages[0].content,
    "first wins",
  );
});
