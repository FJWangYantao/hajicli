import assert from "node:assert/strict";
import test from "node:test";

import { TerminalUI } from "../dist/terminal-input.js";
import { terminalWidth } from "../dist/terminal-text.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const FRAME_SIZES = [
  [20, 8],
  [24, 12],
  [40, 12],
  [60, 24],
  [80, 24],
  [120, 40],
];

function stripAnsi(value) {
  return value.replace(ANSI_RE, "");
}

function restoreProperty(target, name, descriptor) {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    delete target[name];
  }
}

function withFakeStdout(columns, rows, callback) {
  const target = process.stdout;
  const descriptors = {
    columns: Object.getOwnPropertyDescriptor(target, "columns"),
    rows: Object.getOwnPropertyDescriptor(target, "rows"),
    write: Object.getOwnPropertyDescriptor(target, "write"),
  };
  const writes = [];

  try {
    Object.defineProperty(target, "columns", {
      configurable: true,
      value: columns,
    });
    Object.defineProperty(target, "rows", {
      configurable: true,
      value: rows,
    });
    Object.defineProperty(target, "write", {
      configurable: true,
      value: (chunk) => {
        writes.push(String(chunk));
        return true;
      },
    });
    return callback(writes);
  } finally {
    restoreProperty(target, "write", descriptors.write);
    restoreProperty(target, "rows", descriptors.rows);
    restoreProperty(target, "columns", descriptors.columns);
  }
}

function createTerminalUI() {
  const ui = new TerminalUI({
    header: "HAJI TERMINAL",
    compactHeader: "HAJI",
    inputPrompt: "> ",
    continuationPrompt: "  ",
    renderBorder: (width) => "-".repeat(width),
  });

  // TypeScript private members compile to ordinary properties. Tests set the
  // minimum deterministic state directly so start()/close() never touch the
  // real terminal raw mode or alternate screen.
  ui.interactive = true;
  ui.started = true;
  ui.startupHeaderVisible = false;
  ui.permissionMode = "default";
  ui.modelName = "test-model";
  ui.reasoningEffort = "low";
  ui.currentPath = "C:\\workspace";
  ui.usedTokens = 250;
  ui.maxTokens = 1000;
  ui.activeInput = {
    prompt: "> ",
    continuationPrompt: "  ",
    graphemes: [..."INPUT"],
    cursorIndex: 5,
    sensitive: false,
    slashCommands: [],
    selectedCommandIndex: 0,
    historyNavigationActive: false,
    resolve() {},
    reject() {},
  };
  return ui;
}

function cleanupTerminalUI(ui) {
  if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
  if (ui.protocolFlushTimer) clearTimeout(ui.protocolFlushTimer);
  if (ui.agentPanelTimer) clearInterval(ui.agentPanelTimer);
  if (ui.selectionAutoScrollTimer) clearInterval(ui.selectionAutoScrollTimer);
  if (ui.copiedNoticeTimer) clearTimeout(ui.copiedNoticeTimer);
  ui.streamRenderTimer = null;
  ui.protocolFlushTimer = null;
  ui.agentPanelTimer = null;
  ui.selectionAutoScrollTimer = null;
  ui.copiedNoticeTimer = null;
  ui.started = false;
  ui.interactive = false;
}

function renderFrame(columns, rows, configure = () => {}) {
  return withFakeStdout(columns, rows, (writes) => {
    const ui = createTerminalUI();
    try {
      configure(ui);
      ui.renderFrame();
      return {
        ui,
        writes: [...writes],
        screenRows: [...ui.renderedScreenRows],
        plainRows: ui.renderedScreenRows.map(stripAnsi),
      };
    } finally {
      cleanupTerminalUI(ui);
    }
  });
}

test("侧栏分割线在推理预览含 emoji 时保持对齐", () => {
  // 推理预览是纯文本行，模型常在里面写 ✅/⏳/⚠️。如果宽度算少 1 列，
  // 行就比终端宽，右侧 │ 会随行偏移、行尾还会被软换行顶到下一行。
  const frame = renderFrame(120, 30, (ui) => {
    ui.setSidebarEnabled(true);
    ui.chatContent = "CHAT LINE";
    ui.setLiveTail("  ┊ 推理 ✅ 已完成 ⏳ 等待 ⚠️ 注意 ✅\n");
    ui.setActivity({
      phase: "thinking",
      tone: "active",
      icon: "✦",
      label: "思考中",
      elapsed: "3s",
      detail: "推理约 1.2K tokens",
    });
  });
  const chatRows = frame.plainRows.filter((row) => row.includes("│"));
  assert.ok(chatRows.length > 0, "sidebar is rendered");
  const columns = new Set();
  for (const row of chatRows) {
    assert.equal(terminalWidth(row), 119, `row width: ${JSON.stringify(row)}`);
    // 按显示列（不是 UTF-16 下标）定位分割线：中文占 2 列、emoji 占 2 列。
    columns.add(terminalWidth(row.slice(0, row.indexOf("│"))));
  }
  assert.equal(columns.size, 1, `separator columns: ${[...columns].join(", ")}`);
  assert.ok(
    chatRows.some((row) => row.includes("✅")),
    "reasoning preview with emoji is on screen",
  );
});

test("renders bounded frames with the input and status bar at all target sizes", () => {
  for (const [columns, rows] of FRAME_SIZES) {
    const frame = renderFrame(columns, rows, (ui) => {
      ui.chatContent = "CHAT LINE";
    });

    assert.equal(frame.screenRows.length, rows, `${columns}x${rows} row count`);
    assert.ok(
      frame.plainRows.some((row) => row.includes("INPUT")),
      `${columns}x${rows} input`,
    );
    assert.ok(
      frame.plainRows.some((row) => row.includes("[默认]")),
      `${columns}x${rows} status bar`,
    );
    assert.ok(frame.writes.length > 0, `${columns}x${rows} writes a frame`);

    for (const row of frame.plainRows) {
      if (/^[\x00-\x7f]*$/.test(row)) {
        assert.ok(
          row.length <= columns - 1,
          `${columns}x${rows} ASCII row width ${row.length}: ${JSON.stringify(row)}`,
        );
      }
    }
  }
});

test("prioritizes the input on terminals only one to three rows tall", () => {
  for (const rows of [1, 2, 3]) {
    const frame = renderFrame(20, rows, (ui) => {
      ui.chatContent = "CHAT_SENTINEL";
      ui.queueText = "QUEUE_SENTINEL";
      ui.status = "ACTIVITY_SENTINEL";
    });

    assert.equal(frame.screenRows.length, rows, `20x${rows} row count`);
    assert.ok(
      frame.plainRows.some((row) => row.includes("INPUT")),
      `20x${rows} input`,
    );
    if (rows >= 2) {
      assert.ok(
        frame.plainRows.some((row) => row.includes("[默认]")),
        `20x${rows} status bar`,
      );
    }
  }
});

test("keeps the input compact and the cursor on the text row", () => {
  const frame = renderFrame(80, 24);
  const inputRow = frame.plainRows.findIndex((row) => row.includes("INPUT"));
  assert.ok(inputRow > 0);
  // 输入区上下各一条分隔线：输入行紧贴顶部分隔线，底部再一条分隔线后接状态栏。
  assert.match(frame.plainRows[inputRow - 1], /^-+$/, "divider sits directly above the input");
  assert.match(frame.plainRows[inputRow + 1], /^-+$/, "divider sits directly below the input");
  assert.ok(
    frame.plainRows[inputRow + 2].includes("[默认]"),
    "status bar sits below the bottom divider",
  );

  const cursorMatch = /\x1b\[(\d+);(\d+)H/.exec(frame.ui.renderedCursorState);
  assert.ok(cursorMatch, "cursor position is rendered");
  assert.equal(Number(cursorMatch[1]), inputRow + 1);
});

test("粘贴的图片 chip 行压在输入行上方，光标仍在文字行", () => {
  const frame = renderFrame(80, 24, (ui) => {
    ui.pendingImages = [
      { path: ".haji/attachments/paste-1.png", displayName: "paste-1.png", bytes: 12 },
    ];
  });

  const inputRow = frame.plainRows.findIndex((row) => row.includes("INPUT"));
  assert.match(frame.plainRows[inputRow - 1], /\[paste-1\.png\]/, "chip row sits above the text");
  assert.match(frame.plainRows[inputRow - 2], /^-+$/, "top divider stays above the chip row");
  assert.match(frame.plainRows[inputRow + 1], /^-+$/, "bottom divider stays below the text");

  const cursorMatch = /\x1b\[(\d+);(\d+)H/.exec(frame.ui.renderedCursorState);
  assert.ok(cursorMatch, "cursor position is rendered");
  assert.equal(Number(cursorMatch[1]), inputRow + 1, "cursor stays on the text row");
});

test("accepts a multi-character Unicode commit from the terminal host", () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.handleKeypress("中文🙂", {});
      assert.equal(ui.activeInput.graphemes.join(""), "INPUT中文🙂");
      assert.equal(ui.activeInput.cursorIndex, 8);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test("renders transient activity in the bottom line without persisting it", () => {
  const chatContent = "CHAT_SENTINEL";
  const frame = renderFrame(80, 24, (ui) => {
    ui.chatContent = chatContent;
    ui.status = "ACTIVITY_SENTINEL";
  });

  const chatRow = frame.plainRows.findIndex((row) => row.includes("CHAT_SENTINEL"));
  const activityRow = frame.plainRows.findIndex((row) => row.includes("ACTIVITY_SENTINEL"));
  const inputRow = frame.plainRows.findIndex((row) => row.includes("INPUT"));
  assert.ok(activityRow > chatRow, "activity stays below chat content");
  // 活动状态与状态栏共用底部一行：位于输入行下方的底部分隔线之后。
  assert.equal(activityRow, inputRow + 2, "activity takes over the status line below input");
  assert.match(frame.plainRows[inputRow + 1], /^-+$/, "bottom divider stays above the activity");
  assert.equal(activityRow, frame.plainRows.length - 1, "activity is the last screen row");
  assert.equal(frame.ui.chatContent, chatContent);
  assert.doesNotMatch(frame.ui.chatContent, /ACTIVITY_SENTINEL/);
});

test("renders animated observability with phase, elapsed time and detail", () => {
  const chatContent = "CHAT_SENTINEL";
  const frame = renderFrame(80, 24, (ui) => {
    ui.chatContent = chatContent;
    ui.activityFrame = {
      phase: "tool",
      tone: "waiting",
      icon: "⠹",
      label: "执行工具",
      elapsed: "18s",
      detail: "grep: 读取结果",
      idleText: "13s 无新进展",
    };
  });

  const screen = frame.plainRows.join("\n");
  assert.match(screen, /执行工具/);
  assert.match(screen, /18s · 13s 无新进展 · grep: 读取结果/);
  assert.doesNotMatch(screen, /等待新事件/, "tone is conveyed by color, not repeated text");
  assert.match(screen, /18s/);
  assert.match(screen, /grep: 读取结果/);
  assert.equal(frame.ui.chatContent, chatContent);
});

test("status animation preserves a scrolled-up chat viewport", () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.chatContent = Array.from({ length: 80 }, (_, index) => `history ${index}`).join("\n");
      ui.renderFrame();
      ui.chatScrollOffset = 7;
      ui.renderFrame();
      const visibleStart = ui.chatViewport.visibleStart;
      const wrappedChat = ui.cachedWrappedChat;

      ui.status = "THINKING_FRAME_1";
      ui.renderFrame();
      assert.equal(
        ui.chatViewport.visibleStart,
        visibleStart,
        "adding status does not move historical content",
      );
      assert.equal(
        ui.cachedWrappedChat,
        wrappedChat,
        "activity does not invalidate wrapped chat rows",
      );

      ui.status = "THINKING_FRAME_2";
      ui.renderFrame();
      assert.equal(
        ui.chatViewport.visibleStart,
        visibleStart,
        "spinner updates do not move historical content",
      );
      assert.equal(ui.cachedWrappedChat, wrappedChat, "animation reuses the chat layout cache");

      ui.status = "";
      ui.renderFrame();
      assert.equal(
        ui.chatViewport.visibleStart,
        visibleStart,
        "clearing status does not move historical content",
      );
      assert.equal(
        ui.cachedWrappedChat,
        wrappedChat,
        "clearing activity keeps the chat layout cache",
      );
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test("activity detail progressively compacts on narrow terminals", () => {
  const createActivity = (ui) => {
    ui.activityFrame = {
      phase: "tool",
      tone: "waiting",
      icon: "⠹",
      label: "执行工具",
      elapsed: "18s",
      detail: "grep: a/very/long/path/source.ts",
      idleText: "13s 无新进展",
    };
  };
  const stalled = (ui) => {
    createActivity(ui);
    ui.activityFrame.tone = "stalled";
  };
  const wide = renderFrame(80, 24, createActivity).plainRows.join("\n");
  const compact = renderFrame(50, 24, createActivity).plainRows.join("\n");
  const narrow = renderFrame(30, 24, createActivity).plainRows.join("\n");

  assert.match(wide, /grep: a\/very\/long\/path/);
  assert.match(compact, /执行工具 {2}18s/);
  assert.doesNotMatch(compact, /a\/very\/long\/path/);
  assert.match(renderFrame(50, 24, stalled).plainRows.join("\n"), /执行工具 {2}18s · 等待较久/);
  assert.match(narrow, /执行工具/);
  assert.match(narrow, /18s/);
  assert.doesNotMatch(renderFrame(30, 24, stalled).plainRows.join("\n"), /等待较久/);
});

test("an animation tick repaints only the fixed activity row", () => {
  withFakeStdout(80, 24, (writes) => {
    const ui = createTerminalUI();
    try {
      ui.chatContent = Array.from({ length: 40 }, (_, index) => `history ${index}`).join("\n");
      ui.activityFrame = {
        phase: "thinking",
        tone: "active",
        icon: "✦",
        label: "思考中",
        elapsed: "1s",
        startedAt: Date.now() - 1000,
      };
      ui.renderFrame();
      writes.length = 0;

      ui.activityFrame = {
        ...ui.activityFrame,
        icon: "✧",
        elapsed: "2s",
      };
      ui.renderFrame();

      const update = writes.join("");
      const paintedRows = [...update.matchAll(/\x1b\[(\d+);1H/g)].map((match) => Number(match[1]));
      assert.equal(
        new Set(paintedRows).size,
        1,
        `unexpected repaint rows: ${paintedRows.join(", ")}`,
      );
      // 右侧徽标（[默认] ctx N%）属于活动行本身；history 与 INPUT 行不得重绘。
      assert.doesNotMatch(update, /history|INPUT/);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test("shows the history distance hint and Ctrl+End returns an active input to the bottom", () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.chatContent = Array.from({ length: 80 }, (_, index) => `history ${index}`).join("\n");
      // Establish the wrapped-document cache at the bottom before moving the
      // viewport. This mirrors user scrolling after history has rendered.
      ui.renderFrame();
      ui.chatScrollOffset = 7;
      ui.renderFrame();

      const screen = ui.renderedScreenRows.map(stripAnsi).join("\n");
      assert.match(screen, /距底部/);
      assert.match(screen, /Ctrl\+End/);
      assert.equal(ui.chatScrollOffset, 7);

      ui.handleKeypress("", { name: "end", ctrl: true });
      assert.equal(ui.chatScrollOffset, 0);

      ui.activeInput = undefined;
      ui.activeSelection = {
        options: {
          prompt: "选择",
          items: [{ label: "一", value: "one" }],
        },
        selectedIndex: 0,
        secondaryIndex: 0,
        resolve() {},
        reject() {},
      };
      ui.chatScrollOffset = 5;
      ui.handleSelectionKeypress("", { name: "end", ctrl: true });
      assert.equal(ui.chatScrollOffset, 0);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test("Escape cancels an active selector and still reaches the turn abort callback", () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    let selectionError;
    let abortCalls = 0;
    try {
      ui.activeInput = undefined;
      ui.activeSelection = {
        options: {
          prompt: "授权",
          items: [{ label: "否", value: "no" }],
        },
        selectedIndex: 0,
        secondaryIndex: 0,
        resolve() {},
        reject(error) {
          selectionError = error;
        },
      };
      ui.onEsc(() => {
        abortCalls += 1;
      });

      ui.handleSelectionKeypress("", { name: "escape" });

      assert.equal(ui.activeSelection, undefined);
      assert.equal(selectionError?.name, "TerminalInputCancelledError");
      assert.equal(abortCalls, 1);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test("the live tool tail renders below committed chat without entering the transcript", () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.chatContent = "assistant text\n";
      ui.setLiveTail("  ⠋ bash  make\n    │ compiling\n");
      ui.writeLine("NOTE written while the tool runs");
      ui.renderFrame();
      const screen = ui.renderedScreenRows.map(stripAnsi).join("\n");
      assert.match(
        screen,
        /assistant text\s+NOTE written while the tool runs\s+⠋ bash {2}make\s+│ compiling/,
      );
      assert.doesNotMatch(ui.chatContent, /compiling/);

      ui.setLiveTail("");
      ui.renderFrame();
      assert.doesNotMatch(ui.renderedScreenRows.map(stripAnsi).join("\n"), /compiling/);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test("live tool tail leaves a blank line between assistant text and the tool block", () => {
  // 正文经 updateChatFrom 写入时末尾没有换行；工具草稿/工具格出现时若只补一个换行，
  // 会紧贴在正文下一行。实时区域必须和正文之间隔一个空行。
  const frame = renderFrame(80, 24, (ui) => {
    ui.setSidebarEnabled(false);
    ui.chatContent = "assistant text";
    ui.setLiveTail("  ● bash  make\n");
  });
  const rows = frame.plainRows.map((row) => row.trim());
  const textIndex = rows.findIndex((row) => row.includes("assistant text"));
  const toolIndex = rows.findIndex((row) => row.includes("bash  make"));
  assert.ok(textIndex >= 0 && toolIndex > textIndex, "assistant text and tool tail are on screen");
  assert.equal(toolIndex - textIndex, 2, "exactly one blank line separates them");
  assert.equal(rows[textIndex + 1], "", "the separating row is blank");
});

test("writeBlankLine does not stack a second blank line on content that already ends blank", () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.writeChat("上一段\n\n");
      ui.writeBlankLine();
      assert.equal(ui.chatContent, "上一段\n\n");

      // 不以换行结尾时补成恰好一个空行。
      ui.writeChat("下一段");
      ui.writeBlankLine();
      assert.equal(ui.chatContent, "上一段\n\n下一段\n\n");
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test("activity row sits at the chat tail; the status bar stays on the bottom line", () => {
  const activity = (ui, startedAt = Date.now()) => {
    ui.activityFrame = {
      phase: "tool",
      tone: "active",
      icon: "⠋",
      label: "运行 bash",
      elapsed: "3s",
      startedAt,
    };
  };
  // 阶段开始后的前 3 秒：宽屏右侧显示“Esc 中止”。关掉右侧栏，只看对话区本身。
  const wide = renderFrame(120, 30, (ui) => {
    ui.setSidebarEnabled(false);
    ui.chatContent = "CHAT_SENTINEL";
    activity(ui, Date.now() - 1000);
  }).plainRows;
  assert.match(wide.join("\n"), /⠋ 运行 bash {2}3s +Esc 中止/);
  assert.doesNotMatch(wide.join("\n"), /[▰▱]/);
  const chatRow = wide.findIndex((row) => row.includes("CHAT_SENTINEL"));
  const activityRow = wide.findIndex((row) => row.includes("运行 bash"));
  const inputRow = wide.findIndex((row) => row.includes("INPUT"));
  assert.equal(activityRow, chatRow + 2, "activity follows the latest chat line after a blank row");
  assert.ok(activityRow < inputRow, "activity lives in the chat area above the input");
  assert.match(wide.at(-1), /\[默认\]/, "status bar keeps the bottom line during activity");
  // 3 秒后 Esc 提示消失；状态栏常驻底栏，底栏不再显示上下文用量。
  const settled = renderFrame(120, 30, (ui) => {
    ui.setSidebarEnabled(false);
    activity(ui, Date.now() - 5000);
  }).plainRows;
  const settledActivity = settled.find((row) => row.includes("运行 bash")) ?? "";
  assert.match(settledActivity, /⠋ 运行 bash {2}3s\s*$/);
  assert.doesNotMatch(settled.join("\n"), /Esc 中止/);
  assert.match(settled.at(-1), /\[默认\]/);
  // 窄屏不显示 Esc 提示，任务信息本身保留。
  const narrow = renderFrame(80, 24, (ui) => activity(ui, Date.now() - 1000)).plainRows.join("\n");
  assert.match(narrow, /⠋ 运行 bash {2}3s/);
  assert.doesNotMatch(narrow, /Esc 中止/);
});

test("minimal layout falls back to the activity row on the bottom line", () => {
  // 高度不足 10 行进入 minimal 档：对话区放不下尾部活动行，仍由它顶替状态栏。
  const frame = renderFrame(60, 9, (ui) => {
    ui.chatContent = "CHAT_SENTINEL";
    ui.activityFrame = {
      phase: "thinking",
      tone: "active",
      icon: "✦",
      label: "思考中",
      elapsed: "2s",
    };
  });
  const hits = frame.plainRows.filter((row) => row.includes("思考中"));
  assert.equal(hits.length, 1, "activity is rendered exactly once");
  assert.equal(
    frame.plainRows.findLastIndex((row) => row.includes("思考中")),
    8,
  );
  assert.doesNotMatch(frame.plainRows.join("\n"), /\[默认\]/);
});

function permissionSelection(overrides = {}) {
  const result = {};
  return {
    result,
    selection: {
      options: {
        title: "需要授权 · AI 请求运行命令",
        preview: ["for i in 1 2 3; do", "  echo $i", "done", "工作目录 ~/demo"],
        items: [
          { value: "once", label: "允许本次", hotkey: "y" },
          { value: "session", label: "本会话内总是允许 bash", hotkey: "a" },
          { value: "deny", label: "拒绝", hotkey: "n" },
        ],
        hint: "↑↓ 选择 · Enter 确认 · Esc 中止本轮",
        confirmDelayMs: 300,
        ...overrides,
      },
      openedAt: Date.now(),
      selectedIndex: 0,
      secondaryIndex: 0,
      resolve(value) {
        result.value = value.value;
      },
      reject(error) {
        result.error = error;
      },
    },
  };
}

test("permission card shows the full command preview above the choices", () => {
  const { selection } = permissionSelection();
  const frame = renderFrame(80, 24, (ui) => {
    ui.activeInput = undefined;
    ui.activeSelection = selection;
  });
  const screen = frame.plainRows.join("\n");
  assert.match(screen, /需要授权 · AI 请求运行命令 {2}↑↓ 选择 · Enter 确认 · Esc 中止本轮/);
  assert.match(screen, /│ for i in 1 2 3; do\n│ {3}echo \$i\n│ done\n│ 工作目录 ~\/demo/);
  assert.match(screen, /▸ 允许本次 \(y\)\n {2}本会话内总是允许 bash \(a\)\n {2}拒绝 \(n\)/);
});

test("permission card trims the preview on short terminals but keeps every choice", () => {
  const { selection } = permissionSelection({
    preview: Array.from({ length: 30 }, (_, index) => `line ${index}`),
  });
  const screen = renderFrame(80, 16, (ui) => {
    ui.activeInput = undefined;
    ui.activeSelection = selection;
  }).plainRows.join("\n");
  assert.match(screen, /│ … 另有 \d+ 行（窗口高度不足）/);
  assert.match(screen, /允许本次[\s\S]*本会话内总是允许 bash[\s\S]*拒绝/);
});

test("permission hotkeys and Enter are ignored right after the card appears", () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.activeInput = undefined;
      const { selection, result } = permissionSelection();
      ui.activeSelection = selection;
      ui.handleSelectionKeypress("\r", { name: "return" });
      ui.handleSelectionKeypress("y", { name: "y" });
      assert.equal(result.value, undefined, "early keystrokes do not approve");
      assert.ok(ui.activeSelection);

      selection.openedAt = Date.now() - 1_000;
      ui.handleSelectionKeypress("n", { name: "n" });
      assert.equal(result.value, "deny");
      assert.equal(ui.activeSelection, undefined);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test("status bar shrinks the path before cutting the model or effort", () => {
  const frame = renderFrame(100, 30, (ui) => {
    ui.providerName = "🔵 DeepSeek";
    ui.modelName = "deepseek-v4-flash";
    ui.reasoningEffort = "medium";
    ui.currentPath = "/tmp/a/very/long/workspace/path/that/does/not/fit/anywhere/demo";
  });
  const statusRow = frame.plainRows.at(-1);
  assert.match(statusRow, /🔵 DeepSeek · deepseek-v4-flash · medium {2}…/);
  assert.match(statusRow, /demo/);

  const narrow = renderFrame(44, 24, (ui) => {
    ui.modelName = "a-very-long-custom-model-name-v2";
    ui.reasoningEffort = "xhigh";
  }).plainRows.at(-1);
  assert.match(narrow, /a-very-long-custom.*… · xhigh/);
});

test("slash suggestions align descriptions and mark the selection with ▸", () => {
  const frame = renderFrame(80, 24, (ui) => {
    ui.activeInput.graphemes = ["/"];
    ui.activeInput.cursorIndex = 1;
    ui.activeInput.slashCommands = [
      { command: "/help", description: "显示帮助手册" },
      { command: "/compact", description: "多层上下文压缩" },
    ];
  });
  const screen = frame.plainRows.join("\n");
  assert.match(screen, /▸ \/help {5}显示帮助手册\n {2}\/compact {2}多层上下文压缩/);
});

test("selector items are truncated with an ellipsis", () => {
  const frame = renderFrame(40, 24, (ui) => {
    ui.activeInput = undefined;
    ui.activeSelection = {
      options: {
        title: "模型与配置",
        items: [
          {
            value: "e",
            label: "/effort",
            description: "切换思考强度（low/medium/high/xhigh/max）",
          },
        ],
      },
      selectedIndex: 0,
      secondaryIndex: 0,
      resolve() {},
      reject() {},
    };
  });
  assert.match(frame.plainRows.join("\n"), /▸ \/effort {2}切换思考强度.*…/);
});

test("粘贴的图片以 [文件名] chip 显示在文字输入行上方", () => {
  const frame = renderFrame(80, 24, (ui) => {
    ui.pendingImages = [
      { path: ".haji/attachments/paste-1.png", displayName: "paste-1.png", bytes: 2048 },
      { path: ".haji/attachments/paste-2.png", displayName: "paste-2.png", bytes: 4096 },
    ];
  });

  const inputIndex = frame.plainRows.findIndex((row) => row.includes("INPUT"));
  assert.ok(inputIndex > 0, "输入行存在");
  const chipRows = frame.plainRows.slice(0, inputIndex).filter((row) => row.includes("paste-"));
  assert.equal(chipRows.length, 1, "chip 只占一行");
  assert.match(chipRows[0], /\[paste-1\.png\]/);
  assert.match(chipRows[0], /\[paste-2\.png\]/);
  assert.ok(frame.plainRows[inputIndex - 1].includes("paste-1.png"), "chip 紧贴输入行上方");
  assert.match(
    frame.plainRows[inputIndex - 2],
    /^-+$/,
    "顶部分隔线在 chip 之上（chip 在输入框内）",
  );

  const cursorMatch = /\x1b\[(\d+);(\d+)H/.exec(frame.ui.renderedCursorState);
  assert.ok(cursorMatch, "cursor position is rendered");
  assert.equal(Number(cursorMatch[1]), inputIndex + 1, "光标仍在文字输入行");
});

test("复制角标贴在顶行右端，不占用底栏", () => {
  const frame = renderFrame(80, 24, (ui) => {
    ui.chatContent = "CHAT LINE";
    ui.copiedNotice = "Copied";
  });

  // 顶行是标题行（HAJI），角标贴在右端且整行宽度恰好等于安全宽度。
  assert.ok(frame.plainRows[0].endsWith("Copied"), "Copied 出现在右上角");
  assert.equal(frame.plainRows[0].length, 79);
  assert.ok(!frame.plainRows.slice(1).some((row) => row.includes("Copied")), "角标不落到其它行");
});

test("头部隐藏时复制角标退回底栏提示", () => {
  const frame = renderFrame(20, 8, (ui) => {
    ui.copiedNotice = "Copied";
  });

  assert.ok(
    frame.plainRows.some((row) => row.includes("Copied")),
    "矮终端仍能看到提示",
  );
  assert.ok(!frame.plainRows[0].includes("Copied"), "不覆盖对话首行");
});

test("鼠标拖选松开即自动复制，并保留高亮", async () => {
  await withFakeStdout(80, 24, async () => {
    const ui = createTerminalUI();
    try {
      ui.chatContent = "HELLO WORLD";
      ui.renderFrame();
      const viewport = ui.chatViewport;
      const row = viewport.screenTop;
      const column = viewport.padding + 1;
      let copied = "";
      ui.clipboardWriter.write = async (text) => {
        copied = text;
        return true;
      };

      ui.handleMouseEvent({ type: "mouse", action: "down", button: 0, column, row });
      ui.handleMouseEvent({ type: "mouse", action: "move", button: 32, column: column + 4, row });
      ui.handleMouseEvent({ type: "mouse", action: "up", button: 0, column: column + 4, row });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(copied, "HELLO");
      assert.equal(ui.copiedNotice, "Copied");
      assert.equal(ui.textSelection.active, true, "高亮保留，便于继续调整选区");
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});
