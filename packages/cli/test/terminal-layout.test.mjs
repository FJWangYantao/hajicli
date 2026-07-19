import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { layoutAnsiDocument, wrapAnsi, wrapAnsiWithState } from '../dist/terminal-input.js';

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
