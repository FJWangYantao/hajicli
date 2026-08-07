import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  bgSeq,
  buildAnsiStyles,
  detectColorLevel,
  fgSeq,
  getColorLevel,
  paint,
  resetActiveColorLevel,
  resetActiveTheme,
  setActiveColorLevel,
  setActiveTheme,
  setColorLevel,
  themeBg,
  themeEnter,
  themeExit,
  themeFg,
  themeReset
} from '../dist/theme.js';
import { buildAgentPanelRows } from '../dist/terminal-input.js';

const FIXED_THEME = {
  background: '#000000',
  userMsgBg: '#202020',
  foreground: '#ffffff',
  accent: '#ff00ff',
  muted: '#808080',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  brightGreen: '#00ff00',
  brightYellow: '#ffff00',
  brightBlue: '#0000ff',
  brightCyan: '#00ffff'
};

afterEach(() => {
  resetActiveColorLevel();
  resetActiveTheme();
});

test('detectColorLevel honors explicit mono conditions before color capabilities', () => {
  assert.equal(detectColorLevel({ WT_SESSION: '1' }, false, 'win32'), 'mono');
  assert.equal(detectColorLevel({ NO_COLOR: '', WT_SESSION: '1' }, true, 'win32'), 'mono');
  assert.equal(detectColorLevel({ TERM: 'DuMb', COLORTERM: 'truecolor' }, true, 'linux'), 'mono');
});

test('detectColorLevel detects truecolor, 256 color and ordinary TTY levels', () => {
  assert.equal(detectColorLevel({ WT_SESSION: '1' }, true, 'win32'), 'truecolor');
  assert.equal(detectColorLevel({ COLORTERM: 'TRUECOLOR' }, true, 'linux'), 'truecolor');
  assert.equal(detectColorLevel({ COLORTERM: '24bit' }, true, 'linux'), 'truecolor');
  assert.equal(detectColorLevel({ TERM: 'xterm-256color' }, true, 'linux'), 'ansi256');
  assert.equal(detectColorLevel({ TERM: 'xterm' }, true, 'linux'), 'ansi16');
});

test('truecolor sequences preserve exact RGB values', () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel('truecolor');

  assert.equal(fgSeq('#123456'), '\x1b[38;2;18;52;86m');
  assert.equal(bgSeq('#123456'), '\x1b[48;2;18;52;86m');
  assert.match(themeEnter(), /^\x1b\[0m\x1b\[38;2;/);
  assert.match(themeReset(), /^\x1b\[0m\x1b\[38;2;/);
});

test('ansi256 sequences map RGB values to the xterm palette', () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel('ansi256');

  assert.equal(fgSeq('#ff0000'), '\x1b[38;5;196m');
  assert.equal(bgSeq('#000000'), '\x1b[48;5;16m');
  assert.equal(fgSeq('#f8f8f8'), '\x1b[38;5;255m');
  assert.match(paint.accent('HAJI'), /^\x1b\[38;5;201mHAJI/);
});

test('ansi16 sequences use standard and bright SGR colors', () => {
  setActiveTheme(FIXED_THEME);
  setColorLevel('ansi16');

  assert.equal(getColorLevel(), 'ansi16');
  assert.equal(fgSeq('#ff0000'), '\x1b[91m');
  assert.equal(bgSeq('#000000'), '\x1b[40m');
  assert.match(paint.boldAccent('HAJI'), /^\x1b\[1m\x1b\[95mHAJI/);
});

test('mono mode removes ANSI while preserving readable user prefixes', () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel('mono');

  assert.equal(fgSeq('#ff0000'), '');
  assert.equal(bgSeq('#000000'), '');
  assert.equal(themeFg(), '');
  assert.equal(themeBg(), '');
  assert.equal(themeEnter(), '');
  assert.equal(themeReset(), '');
  assert.equal(themeExit(), '');
  assert.equal(paint.boldAccent('HAJI'), 'HAJI');
  assert.equal(paint.userMsg('第一行\n第二行'), ' ❯ 第一行\n   第二行');

  const styles = buildAnsiStyles();
  assert.ok(Object.values(styles).every(value => value === ''));
});

test('terminal UI color sequences follow runtime color-level changes', () => {
  setActiveTheme(FIXED_THEME);
  setActiveColorLevel('truecolor');
  const item = {
    id: 'agent-1',
    role: 'reviewer',
    status: 'running',
    startedAt: Date.now(),
    totalTokens: 0
  };

  assert.match(buildAgentPanelRows([item], 80).join('\n'), /\x1b\[/u);
  setActiveColorLevel('mono');
  assert.doesNotMatch(buildAgentPanelRows([item], 80).join('\n'), /\x1b\[/u);
});
