import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@hajicli/core";
import { handleClearCommand, resumeSessionById } from "../dist/session-commands.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-session-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary", ".haji", "sessions");
  const other = path.join(root, "other", ".haji", "sessions");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(root, "other", ".git"), "gitdir: unused");
  const manager = new SessionManager(primary);
  manager.setSearchDirs([other]);
  return { root, primary, other, manager };
}

function writeSession(dir, id, overrides = {}) {
  const session = {
    id,
    title: "待恢复会话",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    messages: [{ role: "user", content: "历史请求" }],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, `session_${id}.json`), JSON.stringify(session));
}

function context(manager) {
  let messages = [{ role: "system", content: "旧目标 + 旧技能" }];
  let prompt = messages[0].content;
  const effects = [];
  const noop = () => {};
  return {
    effects,
    sessionManager: manager,
    ui: {
      writeLine: noop,
      clearChat: noop,
      dismissStartupHeader: noop,
      getContentWidth: () => 80,
      replaceChatSegments: noop,
    },
    taskStore: { setTaskScope: (id) => effects.push(["task", id]) },
    snapshotEngine: { setScope: (id) => effects.push(["snapshot", id]) },
    agentManager: { setScope: (id) => effects.push(["agent", id]) },
    skillRegistry: { clearLoaded: noop, restoreScopeFromMessages: noop },
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
    getSystemPrompt: () => prompt,
    refreshSystemPrompt: async () => {
      assert.equal(manager.getCurrentSession().goal, undefined);
      assert.doesNotMatch(messages[0]?.content ?? "", /Compacted Context Summary/);
      prompt = "新会话提示词";
      messages[0] = { role: "system", content: prompt };
    },
    resetPlanReviewState: noop,
    syncTaskPlanUI: noop,
    refreshAgentVerificationContext: noop,
    saveSession: () => manager.saveCurrentSession(messages),
    updateStatusUI: noop,
    applySessionUsage: noop,
    enterSessionWorktree: (cwd) => {
      effects.push(["cwd", cwd]);
      manager.setSessionsDir(path.join(cwd, ".haji", "sessions"));
    },
  };
}

test("/clear 后下一轮提示词不携带旧目标、技能或压缩摘要", async (t) => {
  const { manager } = fixture(t);
  manager.setGoal({ text: "旧目标", status: "active", createdAt: new Date().toISOString() });
  const ctx = context(manager);
  ctx.setMessages([{ role: "system", content: "旧目标\n[Compacted Context Summary]\n旧摘要" }]);
  await handleClearCommand(ctx);
  await manager.flush();
  assert.equal(manager.getCurrentSession().goal, undefined);
  assert.deepEqual(ctx.getMessages(), [{ role: "system", content: "新会话提示词" }]);
});

test("恢复列表、定位与实际加载均选择最新副本，继续保存回原目录", async (t) => {
  const { manager, primary, other } = fixture(t);
  writeSession(primary, "duplicate", { title: "旧副本" });
  writeSession(other, "duplicate", {
    title: "新副本",
    updatedAt: "2025-06-01T00:00:00.000Z",
    messages: [{ role: "user", content: "最新进度" }],
  });
  assert.equal(manager.listSessions()[0].title, "新副本");
  assert.equal(manager.locateSessionDir("duplicate"), other);
  const ctx = context(manager);
  ctx.refreshSystemPrompt = async () => {};
  assert.equal(await resumeSessionById(ctx, "duplicate"), true);
  assert.equal(manager.getCurrentSession().title, "新副本");
  assert.equal(ctx.getMessages()[0].content, "最新进度");
  assert.deepEqual(ctx.effects[0], ["cwd", path.resolve(other, "..", "..")]);
  manager.saveCurrentSession([...ctx.getMessages(), { role: "user", content: "继续" }]);
  await manager.flush();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(other, "session_duplicate.json"))).messages.length,
    2,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(primary, "session_duplicate.json"))).title,
    "旧副本",
  );
});

test("损坏的新副本不遮蔽有效旧副本，列表与加载使用相同校验", async (t) => {
  const { manager, primary, other } = fixture(t);
  writeSession(primary, "duplicate", { title: "有效副本" });
  writeSession(other, "duplicate", {
    title: "损坏副本",
    updatedAt: "2025-06-01T00:00:00.000Z",
    messages: [{ role: "user", content: "请求", tool_calls: {} }],
  });
  assert.equal(manager.listSessions()[0].title, "有效副本");
  assert.equal(manager.locateSessionDir("duplicate"), primary);
  assert.equal(manager.loadSession("duplicate").title, "有效副本");
  await manager.flush();
});

test("同时间的归档副本不替换主目录，更新的归档取回续写且保持归档原样", async (t) => {
  const { manager, primary, other } = fixture(t);
  manager.setSearchDirs([]);
  manager.setArchiveDirs([other]);
  writeSession(primary, "duplicate", { title: "当前副本" });
  writeSession(other, "duplicate", { title: "归档副本" });
  assert.equal(manager.locateSessionDir("duplicate"), primary);
  writeSession(other, "duplicate", { title: "较新归档", updatedAt: "2025-06-01T00:00:00.000Z" });
  const archiveFile = path.join(other, "session_duplicate.json");
  const before = fs.readFileSync(archiveFile, "utf8");
  assert.equal(manager.isArchivedSession("duplicate"), true);
  assert.equal(manager.loadSession("duplicate").title, "较新归档");
  assert.equal(manager.getSessionsDir(), primary);
  assert.equal(manager.isArchivedSession("duplicate"), false);
  manager.saveCurrentSession([{ role: "user", content: "继续" }]);
  await manager.flush();
  assert.equal(fs.readFileSync(archiveFile, "utf8"), before);
});

for (const invalid of ["broken-json", "missing-messages", "empty", "system-only"]) {
  test(`恢复 ${invalid} 跨树会话失败时不改变当前会话、目录或 scope`, async (t) => {
    const { manager, primary, other } = fixture(t);
    const current = manager.getCurrentSession();
    if (invalid === "broken-json") {
      fs.writeFileSync(path.join(other, "session_invalid.json"), "{");
    } else {
      writeSession(other, "invalid", {
        messages:
          invalid === "missing-messages"
            ? undefined
            : invalid === "empty"
              ? []
              : [{ role: "system", content: "sys" }],
      });
    }
    const ctx = context(manager);
    const messages = ctx.getMessages();
    assert.equal(await resumeSessionById(ctx, "invalid"), false);
    assert.equal(manager.getCurrentSession(), current);
    assert.equal(manager.getSessionsDir(), primary);
    assert.equal(ctx.getMessages(), messages);
    assert.deepEqual(ctx.effects, []);
    assert.equal(manager.loadSession("invalid"), null);
    assert.equal(manager.getCurrentSession(), current);
    assert.equal(manager.getSessionsDir(), primary);
    await manager.flush();
  });
}
