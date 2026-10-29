import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@hajicli/core";
import { CellCanvas } from "../dist/cell-canvas.js";
import { resumeSessionById } from "../dist/session-commands.js";
import {
  buildSessionProgress,
  buildStartupHome,
  formatResumeDetail,
  startupActions,
} from "../dist/startup-home.js";
import { buildStartupLauncher, STARTUP_TAGLINE } from "../dist/startup-launcher.js";
import { parseOsc11Reply } from "../dist/terminal-appearance.js";
import { TerminalUI } from "../dist/terminal-input.js";
import { terminalWidth } from "../dist/terminal-text.js";
import { getColorLevel, setColorLevel, setThemeAppearance, setThemePreset } from "../dist/theme.js";
import { buildSidebarFrame } from "../dist/tui-sidebar.js";

const strip = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
// 默认 3 天前：超出「继续上次」的 24 小时窗口，多数用例的版式不随运行日期变化。
const sessions = Array.from({ length: 4 }, (_, index) => ({
  id: `session-${index}`,
  title: `会话 ${index}`,
  updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
}));
const hasTagline = (rows) =>
  rows.some((row) => row.replace(/\s/g, "").includes("把想法，写成下一步"));
const INVERSE = /\x1b\[(?:\d+;)*7(?:;[\d;]*)?m/;
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
    ui.permissionMode = "auto";
    ui.modelName = "deepseek-v4-pro";
    ui.providerName = "deepseek";
    ui.reasoningEffort = "high";
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
  const home = buildStartupHome(sessions, 70, 20, 3);
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
    const plain = ui.renderedScreenRows.map(strip);
    assert.ok(hasTagline(plain));
    assert.ok(plain.some((row) => /hajicli\s+master/.test(row)));
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

test("quick actions render as three clickable tiles, a list when narrower, inline when short", () => {
  withUI(140, 36, (ui) => {
    const tiles = [0, 1, 2].map((index) => ui.startupHits.filter((hit) => hit.index === index));
    for (const rows of tiles) {
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((hit) => hit.row),
        rows.map((_, offset) => rows[0].row + offset),
      );
    }
    assert.ok(tiles[0][0].right < tiles[1][0].left && tiles[1][0].right < tiles[2][0].left);
    assert.match(
      strip(ui.renderedScreenRows[tiles[0][1].row - 1]),
      /1\s+了解当前项目.*2\s+检查工作区/,
    );
    assert.match(strip(ui.renderedScreenRows[tiles[0][2].row - 1]), /梳理结构与入口/);
    assert.match(
      strip(ui.renderedScreenRows[tiles[0][0].row - 2]),
      /快速开始.*Tab 选择 · Enter 打开/,
    );
    for (const rows of tiles) {
      ui.activeInput.graphemes = [];
      const hit = rows[2];
      const click = { button: 0, row: hit.row, column: hit.right - 1, action: "down" };
      ui.handleMouseEvent(click);
      ui.handleMouseEvent({ ...click, action: "up" });
      assert.equal(ui.activeInput.graphemes.join(""), startupActions(sessions)[hit.index].value);
      assert.equal(ui.submitted, undefined);
    }
  });
  withUI(60, 30, (ui) => {
    const actions = ui.startupHits.filter((hit) => hit.index < 3);
    assert.deepEqual(
      actions.map((hit) => hit.row),
      actions.map((_, index) => actions[0].row + index),
    );
    assert.match(strip(ui.renderedScreenRows[actions[0].row - 1]), /了解当前项目\s+梳理结构/);
  });
  withUI(76, 11, (ui) => {
    // 排队提示 + 两行附件 + 两行输入把纵向空间吃紧，入口退成一行三格。
    ui.queueText = "下一条消息已排队";
    ui.pendingImages = Array.from({ length: 4 }, (_, i) => ({ displayName: `image-${i}.png` }));
    ui.activeInput.graphemes = [..."first\nsecond"];
    ui.activeInput.cursorIndex = ui.activeInput.graphemes.length;
    ui.renderFrame();
    const actions = ui.startupHits.filter((hit) => hit.index < 3);
    assert.equal(actions.length, 3);
    assert.equal(new Set(actions.map((hit) => hit.row)).size, 1);
    assert.ok(actions[0].right < actions[1].left && actions[1].right < actions[2].left);
  });
});

test("Shift+Tab, arrows and Esc move or clear the selection; hover only recolors", (t) => {
  const previous = getColorLevel();
  setColorLevel("truecolor");
  t.after(() => setColorLevel(previous));
  withUI(140, 36, (ui) => {
    ui.handleKeypress("\t", { name: "tab", shift: true });
    assert.equal(ui.startupSelected, 5);
    ui.handleKeypress("", { name: "down" });
    assert.equal(ui.startupSelected, 0);
    ui.handleKeypress("", { name: "up" });
    assert.equal(ui.startupSelected, 5);
    ui.renderFrame();
    const selectedRow = ui.startupHits.find((hit) => hit.index === 5).row - 1;
    assert.match(strip(ui.renderedScreenRows[selectedRow]), /▸\s+会话 2/);
    ui.handleKeypress("", { name: "escape" });
    assert.equal(ui.startupSelected, -1);
    ui.renderFrame();
    const before = [...ui.renderedScreenRows];
    // 入口卡片的第二行是名称行（第一行是顶边）。
    const hit = ui.startupHits.filter((item) => item.index === 1)[1];
    ui.handleMouseEvent({ button: 3, row: hit.row, column: hit.left + 3, action: "move" });
    assert.equal(ui.startupHovered, 1);
    ui.renderFrame();
    assert.deepEqual(ui.renderedScreenRows.map(strip), before.map(strip));
    assert.notEqual(ui.renderedScreenRows[hit.row - 1], before[hit.row - 1]);
  });
});

test("input card keeps a closed right edge, placeholder and model line at every size", () => {
  for (const [columns, rows] of [
    [160, 48],
    [140, 40],
    [100, 30],
    [80, 24],
    [40, 12],
    [25, 10],
  ]) {
    withUI(columns, rows, (ui) => {
      const plain = ui.renderedScreenRows.map(strip);
      const card = plain.filter((row) => row.includes("▌"));
      assert.ok(card.length >= 1);
      assert.ok(
        plain.every((row) => !row.includes("…")),
        `${columns}x${rows} 出现截断`,
      );
      const input = plain[ui.inputSelectionTop];
      assert.ok(input.includes("▌"));
      assert.match(input, /描述/);
      if (rows >= 18) assert.ok(card.some((row) => row.includes("deepseek-v4-pro · high")));
      ui.activeInput.graphemes = [..."hi"];
      ui.activeInput.cursorIndex = 2;
      ui.renderFrame();
      assert.doesNotMatch(strip(ui.renderedScreenRows[ui.inputSelectionTop]), /描述/);
    });
  }
});

test("logo steps from big pixels to half blocks to a one-line wordmark", () => {
  withUI(140, 40, (ui) => {
    const plain = ui.renderedScreenRows.map(strip);
    assert.equal(plain.filter((row) => row.includes("██")).length, 6);
    assert.ok(hasTagline(plain));
  });
  withUI(100, 30, (ui) => {
    const plain = ui.renderedScreenRows.map(strip);
    assert.ok(!plain.some((row) => row.includes("██  ")));
    assert.equal(plain.filter((row) => /[▀▄]/.test(row)).length >= 2, true);
  });
  withUI(80, 24, (ui) => {
    const plain = ui.renderedScreenRows.map(strip);
    assert.ok(!plain.some((row) => /[▀▄]|██/.test(row)));
    assert.ok(plain.some((row) => row.includes(`haji  ·  ${STARTUP_TAGLINE}`)));
  });
});

test("transient notices take over the footer's left side", () => {
  withUI(140, 36, (ui) => {
    ui.transientHintText = "再按一次 Ctrl+C 退出";
    ui.renderFrame();
    const footer = strip(ui.renderedScreenRows[ui.renderedScreenRows.length - 2]);
    assert.match(footer, /再按一次 Ctrl\+C 退出\s+ctx .*0%/);
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
    assert.match(ui.renderedScreenRows[ui.inputSelectionTop], INVERSE);
    const cursor = /\x1b\[(\d+);(\d+)H/.exec(ui.renderedCursorState);
    assert.equal(Number(cursor[1]), top);
    assert.equal(Number(cursor[2]), ui.inputSelectionLeft + 13);
    ui.activeInput.graphemes = [..."a".repeat(100)];
    ui.activeInput.cursorIndex = 100;
    ui.renderFrame();
    assert.equal(ui.inputSelectionHeight, 2);
    assert.equal(ui.moveVertically(-1), true);
    // 卡片正文宽 72（76 − 左竖条/内边距 2 − 右内边距 2），首行扣掉提示符 2 列放 70 字。
    assert.equal(ui.activeInput.cursorIndex, 30);
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
    assert.match(plain, /ctx .*1%/);
    assert.match(plain, /¥1\.2345\+\?/);
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

test("launcher keeps input primary, sessions separate and project status in the footer", () => {
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
              const card = plain
                .map((row, index) => (row.includes("▌") ? index : -1))
                .filter((index) => index >= 0);
              const top = card[0];
              const bottom = card[card.length - 1];
              assert.ok(top >= 0 && bottom >= top);
              assert.deepEqual(
                card,
                card.map((_, index) => top + index),
              );
              assert.ok(ui.inputSelectionTop >= top && ui.inputSelectionTop <= bottom);
              if (height >= 18) assert.ok(hasTagline(plain));
              assert.ok(ui.startupHits.every((hit) => hit.row - 1 > bottom));
              const recent = plain.findIndex((row) => row.includes("最近会话"));
              const actions = ui.startupHits.filter((hit) => hit.index < 3);
              if (recent >= 0) {
                assert.ok(recent > Math.max(...actions.map((hit) => hit.row - 1)));
              }
              const hit = ui.sidebarHits.get("context.usage");
              assert.ok(hit.rowStart > ui.inputSelectionTop);
              assert.ok(hit.columnStart > 0 && hit.columnEnd < width);
              if (height >= 24) {
                const project = plain.findIndex((row) => /hajicli\s+master/.test(row));
                assert.ok(project > ui.inputSelectionTop);
                assert.ok(project > recent);
                assert.equal(hit.rowStart - 1, project);
                assert.match(plain[project], /~3 \+1 \?2/);
                assert.ok(plain.slice(hit.rowStart).every((row) => !row.includes("工作区")));
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

function launcherFrame(overrides = {}) {
  return buildStartupLauncher({
    width: 140,
    height: 40,
    cardRows: ["> "],
    sessions,
    selected: -1,
    state: { usedTokens: 0, maxTokens: 1000, costCny: 0, workspace },
    model: {
      permissionMode: "auto",
      modelName: "deepseek-v4-pro",
      providerName: "deepseek",
      reasoningEffort: "high",
    },
    ...overrides,
  });
}
const backgrounds = (rows) => new Set(rows.join("").match(/\x1b\[48;2;[\d;]+m/g) ?? []);

test("a session from the last 24 hours becomes a resume row above the card", () => {
  const fresh = sessions.map((session, index) => ({
    ...session,
    updatedAt: new Date(Date.now() - (index + 1) * 4 * 60_000).toISOString(),
  }));
  const frame = launcherFrame({ sessions: fresh });
  const plain = frame.rows.map(strip);
  const resumeRow = plain.findIndex((row) => row.includes("继续上次"));
  assert.ok(resumeRow >= 0 && resumeRow < frame.inputTop);
  assert.match(plain[resumeRow], /继续上次\s+会话 0 · 4 分钟前/);
  assert.equal(frame.hits.find((hit) => hit.index === 3).row, resumeRow);
  // 时间线只列剩下的会话，不重复「继续上次」那一条。
  assert.ok(!plain.slice(resumeRow + 1).some((row) => row.includes("会话 0")));
  assert.ok(plain.some((row) => /○\s+会话 1/.test(row)));
  const stale = launcherFrame().rows.map(strip);
  assert.ok(!stale.some((row) => row.includes("继续上次")));
  assert.ok(stale.some((row) => /●\s+会话 0/.test(row)));
});

test("继续上次下面给出停在哪：目标 · 任务进度 · 进行中，点这行同样是继续", () => {
  const fresh = sessions.map((session, index) => ({
    ...session,
    updatedAt: new Date(Date.now() - (index + 1) * 4 * 60_000).toISOString(),
    ...(index === 0
      ? { progress: { goal: "首页加上下文", done: 2, total: 5, current: "写测试" } }
      : {}),
  }));
  const frame = launcherFrame({ sessions: fresh });
  const plain = frame.rows.map(strip);
  const resumeRow = plain.findIndex((row) => row.includes("继续上次"));
  assert.match(plain[resumeRow + 1], /└ 目标 首页加上下文 · 任务 2\/5 · 进行中 写测试/);
  assert.ok(resumeRow + 1 < frame.inputTop);
  const rowsForResume = frame.hits.filter((hit) => hit.index === 3).map((hit) => hit.row);
  assert.deepEqual(rowsForResume, [resumeRow, resumeRow + 1]);

  // 变矮时进度行先于「继续上次」让掉：进度行只会紧跟在继续上次下面出现，
  // 且存在「继续上次还在、进度行已让掉」的高度。
  let droppedFirst = false;
  for (let height = 12; height <= 40; height++) {
    const rows = launcherFrame({ sessions: fresh, height }).rows.map(strip);
    const resume = rows.findIndex((row) => row.includes("继续上次"));
    const detail = rows.findIndex((row) => row.includes("└ 目标"));
    if (detail >= 0) assert.equal(detail, resume + 1, `height ${height}`);
    if (resume >= 0 && detail < 0) droppedFirst = true;
  }
  assert.ok(droppedFirst);

  // 没有进度信息就不出这行。
  const bare = launcherFrame({
    sessions: fresh.map(({ progress, ...rest }) => rest),
  }).rows.map(strip);
  assert.ok(!bare.some((row) => row.includes("└")));
});

test("buildSessionProgress / formatResumeDetail：只取进行中的目标，窄宽度逐级降级", () => {
  const plan = {
    tasks: [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ],
    completedTasks: [{}, {}],
  };
  assert.deepEqual(buildSessionProgress({ text: "目标", status: "active" }, plan), {
    goal: "目标",
    total: 5,
    done: 3,
    current: "b",
  });
  assert.deepEqual(buildSessionProgress({ text: "目标", status: "achieved" }, null), undefined);
  assert.equal(buildSessionProgress(undefined, { tasks: [], completedTasks: [] }), undefined);

  const progress = { goal: "把首页做得有用", done: 3, total: 5, current: "补测试" };
  assert.equal(formatResumeDetail(progress, 80), "目标 把首页做得有用 · 任务 3/5 · 进行中 补测试");
  assert.equal(formatResumeDetail(progress, 30), "目标 把首页做得有用 · 任务 3/5");
  assert.equal(formatResumeDetail(progress, 12), "任务 3/5");
  const clipped = formatResumeDetail({ goal: "很长很长的目标原文" }, 10);
  assert.ok(clipped.startsWith("目标 很长") && clipped.length < "目标 很长很长的目标原文".length);
  assert.equal(formatResumeDetail(undefined, 80), "");
});

test("glow paints only on truecolor with a known background; motion settles into the static frame", (t) => {
  const previous = getColorLevel();
  t.after(() => {
    setColorLevel(previous);
    setThemePreset("default");
  });
  setColorLevel("truecolor");
  setThemePreset("default");
  // 主题跟随终端底色且没探测到：不画光晕，只剩卡片 / 入口这几种底色。
  const plain = backgrounds(launcherFrame().rows).size;
  assert.ok(plain <= 6, `无光晕时底色种类过多：${plain}`);
  parseOsc11Reply("\x1b]11;rgb:1515/1414/1b1b\x07");
  const glowing = backgrounds(launcherFrame().rows).size;
  assert.ok(glowing > plain + 10, `光晕应带来渐变底色：${glowing}`);
  setColorLevel("ansi256");
  assert.equal(
    launcherFrame()
      .rows.join("")
      .match(/\x1b\[48;2;/g),
    null,
    "256 色不输出真彩色底色",
  );
  setColorLevel("truecolor");
  const moving = launcherFrame({ motionElapsed: 200 });
  assert.equal(moving.animating, true);
  assert.ok(!hasTagline(moving.rows.map(strip)), "动效早期标语仍在解码");
  const settled = launcherFrame({ motionElapsed: 5000 });
  assert.equal(settled.animating, false);
  assert.deepEqual(settled.rows, launcherFrame().rows);
});

test("startup motion is opt-in, schedules frames while playing and honors HAJI_REDUCED_MOTION", (t) => {
  const keys = ["HAJI_REDUCED_MOTION", "HAJI_DISPLAY", "SSH_CONNECTION", "SSH_TTY"];
  const saved = keys.map((key) => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // 轻量显示（SSH 会话或 HAJI_DISPLAY=lite）会关掉启动动效，这里先固定成全量显示。
  process.env.HAJI_DISPLAY = "full";
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  withUI(140, 40, (ui) => {
    assert.equal(ui.startupMotionTimer, null);
    ui.options.startupMotion = true;
    ui.renderFrame();
    assert.ok(ui.startupMotionTimer);
    clearTimeout(ui.startupMotionTimer);
    ui.startupMotionTimer = null;
    ui.startupMotionStartedAt = Date.now() - 10_000;
    ui.renderFrame();
    assert.equal(ui.startupMotionTimer, null);
    assert.ok(hasTagline(ui.renderedScreenRows.map(strip)));
  });
  process.env.HAJI_REDUCED_MOTION = "1";
  withUI(140, 40, (ui) => {
    ui.options.startupMotion = true;
    ui.renderFrame();
    assert.equal(ui.startupMotionTimer, null);
  });
  // 轻量显示（远端 SSH / HAJI_DISPLAY=lite）不开启动动效，画面直接静止。
  delete process.env.HAJI_REDUCED_MOTION;
  process.env.HAJI_DISPLAY = "lite";
  withUI(140, 40, (ui) => {
    ui.options.startupMotion = true;
    ui.renderFrame();
    assert.equal(ui.startupMotionTimer, null);
    assert.ok(hasTagline(ui.renderedScreenRows.map(strip)));
  });
});

test("cell canvas keeps surface backgrounds through theme resets and handles wide characters", (t) => {
  const previous = getColorLevel();
  t.after(() => setColorLevel(previous));
  setColorLevel("truecolor");
  const canvas = new CellCanvas(12, 2);
  const card = "\x1b[48;2;1;2;3m";
  canvas.fill(0, 0, 12, 1, card);
  canvas.ansi(1, 0, "\x1b[1ma\x1b[0mb中\x1b[49mc", card);
  canvas.backdrop = (column, row) => (row === 1 && column < 3 ? "\x1b[48;2;9;9;9m" : undefined);
  canvas.text(10, 1, "中文");
  const [first, second] = canvas.toRows();
  assert.equal(strip(first).trimEnd(), " ab中c");
  // themeReset / SGR 49 之后的格子仍铺着卡片底色。
  assert.equal(first.split(card).length - 1 >= 2, true);
  assert.ok(!first.slice(0, first.lastIndexOf("\x1b[0m")).includes("\x1b[49m"));
  assert.match(second, /\x1b\[48;2;9;9;9m/);
  // 放不下整个宽字符时不写半个。
  assert.ok(!strip(second).includes("文"));
  setColorLevel("mono");
  const mono = new CellCanvas(6, 1);
  mono.ansi(0, 0, "\x1b[7mab\x1b[27mc");
  assert.equal(mono.toRows()[0], "\x1b[0;7mab\x1b[0mc\x1b[0m");
});
