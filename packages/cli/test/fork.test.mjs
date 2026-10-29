import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../../core/dist/session-manager.js";
import { handleForkCommand } from "../dist/session-commands.js";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-fork-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, manager: new SessionManager(path.join(root, "sessions")) };
}

test("fork persists independent history, goal and compaction while resetting ownership and cost", async (t) => {
  const { root, manager } = setup(t);
  const sourceId = manager.getCurrentSession().id;
  manager.setGoal({ text: "finish", status: "active", createdAt: "2026-01-01" });
  manager.setUsage({ costRecords: [{ model: "test", promptTokens: 10 }], compactionCount: 2 });
  manager.saveCurrentSession(
    [
      {
        role: "user",
        content: "hello",
        snapshotId: "old",
        attachments: [{ mimeType: "image/png", base64: "abc" }],
      },
    ],
    "source",
  );
  await manager.flush();
  const sourceFile = path.join(root, "sessions", `session_${sourceId}.json`);
  const original = fs.readFileSync(sourceFile, "utf8");
  const fork = await manager.forkCurrentSession("alternative");
  assert.notEqual(fork.id, sourceId);
  assert.equal(fork.title, "alternative");
  assert.equal(fork.messages[0].snapshotId, undefined);
  assert.equal(fork.goal.text, "finish");
  assert.deepEqual(fork.usage.costRecords, []);
  assert.equal(fork.usage.compactionCount, 2);
  fork.messages[0].attachments[0].base64 = "changed";
  manager.saveCurrentSession([...fork.messages, { role: "assistant", content: "new" }]);
  await manager.flush();
  assert.equal(fs.readFileSync(sourceFile, "utf8"), original);
  assert.equal(manager.listSessions().length, 2);
  assert.equal(manager.loadSession(sourceId).messages[0].attachments[0].base64, "abc");
});

test("empty history and failed destination writes preserve the current session", async (t) => {
  const { root, manager } = setup(t);
  const sourceId = manager.getCurrentSession().id;
  await assert.rejects(manager.forkCurrentSession(), /暂无/);
  manager.saveCurrentSession([{ role: "user", content: "hello" }], "source");
  await manager.flush();
  const dir = path.join(root, "sessions");
  fs.renameSync(dir, `${dir}-saved`);
  fs.writeFileSync(dir, "blocked");
  await assert.rejects(manager.forkCurrentSession());
  assert.equal(manager.getCurrentSession().id, sourceId);
});

test("unsaved source prevents fork and default title derives from source", async (t) => {
  const { root, manager } = setup(t);
  const sourceId = manager.getCurrentSession().id;
  manager.saveCurrentSession([{ role: "user", content: "hello" }], "source");
  await manager.flush();
  const fork = await manager.forkCurrentSession();
  assert.equal(fork.title, "source（分叉）");
  manager.loadSession(sourceId);
  const file = path.join(root, "sessions", `session_${sourceId}.json`);
  fs.writeFileSync(file, "external change");
  manager.saveCurrentSession([{ role: "user", content: "unsaved" }]);
  await assert.rejects(manager.forkCurrentSession(), /未保存/);
  assert.equal(manager.getCurrentSession().id, sourceId);
  assert.equal(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".json")).length,
    2,
  );
});

test("CLI fork switches all scopes and refreshes inherited context", async (t) => {
  const { manager } = setup(t);
  let messages = [{ role: "user", content: "hello" }];
  const scopes = [];
  const lines = [];
  let applied;
  let refreshed = false;
  const ctx = {
    sessionManager: manager,
    saveSession: () => manager.saveCurrentSession(messages),
    taskStore: { setTaskScope: (id) => scopes.push(id) },
    snapshotEngine: { setScope: (id) => scopes.push(id) },
    agentManager: { setScope: (id) => scopes.push(id) },
    skillRegistry: { restoreScopeFromMessages: () => {} },
    resetPlanReviewState: () => {},
    setMessages: (value) => {
      messages = value;
    },
    getMessages: () => messages,
    applySessionUsage: (value) => {
      applied = value;
    },
    syncTaskPlanUI: () => {},
    refreshSystemPrompt: async () => {
      refreshed = true;
    },
    refreshAgentVerificationContext: () => true,
    updateStatusUI: () => {},
    ui: {
      writeLine: (line) => lines.push(line),
      getContentWidth: () => 80,
      replaceChatSegments: (pieces) => {
        lines.length = 0;
        lines.push(...pieces.map((piece) => piece.raw));
      },
      dismissStartupHeader: () => {},
    },
  };
  await handleForkCommand(ctx);
  assert.equal(scopes.length, 3);
  assert.ok(scopes.every((id) => id === manager.getCurrentSession().id));
  assert.ok(refreshed);
  assert.equal(applied, undefined);
  assert.ok(lines.some((line) => line.includes("已分叉")));
  await manager.flush();
});
