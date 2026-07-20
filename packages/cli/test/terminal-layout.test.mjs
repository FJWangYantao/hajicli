import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { layoutAnsiDocument, TerminalUI, wrapAnsi, wrapAnsiWithState } from '../dist/terminal-input.js';

const stripAnsi = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

function createTerminalUI() {
  return new TerminalUI({
    header: '',
    compactHeader: '',
    inputPrompt: '',
    renderBorder: width => '-'.repeat(width)
  });
}

test('lays out ANSI, wide characters, and document offsets consistently', () => {
  const layout = layoutAnsiDocument('\x1b[31m你a\x1b[0m\n🙂b', 3);

  assert.equal(layout.document, '你a\n🙂b');
  assert.deepEqual(layout.rows.map(row => row.plain), ['你a', '🙂b']);
  assert.deepEqual(
    layout.rows.map(row => [row.startOffset, row.endOffset]),
    [[0, 2], [3, 6]]
  );
});

test('selection layout rows stay aligned with scrolling rows', () => {
  const input = '\x1b[31mabcdef\n你🙂x\x1b[0m\nlast line';
  const width = 5;
  const selectionRows = layoutAnsiDocument(input, width).rows.map(row => row.ansi);

  assert.deepEqual(selectionRows, wrapAnsi(input, width));
});

test('stable-prefix wrapping is identical to wrapping the complete document', () => {
  const prefix = '\x1b[31mfirst line\nsecond line\n';
  const tail = '你🙂 tail\x1b[0m\nstatus';
  const width = 8;
  const wrappedPrefix = wrapAnsiWithState(prefix, width);
  const incrementalRows = [
    ...wrappedPrefix.rows.slice(0, -1),
    ...wrapAnsiWithState(tail, width, wrappedPrefix.activeStyle).rows
  ];

  assert.deepEqual(incrementalRows, wrapAnsi(prefix + tail, width));
});

test('lays out long chat history in linear time', () => {
  const input = '中'.repeat(20_000);
  const startedAt = performance.now();
  const layout = layoutAnsiDocument(input, 80);
  const durationMs = performance.now() - startedAt;

  assert.equal(layout.document, input);
  assert.equal(layout.rows.length, 500);
  assert.ok(durationMs < 1_500, `layout took ${Math.round(durationMs)}ms`);
});

test('renders the compact Todo panel and toggles its expanded state with Ctrl+T', () => {
  const ui = createTerminalUI();
  ui.setTaskPlan({
    title: '配置开发环境',
    tasks: [
      { id: '1', content: '阅读前后端配置文件', status: 'completed' },
      { id: '2', content: '创建数据库容器', status: 'in_progress' },
      { id: '3', content: '修改本地配置', status: 'pending' },
      { id: '4', content: '构建后端', status: 'pending' },
      { id: '5', content: '启动前端', status: 'pending' },
      { id: '6', content: '验证接口', status: 'completed' },
      { id: '7', content: '检查日志', status: 'pending' },
      { id: '8', content: '完成验收', status: 'pending' }
    ]
  });

  const collapsed = ui.buildTaskPanel(100, 8).map(stripAnsi);
  assert.deepEqual(collapsed.slice(0, 4), [
    'Todo',
    '✓ 阅读前后端配置文件',
    '● 创建数据库容器',
    '○ 修改本地配置'
  ]);
  assert.match(collapsed.at(-1), /… \+3 more \(1 done · 2 pending\) · ctrl\+t to expand/);

  ui.dispatchKeypress('\x14', { ctrl: true, name: 't' });
  const expanded = ui.buildTaskPanel(100, 12).map(stripAnsi);
  assert.ok(expanded.includes('○ 完成验收'));
  assert.equal(expanded.at(-1), '… ctrl+t to collapse');
});
