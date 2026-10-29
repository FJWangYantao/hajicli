import assert from "node:assert/strict";
import test from "node:test";
import {
  handleRewindCommand,
  handleUndoCommand,
  resumeSessionById,
} from "../dist/session-commands.js";

function fixture() {
  let messages = [
    { role: "system", content: "system" },
    { role: "user", content: "keep question" },
    { role: "assistant", content: "keep answer" },
    { role: "user", content: "remove question", snapshotId: "snapshot" },
    { role: "assistant", content: "remove answer" },
  ];
  const lines = ["stale display"];
  const effects = [];
  const session = { id: "session", title: "title" };
  const noop = () => {};
  const ctx = {
    ui: {
      writeLine: (line) => lines.push(line),
      getContentWidth: () => 80,
      replaceChatSegments: (pieces) => {
        lines.length = 0;
        lines.push(...pieces.map((piece) => piece.raw));
      },
      dismissStartupHeader: noop,
      readInput: async (options) => {
        effects.push(options.initialValue);
        return "edited";
      },
      setQueue: noop,
    },
    sessionManager: { getCurrentSession: () => session },
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
    snapshotEngine: {
      rollbackOwnedChanges: () => ({ ok: true, revertedPaths: [], preservedPaths: [] }),
    },
    skillRegistry: { restoreScopeFromMessages: () => effects.push("skills") },
    resetPlanReviewState: () => effects.push("plan"),
    refreshSystemPrompt: async () => effects.push("prompt"),
    refreshAgentVerificationContext: () => effects.push("verification"),
    syncTaskPlanUI: noop,
    saveSession: noop,
    updateStatusUI: noop,
    getSlashCommands: () => [],
    pendingInputs: [],
    readSelectionSafely: async () => ({ value: "3", secondaryValue: "yes" }),
  };
  return { ctx, lines, effects };
}

for (const [name, run] of [
  ["undo", handleUndoCommand],
  ["rewind", handleRewindCommand],
]) {
  test(`${name} replays retained history and refreshes state before refilling`, async () => {
    const { ctx, lines, effects } = fixture();
    await run(ctx);
    const display = lines.join("\n");
    assert.match(display, /keep question/);
    assert.match(display, /keep answer/);
    assert.doesNotMatch(display, /remove question|remove answer|stale display/);
    assert.equal(ctx.getMessages().length, 3);
    assert.deepEqual(effects, ["skills", "plan", "prompt", "verification", "remove question"]);
    assert.deepEqual(ctx.pendingInputs, ["edited"]);
  });
}

test("failed rollback preserves display and history", async () => {
  const { ctx, lines, effects } = fixture();
  const previous = ctx.getMessages();
  ctx.snapshotEngine.rollbackOwnedChanges = () => ({ ok: false, reason: "missing" });
  await handleUndoCommand(ctx);
  assert.equal(ctx.getMessages(), previous);
  assert.equal(lines[0], "stale display");
  assert.deepEqual(effects, []);
});

test("archive recovery notice remains visible after history replacement", async () => {
  const { ctx, lines } = fixture();
  const dir = "/old/.haji/sessions";
  ctx.sessionManager = {
    flush: async () => {},
    hasPendingWrites: () => false,
    locateSessionDir: () => "/new/.haji/sessions",
    getSessionsDir: () => dir,
    isArchivedSession: () => true,
    loadSession: () => ({ id: "loaded", title: "archive", messages: ctx.getMessages() }),
    getCurrentSession: () => ({ id: "loaded", title: "archive" }),
  };
  ctx.taskStore = { setTaskScope: () => {} };
  ctx.snapshotEngine.setScope = () => {};
  ctx.agentManager = { setScope: () => {} };
  ctx.applySessionUsage = () => {};
  await resumeSessionById(ctx, "loaded");
  assert.match(lines.join("\n"), /归档会话已取回/);
  assert.match(lines.join("\n"), /keep answer/);
});
