import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@hajicli/core";
import { resumeSessionById } from "../dist/session-commands.js";
import { buildStartupHome, startupActions } from "../dist/startup-home.js";
import { TerminalUI } from "../dist/terminal-input.js";
import { terminalWidth } from "../dist/terminal-text.js";
import {
  bgSeq,
  getTheme,
  setColorLevel,
  setThemeAppearance,
  setThemePreset,
  themeReset,
} from "../dist/theme.js";
import { buildSidebarFrame } from "../dist/tui-sidebar.js";

const strip = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const sessions = Array.from({ length: 4 }, (_, index) => ({
  id: `session-${index}`,
  title: `会话 ${index}`,
  updatedAt: "2026-10-28T15:00:00Z",
}));
const workspace = {
  name: "hajicli",
  branch: "master",
  gitStatus: "ready",
  modified: 3,
  added: 1,
  deleted: 0,
  untracked: 2,
  conflicted: 0,
};

function withUI(columns, rows, callback) {
  const descriptors = Object.fromEntries(
    ["columns", "rows", "write"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(process.stdout, key),
    ]),
  );
  const ui = new TerminalUI({
    header: "HAJI\nLOGO",
    compactHeader: "HAJI",
    inputPrompt: "> ",
    renderBorder: (width) => "-".repeat(width),
    onResumeSession: (id) => {
      ui.resumed = id;
    },
  });
  try {
    Object.defineProperties(process.stdout, {
      columns: { configurable: true, value: columns },
      rows: { configurable: true, value: rows },
      write: { configurable: true, value: () => true },
    });
    ui.interactive = true;
    ui.started = true;
    ui.activeInput = {
      prompt: "> ",
      continuationPrompt: "  ",
      graphemes: [],
      cursorIndex: 0,
      sensitive: false,
      slashCommands: [],
      selectedCommandIndex: 0,
      historyNavigationActive: false,
      resolve(value) {
        ui.submitted = value;
      },
      reject() {},
    };
    ui.setRecentSessions(sessions);
    ui.setWorkspaceStatus(workspace);
    ui.renderFrame();
    callback(ui);
  } finally {
    ui.started = false;
    ui.interactive = false;
    if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else delete process.stdout[key];
    }
  }
}

test("home caps recent sessions, sanitizes titles and fits small dimensions", () => {
  assert.equal(startupActions(sessions).length, 6);
  const home = buildStartupHome(sessions, 70, 20, 3, Date.parse("2026-10-28T15:01:00Z"));
  assert.equal(home.hits.length, 6);
  assert.match(strip(home.rows.join("\n")), /最近会话/);
  assert.doesNotMatch(strip(home.rows.join("\n")), /会话 3/);
  for (const width of [8, 16, 32, 80]) {
    for (const height of [1, 3, 6, 10]) {
      const frame = buildStartupHome(
        [{ ...sessions[0], title: "\x1b[2J恶意\n标题" }],
        width,
        height,
      );
      assert.ok(frame.rows.length <= height);
      assert.ok(frame.rows.every((row) => terminalWidth(row) <= width));
      assert.ok(frame.hits.every((hit) => hit.row < frame.rows.length));
    }
  }
});

test("home keyboard fills prompts without sending and resumes by ID; first send dismisses it", () => {
  setThemePreset("paper");
  withUI(140, 40, (ui) => {
    assert.match(strip(ui.renderedScreenRows.join("\n")), /你想完成什么/);
    assert.ok(
      ui.renderedScreenRows.findIndex((row) => strip(row).includes("工作区")) >
        ui.inputSelectionTop,
    );
    assert.equal(ui.chatAreaRightEdgeColumn, 0);
    assert.ok(ui.inputSelectionLeft > 0);
    assert.equal(ui.chatContent, "");
    ui.handleKeypress("\t", { name: "tab" });
    ui.handleKeypress("\r", { name: "return" });
    assert.match(ui.activeInput.graphemes.join(""), /结构、主要入口和运行方式/);
    assert.equal(ui.submitted, undefined);
    ui.startupSelected = 3;
    ui.handleKeypress("\r", { name: "return" });
    assert.equal(ui.resumed, sessions[0].id);
    ui.dismissStartupHeader();
    ui.renderFrame();
    assert.equal(ui.startupHits.length, 0);
    assert.doesNotMatch(strip(ui.renderedScreenRows.join("\n")), /从这里开始|最近会话/);
    const region = ui.sidebarHits.get("context.usage");
    assert.ok(region);
    assert.match(strip(ui.renderedScreenRows[region.rowStart - 1]), /占用/);
  });
});

test("mouse opens only on matching down/up; auth input and ordinary typing remain usable", () => {
  withUI(140, 40, (ui) => {
    const hit = ui.startupHits.find((item) => item.index === 1);
    const click = { button: 0, row: hit.row, column: hit.left, action: "down" };
    ui.handleMouseEvent(click);
    ui.handleMouseEvent({ ...click, action: "up", row: click.row + 1 });
    assert.equal(ui.activeInput.graphemes.length, 0);
    ui.handleMouseEvent(click);
    ui.handleMouseEvent({ ...click, action: "up" });
    assert.match(ui.activeInput.graphemes.join(""), /潜在问题/);
    ui.activeInput.graphemes = [];
    ui.handleKeypress("\t", { name: "tab" });
    ui.handleKeypress("x", { name: "x" });
    ui.handleKeypress("\r", { name: "return" });
    assert.equal(ui.submitted, "x");
  });
  withUI(140, 40, (ui) => {
    ui.activeInput.prompt = "授权？";
    ui.renderFrame();
    assert.equal(ui.startupHits.length, 0);
  });
});

test("centered launcher shares horizontal action rows without overlapping mouse hit regions", () => {
  withUI(140, 36, (ui) => {
    const actions = ui.startupHits.filter((hit) => hit.index < 3);
    assert.equal(new Set(actions.map((hit) => hit.row)).size, 1);
    assert.ok(actions[0].right < actions[1].left && actions[1].right < actions[2].left);
    for (const hit of actions) {
      ui.activeInput.graphemes = [];
      const click = { button: 0, row: hit.row, column: hit.left + 2, action: "down" };
      ui.handleMouseEvent(click);
      ui.handleMouseEvent({ ...click, action: "up" });
      assert.equal(ui.activeInput.graphemes.join(""), startupActions(sessions)[hit.index].value);
      assert.equal(ui.submitted, undefined);
    }
  });
});

test("centered input cursor, drag selection and vertical movement use its actual offset and width", () => {
  withUI(140, 36, (ui) => {
    ui.activeInput.graphemes = [..."abc中文xyz"];
    ui.activeInput.cursorIndex = ui.activeInput.graphemes.length;
    ui.copyInputSelection = () => true;
    ui.renderFrame();
    const top = ui.inputSelectionTop + 1;
    const firstColumn = ui.inputSelectionLeft + 3;
    const click = { button: 0, row: top, column: firstColumn + 1, action: "down" };
    ui.handleMouseEvent(click);
    ui.handleMouseEvent({ ...click, column: firstColumn + 5, action: "move" });
    ui.handleMouseEvent({ ...click, column: firstColumn + 5, action: "up" });
    assert.equal(ui.getSelectedInputText(), "bc中文");
    ui.renderFrame();
    assert.ok(ui.renderedScreenRows[ui.inputSelectionTop].includes("\x1b[7m"));
    const cursor = /\x1b\[(\d+);(\d+)H/.exec(ui.renderedCursorState);
    assert.equal(Number(cursor[1]), top);
    assert.equal(Number(cursor[2]), ui.inputSelectionLeft + 13);
    ui.activeInput.graphemes = [..."a".repeat(100)];
    ui.activeInput.cursorIndex = 100;
    ui.renderFrame();
    assert.equal(ui.inputSelectionHeight, 2);
    assert.equal(ui.moveVertically(-1), true);
    assert.equal(ui.activeInput.cursorIndex, 22);
    ui.dismissStartupHeader();
    ui.renderFrame();
    assert.equal(ui.inputSelectionLeft, 0);
    assert.ok(ui.chatAreaRightEdgeColumn > 0);
  });
});

test("centered launcher reserves real multiline input, image chips and slash suggestions before entries", () => {
  for (const [columns, rows] of [
    [140, 36],
    [80, 24],
    [40, 12],
    [25, 10],
  ]) {
    withUI(columns, rows, (ui) => {
      ui.activeInput.graphemes = [...Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n")];
      ui.activeInput.cursorIndex = ui.activeInput.graphemes.length;
      ui.pendingImages = [{ displayName: "image.png" }];
      ui.renderFrame();
      assert.ok(ui.renderedScreenRows.some((row) => strip(row).includes("line 14")));
      const end = ui.inputSelectionTop + ui.inputSelectionHeight;
      assert.ok(ui.startupHits.every((hit) => hit.row > end));
      assert.ok(ui.renderedScreenRows.every((row) => terminalWidth(row) < columns));
      assert.ok(end < rows);
      ui.activeInput.graphemes = [..."/he"];
      ui.activeInput.cursorIndex = 3;
      ui.activeInput.slashCommands = [{ command: "/help", description: "帮助" }];
      ui.renderFrame();
      const suggestion = ui.renderedScreenRows.findIndex((row) => strip(row).includes("/help"));
      assert.ok(suggestion > ui.inputSelectionTop);
      assert.ok(ui.startupHits.every((hit) => hit.row - 1 > suggestion));
    });
  }
});

test("launcher input and footer stay disjoint during resize, queued text and multiple image rows", () => {
  for (const columns of [25, 40, 76, 140]) {
    for (const rows of [10, 12, 18, 24, 36]) {
      withUI(columns, rows, (ui) => {
        ui.queueText = "下一条消息已排队";
        ui.pendingImages = Array.from({ length: 5 }, (_, i) => ({
          displayName: `attachment-image-${i}.png`,
        }));
        ui.activeInput.graphemes = [..."/he"];
        ui.activeInput.cursorIndex = 3;
        ui.activeInput.slashCommands = [{ command: "/help", description: "帮助" }];
        ui.renderFrame();
        const cursor = /\x1b\[(\d+);(\d+)H/.exec(ui.renderedCursorState);
        assert.ok(Number(cursor[1]) < rows);
        assert.ok(Number(cursor[2]) < columns);
        assert.ok(ui.inputSelectionTop >= 2);
        assert.equal(ui.renderedScreenRows.length, rows);
        assert.ok(ui.renderedScreenRows.every((row) => terminalWidth(row) < columns));
        assert.ok(strip(ui.renderedScreenRows.join("\n")).includes("¥"));
      });
    }
  }
});

test("launcher footer reflects real task, conflict, resource and unpriced states without terminal escapes", () => {
  withUI(140, 36, (ui) => {
    ui.taskPanelTitle = "实现首页";
    ui.taskPanelItems = [
      { id: "a", content: "完成", status: "completed" },
      { id: "b", content: "验证", status: "in_progress" },
    ];
    ui.setWorkspaceStatus({ ...workspace, name: "project\x1b[2J\nname", conflicted: 2 });
    ui.setContextUsage(2900, 500000);
    ui.costCny = 1.2345;
    ui.costHasUnpriced = true;
    ui.renderFrame();
    const text = ui.renderedScreenRows.join("\n");
    assert.ok(!text.includes("\x1b[2J"));
    const plain = strip(text);
    assert.match(plain, /任务 1\/2 · 实现首页/);
    assert.match(plain, /冲突 2/);
    assert.match(plain, /2,900 \/ 500,000/);
    assert.match(plain, /¥1\.2345 \+ 未定价/);
    ui.contextItemsProvider = () => [
      {
        category: "system",
        label: "系统",
        tokens: 2900,
        items: [{ label: "系统提示", tokens: 2900, detail: "系统提示正文" }],
      },
    ];
    const hit = ui.sidebarHits.get("context.usage");
    const click = { button: 0, row: hit.rowStart, column: hit.columnStart, action: "down" };
    ui.handleMouseEvent(click);
    ui.handleMouseEvent({ ...click, action: "up" });
    ui.renderFrame();
    assert.equal(ui.startupHits.length, 0);
    assert.ok(ui.contextInspector);
  });
});

test("home preserves Tab command completion when the input already contains a command", () => {
  withUI(140, 40, (ui) => {
    ui.activeInput.slashCommands = [{ command: "/help", description: "帮助" }];
    ui.activeInput.graphemes = [..."/he"];
    ui.activeInput.cursorIndex = 3;
    ui.handleKeypress("\t", { name: "tab" });
    assert.match(ui.activeInput.graphemes.join(""), /^\/help/);
    assert.equal(ui.startupSelected, -1);
  });
});

test("welcome layout never exceeds terminal bounds across narrow and short windows", () => {
  for (const theme of ["default", "paper"]) {
    setThemePreset(theme);
    for (const [width, height] of [
      [20, 8],
      [40, 12],
      [80, 24],
      [120, 24],
      [160, 40],
    ]) {
      withUI(width, height, (ui) => {
        assert.equal(ui.renderedScreenRows.length, height);
        assert.ok(ui.renderedScreenRows.every((row) => terminalWidth(row) < width));
      });
    }
  }
});

test("launcher panel encloses input, entries and live states with a continuous theme surface", () => {
  try {
    for (const theme of ["default", "paper", "kero"]) {
      setThemePreset(theme);
      for (const appearance of ["light", "dark"]) {
        setThemeAppearance(appearance);
        for (const level of ["truecolor", "ansi256", "ansi16", "mono"]) {
          setColorLevel(level);
          for (const [width, height] of [
            [140, 36],
            [76, 24],
            [40, 18],
            [25, 10],
          ]) {
            withUI(width, height, (ui) => {
              const plain = ui.renderedScreenRows.map(strip);
              const first = plain.findIndex((row) => row.includes("╭"));
              const bottom = plain.findIndex((row) => row.includes("╰"));
              assert.ok(first >= 0 && bottom > first);
              const left = plain[first].indexOf("╭");
              const panelWidth = terminalWidth(plain[first]) - left;
              assert.ok(panelWidth < width);
              for (let row = first + 1; row < bottom; row++) {
                assert.equal(plain[row].indexOf("│"), left);
                assert.equal(terminalWidth(plain[row]), left + panelWidth);
                assert.ok(plain[row].endsWith("│"));
                const raw = ui.renderedScreenRows[row];
                if (level === "mono") assert.ok(!raw.includes("\x1b"));
                else {
                  const reset = themeReset(),
                    background = bgSeq(getTheme().userMsgBg);
                  const inner = raw.slice(0, -reset.length);
                  assert.ok(inner.includes(background));
                  assert.ok(
                    inner
                      .split(reset)
                      .slice(1)
                      .every((part) => part.startsWith(background)),
                  );
                  assert.ok(raw.endsWith(reset));
                }
              }
              assert.ok(ui.inputSelectionTop > first && ui.inputSelectionTop < bottom);
              assert.ok(ui.startupHits.every((hit) => hit.row - 1 > first && hit.row - 1 < bottom));
              const hit = ui.sidebarHits.get("context.usage");
              assert.ok(hit.rowStart - 1 < bottom);
              assert.ok(hit.columnStart > left + 1 && hit.columnEnd < left + panelWidth);
              if (height >= 24) {
                assert.ok(plain.findIndex((row) => row.includes("工作区")) > ui.inputSelectionTop);
                assert.ok(plain.findIndex((row) => row.includes("工作区")) < bottom);
                assert.ok(plain.slice(bottom + 1).every((row) => !row.trim()));
              }
            });
          }
        }
      }
    }
  } finally {
    setColorLevel("truecolor");
    setThemePreset("default");
    setThemeAppearance("dark");
  }
});

test("workspace and real task states coexist with context and cost within each budget", () => {
  for (const theme of ["default", "paper"]) {
    setThemePreset(theme);
    for (const height of [14, 18, 24, 40]) {
      const frame = buildSidebarFrame(
        {
          usedTokens: 20,
          maxTokens: 1000,
          costCny: 0,
          workspace,
          goal: { text: "实现首页", status: "active" },
          taskPlan: {
            title: "首页",
            expanded: false,
            items: [
              { id: "a", content: "接入欢迎区", status: "in_progress" },
              { id: "b", content: "完成检查", status: "pending" },
            ],
          },
        },
        36,
        height,
      );
      const text = strip(frame.rows.join("\n"));
      assert.match(text, /任务/);
      assert.match(text, /上下文/);
      assert.match(text, /费用/);
      assert.ok(frame.rows.length <= height);
      assert.ok(frame.rows.every((row) => terminalWidth(row) <= 36));
      if (height === 40) {
        assert.match(text, /修改 3/);
        assert.match(text, /master/);
      }
    }
  }
});

test("recent session recovers the exact stored conversation, usage, task scope and startup state", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-home-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new SessionManager(dir);
  const id = manager.getCurrentSession().id;
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "目标会话" },
    { role: "assistant", content: "继续工作" },
  ];
  manager.setUsage({ compactionCount: 2, lastTurnMs: 321 });
  manager.saveCurrentSession(messages);
  await manager.flush();
  manager.startNewSession();
  let restored,
    usage,
    taskScope,
    dismissed = false;
  const scope = { setScope() {} };
  const context = {
    sessionManager: manager,
    ui: {
      writeLine() {},
      replaceChatSegments(pieces) {
        restored = pieces.map((p) => p.raw).join("");
      },
      getContentWidth: () => 80,
      dismissStartupHeader() {
        dismissed = true;
      },
    },
    taskStore: {
      setTaskScope(value) {
        taskScope = value;
      },
    },
    snapshotEngine: scope,
    agentManager: scope,
    skillRegistry: { restoreScopeFromMessages() {} },
    resetPlanReviewState() {},
    syncTaskPlanUI() {},
    setMessages(value) {
      assert.deepEqual(value, messages);
    },
    async refreshSystemPrompt() {},
    refreshAgentVerificationContext() {},
    applySessionUsage(value) {
      usage = value;
    },
    saveSession() {},
    updateStatusUI() {},
  };
  assert.equal(await resumeSessionById(context, id), true);
  assert.equal(manager.getCurrentSession().id, id);
  assert.equal(taskScope, id);
  assert.equal(usage.compactionCount, 2);
  assert.match(restored, /目标会话/);
  assert.equal(dismissed, true);
  assert.equal(await resumeSessionById(context, "missing-session"), false);
});
