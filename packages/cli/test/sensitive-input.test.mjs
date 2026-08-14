import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalUI } from '../dist/terminal-input.js';

function createTerminalUI() {
  const ui = new TerminalUI({
    header: '',
    compactHeader: '',
    inputPrompt: '> ',
    renderBorder: width => '-'.repeat(width)
  });
  // TypeScript private fields remain ordinary properties at runtime. Force the
  // interactive branch without attaching listeners to the real test terminal.
  ui.interactive = true;
  return ui;
}

function stopScheduledRender(ui) {
  if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
  ui.streamRenderTimer = null;
  ui.renderScheduled = false;
}

function restoreProperty(target, name, descriptor) {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    delete target[name];
  }
}

async function withTtyState(stdinIsTTY, stdoutIsTTY, callback) {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinIsTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutIsTTY });
    return await callback();
  } finally {
    restoreProperty(process.stdout, 'isTTY', stdoutDescriptor);
    restoreProperty(process.stdin, 'isTTY', stdinDescriptor);
  }
}

test('sensitive input layout masks every grapheme without exposing the original value', async () => {
  const ui = createTerminalUI();
  const secret = 'sk-live-秘密🙂';
  const pending = ui.readInput({
    prompt: 'API Key: ',
    initialValue: secret,
    sensitive: true
  });

  const layout = ui.getInputLayout(80, 4);
  const rendered = layout.rows.join('\n');
  assert.equal(rendered.includes(secret), false);
  assert.equal([...rendered].filter(character => character === '•').length, ui.activeInput.graphemes.length);

  ui.finishInput();
  assert.equal(await pending, secret);
  stopScheduledRender(ui);
});

test('finishing sensitive input returns the original value without recording it in history', async () => {
  const ui = createTerminalUI();
  ui.inputHistory.record('previous command');
  const originalRecord = ui.inputHistory.record.bind(ui.inputHistory);
  const recorded = [];
  ui.inputHistory.record = value => {
    recorded.push(value);
    originalRecord(value);
  };

  const secret = 'private-token';
  const pending = ui.readInput({ initialValue: secret, sensitive: true });
  ui.finishInput();

  assert.equal(await pending, secret);
  assert.deepEqual(recorded, []);
  ui.inputHistory.begin('draft');
  assert.equal(ui.inputHistory.move(-1, 'draft'), 'previous command');
  stopScheduledRender(ui);
});

test('Ctrl+U clears sensitive input without writing it to the clipboard', async () => {
  const ui = createTerminalUI();
  let clipboardWrites = 0;
  ui.clipboardWriter.write = async () => {
    clipboardWrites += 1;
    return true;
  };

  const pending = ui.readInput({ initialValue: 'never-copy-this', sensitive: true });
  ui.dispatchKeypress('\x15', { ctrl: true, name: 'u' });

  assert.equal(clipboardWrites, 0);
  assert.deepEqual(ui.activeInput.graphemes, []);
  assert.equal(ui.activeInput.cursorIndex, 0);

  ui.finishInput();
  assert.equal(await pending, '');
  stopScheduledRender(ui);
});

test('sensitive input disables slash suggestions and history navigation', async () => {
  const ui = createTerminalUI();
  ui.inputHistory.record('history value');
  const pending = ui.readInput({
    initialValue: '/mo',
    sensitive: true,
    slashCommands: [{ command: '/model', description: '切换模型' }]
  });

  assert.deepEqual(ui.getCommandSuggestions(ui.activeInput), []);
  assert.deepEqual(ui.getCommandSuggestionRows(80, 4), []);

  ui.dispatchKeypress('', { name: 'up' });
  assert.equal(ui.activeInput.graphemes.join(''), '/mo');
  assert.equal(ui.activeInput.historyNavigationActive, false);

  ui.finishInput();
  assert.equal(await pending, '/mo');
  stopScheduledRender(ui);
});

test('legacy inline provider key is removed before command history records it', async () => {
  const ui = createTerminalUI();
  const pending = ui.readInput({ initialValue: '/provider set deepseek sk-secret-123' });
  ui.finishInput();

  assert.equal(await pending, '/provider set deepseek sk-secret-123');
  ui.inputHistory.begin('');
  assert.equal(ui.inputHistory.move(-1, ''), '/provider set deepseek');
  stopScheduledRender(ui);
});

test('queued provider commands never expose an inline API key', () => {
  const ui = createTerminalUI();
  ui.setQueue(['/provider set deepseek sk-queued-secret']);

  assert.equal(ui.queueText.includes('sk-queued-secret'), false);
  assert.match(ui.queueText, /\/provider set deepseek \[API Key 已隐藏\]/u);
  stopScheduledRender(ui);
});

test('legacy inline provider key is masked while typing and Ctrl+U never copies it', async () => {
  const ui = createTerminalUI();
  let clipboardWrites = 0;
  ui.clipboardWriter.write = async () => {
    clipboardWrites += 1;
    return true;
  };
  const command = '/provider set deepseek sk-live-secret';
  const pending = ui.readInput({ initialValue: command });

  const rendered = ui.getInputLayout(80, 4).rows.join('\n');
  assert.equal(rendered.includes('sk-live-secret'), false);
  assert.match(rendered, /\/provider set deepseek •+/u);

  ui.dispatchKeypress('\x15', { ctrl: true, name: 'u' });
  assert.equal(clipboardWrites, 0);
  assert.deepEqual(ui.activeInput.graphemes, []);

  ui.finishInput();
  assert.equal(await pending, '');
  stopScheduledRender(ui);
});

test('provider scope flag remains visible while an inline key stays masked', async () => {
  const ui = createTerminalUI();
  const pending = ui.readInput({ initialValue: '/provider set deepseek --project sk-scoped-secret' });

  const rendered = ui.getInputLayout(100, 4).rows.join('\n');
  assert.match(rendered, /--project/u);
  assert.equal(rendered.includes('sk-scoped-secret'), false);

  ui.finishInput();
  assert.equal(await pending, '/provider set deepseek --project sk-scoped-secret');
  stopScheduledRender(ui);
});

test('initial values and bracketed paste cannot inject terminal controls into the input frame', async () => {
  const ui = createTerminalUI();
  const pending = ui.readInput({ initialValue: 'I\x1b[2JN' });
  ui.dispatchProtocolEvent({
    type: 'paste',
    text: 'A\x1b]52;c;c2VjcmV0\x07B\x1b[12;40HC'
  });

  const value = ui.activeInput.graphemes.join('');
  const rendered = ui.getInputLayout(80, 4).rows.join('\n');
  assert.equal(value, 'INABC');
  assert.equal(rendered.includes('\x1b'), false);
  assert.doesNotMatch(rendered, /c2VjcmV0|12;40H/u);

  ui.finishInput();
  assert.equal(await pending, 'INABC');
  stopScheduledRender(ui);
});

test('sensitive input refuses a partially redirected terminal that could echo secrets', async () => {
  const ui = createTerminalUI();
  ui.interactive = false;

  await withTtyState(true, false, async () => {
    await assert.rejects(
      ui.readInput({ prompt: 'API Key: ', sensitive: true }),
      /敏感输入需要完整的交互式终端/u
    );
  });
});
