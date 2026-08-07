import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolvePanelRowBudget,
  resolveTuiLayout,
  resolveTuiLayoutMode
} from '../dist/tui-layout.js';

const widthCases = [
  { columns: 20, mode: 'minimal' },
  { columns: 24, mode: 'narrow' },
  { columns: 32, mode: 'narrow' },
  { columns: 40, mode: 'compact' },
  { columns: 60, mode: 'comfortable' },
  { columns: 80, mode: 'comfortable' },
  { columns: 120, mode: 'wide' }
];
const rowCases = [8, 12, 24, 40];

test('resolves every width and height combination without exceeding the terminal', () => {
  for (const { columns, mode } of widthCases) {
    for (const rows of rowCases) {
      const layout = resolveTuiLayout(columns, rows);
      const expectedMode = rows < 10 ? 'minimal' : mode;

      assert.equal(layout.mode, expectedMode, `${columns}x${rows}`);
      assert.equal(layout.safeWidth, columns - 1, `${columns}x${rows} width`);
      assert.ok(layout.safeWidth <= columns - 1, `${columns}x${rows} safe width`);
      assert.equal(layout.safeHeight, rows, `${columns}x${rows} height`);
      assert.ok(layout.panelRows <= resolvePanelRowBudget(rows), `${columns}x${rows} panels`);
    }
  }
});

test('uses exact width breakpoint boundaries', () => {
  const cases = [
    [23, 'minimal'],
    [24, 'narrow'],
    [39, 'narrow'],
    [40, 'compact'],
    [59, 'compact'],
    [60, 'comfortable'],
    [99, 'comfortable'],
    [100, 'wide']
  ];

  for (const [columns, expected] of cases) {
    assert.equal(resolveTuiLayoutMode(columns, 24), expected, `${columns} columns`);
  }
});

test('forces minimal layout below 24 columns or 10 rows', () => {
  for (const [columns, rows] of [[20, 40], [120, 8]]) {
    assert.deepEqual(resolveTuiLayout(columns, rows), {
      mode: 'minimal',
      safeWidth: columns - 1,
      safeHeight: rows,
      chatPadding: 0,
      headerMode: 'hidden',
      statusDetail: 'minimal',
      panelRows: 0,
      showHints: false
    });
  }
});

test('reduces vertical detail before changing the width mode', () => {
  assert.deepEqual(resolveTuiLayout(120, 12), {
    mode: 'wide',
    safeWidth: 119,
    safeHeight: 12,
    chatPadding: 3,
    headerMode: 'hidden',
    statusDetail: 'minimal',
    panelRows: 1,
    showHints: false
  });

  assert.deepEqual(resolveTuiLayout(120, 24), {
    mode: 'wide',
    safeWidth: 119,
    safeHeight: 24,
    chatPadding: 3,
    headerMode: 'full',
    statusDetail: 'full',
    panelRows: 4,
    showHints: true
  });

  assert.equal(resolveTuiLayout(120, 40).panelRows, 8);
});

test('rejects invalid terminal dimensions', () => {
  assert.throws(() => resolveTuiLayout(0, 24), RangeError);
  assert.throws(() => resolveTuiLayout(80, Number.NaN), RangeError);
});
