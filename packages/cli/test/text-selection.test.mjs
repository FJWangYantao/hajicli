import assert from 'node:assert/strict';
import test from 'node:test';

import { TextSelectionModel } from '../dist/text-selection.js';

test('keeps selection in document offsets when viewport changes', () => {
  const selection = new TextSelectionModel();
  selection.begin({ startOffset: 4, endOffset: 5 });
  selection.update({ startOffset: 10, endOffset: 11 });

  assert.deepEqual(selection.range(), { startOffset: 4, endOffset: 11 });
  assert.equal(selection.selectedText('0123456789abcdef'), '456789a');
});

test('normalizes a backwards drag', () => {
  const selection = new TextSelectionModel();
  selection.begin({ startOffset: 10, endOffset: 11 });
  selection.update({ startOffset: 4, endOffset: 5 });

  assert.deepEqual(selection.range(), { startOffset: 4, endOffset: 11 });
});

test('copies hard line breaks from the source document', () => {
  const document = '第一行\n第二行';
  const selection = new TextSelectionModel();
  selection.begin({ startOffset: 0, endOffset: 1 });
  selection.update({ startOffset: document.length - 1, endOffset: document.length });

  assert.equal(selection.selectedText(document), document);
});

test('finish preserves the range and clear removes it', () => {
  const selection = new TextSelectionModel();
  selection.begin({ startOffset: 1, endOffset: 2 });
  selection.finish({ startOffset: 3, endOffset: 4 });
  assert.equal(selection.dragging, false);
  assert.deepEqual(selection.range(), { startOffset: 1, endOffset: 4 });

  selection.clear();
  assert.equal(selection.active, false);
  assert.equal(selection.range(), undefined);
});
