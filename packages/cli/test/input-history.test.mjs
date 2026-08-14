import assert from 'node:assert/strict';
import test from 'node:test';

import { InputHistoryBuffer, buildScreenUpdate } from '../dist/terminal-input.js';
import { MarkdownRenderThrottle, shouldShowToolThinkingSummary } from '../dist/markdown-renderer.js';
import { setActiveColorLevel, setActiveTheme } from '../dist/theme.js';

/** 固定主题（黑色背景），保证 buildScreenUpdate 输出断言确定性。 */
const FIXED_THEME = {
  background: '#000000',
  foreground: '#ffffff',
  accent: '#ffffff',
  muted: '#888888',
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

test('navigates submitted input and restores the unsent draft', () => {
  const history = new InputHistoryBuffer();
  history.record('first message');
  history.record('second message');
  history.begin('current draft');

  assert.equal(history.move(-1, 'current draft'), 'second message');
  assert.equal(history.move(-1, 'second message'), 'first message');
  assert.equal(history.move(-1, 'first message'), undefined);
  assert.equal(history.move(1, 'first message'), 'second message');
  assert.equal(history.move(1, 'second message'), 'current draft');
  assert.equal(history.move(1, 'current draft'), undefined);
});

test('ignores empty submissions and tracks whether history is being browsed', () => {
  const history = new InputHistoryBuffer();
  history.record('   ');
  history.begin('draft');
  assert.equal(history.move(-1, 'draft'), undefined);

  history.record('/help');
  history.begin('draft');
  assert.equal(history.move(-1, 'draft'), '/help');
  assert.equal(history.isBrowsing(), true);
  assert.equal(history.move(1, '/help'), 'draft');
  assert.equal(history.isBrowsing(), false);
});

test('screen updates repaint only changed terminal rows', () => {
  setActiveColorLevel('truecolor');
  setActiveTheme(FIXED_THEME);
  const update = buildScreenUpdate(['header', 'old input', 'status'], ['header', 'new input', 'status']);
  assert.equal(update, '\x1b[2;1H\x1b[48;2;0;0;0m\x1b[2Knew input');
  assert.equal(buildScreenUpdate(['same'], ['same']), '');
});

test('streaming Markdown rendering is capped to one pass per frame window', () => {
  const throttle = new MarkdownRenderThrottle(32);
  assert.equal(throttle.shouldRender(100), true);
  assert.equal(throttle.shouldRender(110), false);
  assert.equal(throttle.shouldRender(131), false);
  assert.equal(throttle.shouldRender(132), true);
});

test('streaming Markdown rendering slows adaptively for long accumulated replies', () => {
  const medium = new MarkdownRenderThrottle(32);
  assert.equal(medium.shouldRender(100, 24_000), true);
  assert.equal(medium.shouldRender(140, 24_000), false);
  assert.equal(medium.shouldRender(148, 24_000), true);

  const large = new MarkdownRenderThrottle(32);
  assert.equal(large.shouldRender(100, 64_000), true);
  assert.equal(large.shouldRender(150, 64_000), false);
  assert.equal(large.shouldRender(164, 64_000), true);
});

test('tool thinking summary is hidden when the model already emitted visible text', () => {
  assert.equal(shouldShowToolThinkingSummary('', 1), true);
  assert.equal(shouldShowToolThinkingSummary('  \n', 2), true);
  assert.equal(shouldShowToolThinkingSummary('现将分析任务委派给 research 子代理：', 1), false);
  assert.equal(shouldShowToolThinkingSummary('', 0), false);
});
