import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalUI } from '../dist/terminal-input.js';

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const FRAME_SIZES = [
  [20, 8],
  [24, 12],
  [40, 12],
  [60, 24],
  [80, 24],
  [120, 40]
];

function stripAnsi(value) {
  return value.replace(ANSI_RE, '');
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
    columns: Object.getOwnPropertyDescriptor(target, 'columns'),
    rows: Object.getOwnPropertyDescriptor(target, 'rows'),
    write: Object.getOwnPropertyDescriptor(target, 'write')
  };
  const writes = [];

  try {
    Object.defineProperty(target, 'columns', {
      configurable: true,
      value: columns
    });
    Object.defineProperty(target, 'rows', {
      configurable: true,
      value: rows
    });
    Object.defineProperty(target, 'write', {
      configurable: true,
      value: chunk => {
        writes.push(String(chunk));
        return true;
      }
    });
    return callback(writes);
  } finally {
    restoreProperty(target, 'write', descriptors.write);
    restoreProperty(target, 'rows', descriptors.rows);
    restoreProperty(target, 'columns', descriptors.columns);
  }
}

function createTerminalUI() {
  const ui = new TerminalUI({
    header: 'HAJI TERMINAL',
    compactHeader: 'HAJI',
    inputPrompt: '> ',
    continuationPrompt: '  ',
    renderBorder: width => '-'.repeat(width)
  });

  // TypeScript private members compile to ordinary properties. Tests set the
  // minimum deterministic state directly so start()/close() never touch the
  // real terminal raw mode or alternate screen.
  ui.interactive = true;
  ui.started = true;
  ui.startupHeaderVisible = false;
  ui.permissionMode = 'default';
  ui.modelName = 'test-model';
  ui.reasoningEffort = 'low';
  ui.currentPath = 'C:\\workspace';
  ui.usedTokens = 250;
  ui.maxTokens = 1000;
  ui.activeInput = {
    prompt: '> ',
    continuationPrompt: '  ',
    graphemes: [...'INPUT'],
    cursorIndex: 5,
    sensitive: false,
    slashCommands: [],
    selectedCommandIndex: 0,
    historyNavigationActive: false,
    resolve() {},
    reject() {}
  };
  return ui;
}

function cleanupTerminalUI(ui) {
  if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
  if (ui.protocolFlushTimer) clearTimeout(ui.protocolFlushTimer);
  if (ui.agentPanelTimer) clearInterval(ui.agentPanelTimer);
  if (ui.selectionAutoScrollTimer) clearInterval(ui.selectionAutoScrollTimer);
  ui.streamRenderTimer = null;
  ui.protocolFlushTimer = null;
  ui.agentPanelTimer = null;
  ui.selectionAutoScrollTimer = null;
  ui.started = false;
  ui.interactive = false;
}

function renderFrame(columns, rows, configure = () => {}) {
  return withFakeStdout(columns, rows, writes => {
    const ui = createTerminalUI();
    try {
      configure(ui);
      ui.renderFrame();
      return {
        ui,
        writes: [...writes],
        screenRows: [...ui.renderedScreenRows],
        plainRows: ui.renderedScreenRows.map(stripAnsi)
      };
    } finally {
      cleanupTerminalUI(ui);
    }
  });
}

test('renders bounded frames with the input and status bar at all target sizes', () => {
  for (const [columns, rows] of FRAME_SIZES) {
    const frame = renderFrame(columns, rows, ui => {
      ui.chatContent = 'CHAT LINE';
    });

    assert.equal(frame.screenRows.length, rows, `${columns}x${rows} row count`);
    assert.ok(frame.plainRows.some(row => row.includes('INPUT')), `${columns}x${rows} input`);
    assert.ok(frame.plainRows.some(row => row.includes('ctx')), `${columns}x${rows} status bar`);
    assert.ok(frame.writes.length > 0, `${columns}x${rows} writes a frame`);

    for (const row of frame.plainRows) {
      if (/^[\x00-\x7f]*$/.test(row)) {
        assert.ok(
          row.length <= columns - 1,
          `${columns}x${rows} ASCII row width ${row.length}: ${JSON.stringify(row)}`
        );
      }
    }
  }
});

test('prioritizes the input on terminals only one to three rows tall', () => {
  for (const rows of [1, 2, 3]) {
    const frame = renderFrame(20, rows, ui => {
      ui.chatContent = 'CHAT_SENTINEL';
      ui.queueText = 'QUEUE_SENTINEL';
      ui.status = 'ACTIVITY_SENTINEL';
    });

    assert.equal(frame.screenRows.length, rows, `20x${rows} row count`);
    assert.ok(frame.plainRows.some(row => row.includes('INPUT')), `20x${rows} input`);
    if (rows >= 2) {
      assert.ok(frame.plainRows.some(row => row.includes('ctx')), `20x${rows} status bar`);
    }
  }
});

test('adds breathing room around the input and keeps the cursor on the text row', () => {
  const frame = renderFrame(80, 24);
  const inputRow = frame.plainRows.findIndex(row => row.includes('INPUT'));
  assert.ok(inputRow > 0);
  assert.equal(frame.plainRows[inputRow - 1], '');
  assert.equal(frame.plainRows[inputRow + 1], '');

  const cursorMatch = /\x1b\[(\d+);(\d+)H/.exec(frame.ui.renderedCursorState);
  assert.ok(cursorMatch, 'cursor position is rendered');
  assert.equal(Number(cursorMatch[1]), inputRow + 1);
});

test('accepts a multi-character Unicode commit from the terminal host', () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.handleKeypress('中文🙂', {});
      assert.equal(ui.activeInput.graphemes.join(''), 'INPUT中文🙂');
      assert.equal(ui.activeInput.cursorIndex, 8);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test('renders transient activity on the fixed track above input without persisting it', () => {
  const chatContent = 'CHAT_SENTINEL';
  const frame = renderFrame(80, 24, ui => {
    ui.chatContent = chatContent;
    ui.status = 'ACTIVITY_SENTINEL';
  });

  const chatRow = frame.plainRows.findIndex(row => row.includes('CHAT_SENTINEL'));
  const activityRow = frame.plainRows.findIndex(row => row.includes('ACTIVITY_SENTINEL'));
  const inputRow = frame.plainRows.findIndex(row => row.includes('INPUT'));
  assert.ok(activityRow > chatRow, 'activity stays below chat content');
  assert.equal(activityRow, inputRow - 1, 'activity owns the fixed row directly above input');
  assert.equal(frame.ui.chatContent, chatContent);
  assert.doesNotMatch(frame.ui.chatContent, /ACTIVITY_SENTINEL/);
});

test('renders animated observability with phase, meter, elapsed time and detail', () => {
  const chatContent = 'CHAT_SENTINEL';
  const frame = renderFrame(80, 24, ui => {
    ui.chatContent = chatContent;
    ui.activityFrame = {
      phase: 'tool',
      tone: 'waiting',
      icon: '⠹',
      label: '执行工具',
      meter: '··▱▰▱··',
      elapsed: '18s',
      detail: 'grep: 读取结果',
      idleText: '13s 无新事件'
    };
  });

  const screen = frame.plainRows.join('\n');
  assert.match(screen, /执行工具/);
  assert.match(screen, /等待新事件/);
  assert.match(screen, /18s/);
  assert.match(screen, /grep: 读取结果/);
  assert.equal(frame.ui.chatContent, chatContent);
});

test('status animation preserves a scrolled-up chat viewport', () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.chatContent = Array.from({ length: 80 }, (_, index) => `history ${index}`).join('\n');
      ui.renderFrame();
      ui.chatScrollOffset = 7;
      ui.renderFrame();
      const visibleStart = ui.chatViewport.visibleStart;
      const wrappedChat = ui.cachedWrappedChat;

      ui.status = 'THINKING_FRAME_1';
      ui.renderFrame();
      assert.equal(ui.chatViewport.visibleStart, visibleStart, 'adding status does not move historical content');
      assert.equal(ui.cachedWrappedChat, wrappedChat, 'activity does not invalidate wrapped chat rows');

      ui.status = 'THINKING_FRAME_2';
      ui.renderFrame();
      assert.equal(ui.chatViewport.visibleStart, visibleStart, 'spinner updates do not move historical content');
      assert.equal(ui.cachedWrappedChat, wrappedChat, 'animation reuses the chat layout cache');

      ui.status = '';
      ui.renderFrame();
      assert.equal(ui.chatViewport.visibleStart, visibleStart, 'clearing status does not move historical content');
      assert.equal(ui.cachedWrappedChat, wrappedChat, 'clearing activity keeps the chat layout cache');
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test('activity detail progressively compacts on narrow terminals', () => {
  const createActivity = ui => {
    ui.activityFrame = {
      phase: 'tool',
      tone: 'waiting',
      icon: '⠹',
      label: '执行工具',
      meter: '··▱▰▱··',
      elapsed: '18s',
      detail: 'grep: a/very/long/path/source.ts',
      idleText: '13s 无新事件'
    };
  };
  const wide = renderFrame(80, 24, createActivity).plainRows.join('\n');
  const compact = renderFrame(50, 24, createActivity).plainRows.join('\n');
  const narrow = renderFrame(30, 24, createActivity).plainRows.join('\n');

  assert.match(wide, /grep: a\/very\/long\/path/);
  assert.match(compact, /等待新事件/);
  assert.doesNotMatch(compact, /a\/very\/long\/path/);
  assert.match(narrow, /执行工具/);
  assert.match(narrow, /18s/);
  assert.doesNotMatch(narrow, /等待新事件|··▱▰▱··/);
});

test('an animation tick repaints only the fixed activity row', () => {
  withFakeStdout(80, 24, writes => {
    const ui = createTerminalUI();
    try {
      ui.chatContent = Array.from({ length: 40 }, (_, index) => `history ${index}`).join('\n');
      ui.activityFrame = {
        phase: 'thinking',
        tone: 'active',
        icon: '✦',
        label: '思考中',
        meter: '▰▱·····',
        elapsed: '1s'
      };
      ui.renderFrame();
      writes.length = 0;

      ui.activityFrame = {
        ...ui.activityFrame,
        icon: '✧',
        meter: '▱▰▱····',
        elapsed: '2s'
      };
      ui.renderFrame();

      const update = writes.join('');
      const paintedRows = [...update.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1]));
      assert.equal(new Set(paintedRows).size, 1, `unexpected repaint rows: ${paintedRows.join(', ')}`);
      assert.doesNotMatch(update, /history|INPUT|ctx/);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test('shows the history distance hint and Ctrl+End returns an active input to the bottom', () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    try {
      ui.chatContent = Array.from({ length: 80 }, (_, index) => `history ${index}`).join('\n');
      // Establish the wrapped-document cache at the bottom before moving the
      // viewport. This mirrors user scrolling after history has rendered.
      ui.renderFrame();
      ui.chatScrollOffset = 7;
      ui.renderFrame();

      const screen = ui.renderedScreenRows.map(stripAnsi).join('\n');
      assert.match(screen, /距底部/);
      assert.match(screen, /Ctrl\+End/);
      assert.equal(ui.chatScrollOffset, 7);

      ui.handleKeypress('', { name: 'end', ctrl: true });
      assert.equal(ui.chatScrollOffset, 0);

      ui.activeInput = undefined;
      ui.activeSelection = {
        options: {
          prompt: '选择',
          items: [{ label: '一', value: 'one' }]
        },
        selectedIndex: 0,
        secondaryIndex: 0,
        resolve() {},
        reject() {}
      };
      ui.chatScrollOffset = 5;
      ui.handleSelectionKeypress('', { name: 'end', ctrl: true });
      assert.equal(ui.chatScrollOffset, 0);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});

test('Escape cancels an active selector and still reaches the turn abort callback', () => {
  withFakeStdout(80, 24, () => {
    const ui = createTerminalUI();
    let selectionError;
    let abortCalls = 0;
    try {
      ui.activeInput = undefined;
      ui.activeSelection = {
        options: {
          prompt: '授权',
          items: [{ label: '否', value: 'no' }]
        },
        selectedIndex: 0,
        secondaryIndex: 0,
        resolve() {},
        reject(error) { selectionError = error; }
      };
      ui.onEsc(() => { abortCalls += 1; });

      ui.handleSelectionKeypress('', { name: 'escape' });

      assert.equal(ui.activeSelection, undefined);
      assert.equal(selectionError?.name, 'TerminalInputCancelledError');
      assert.equal(abortCalls, 1);
    } finally {
      cleanupTerminalUI(ui);
    }
  });
});
