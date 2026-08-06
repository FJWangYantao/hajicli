import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNativeTerminalEngineStatus,
  tryNativeLayoutAnsiDocument,
  tryNativeWrapAnsi
} from '../dist/native-terminal-engine.js';
import {
  layoutAnsiDocumentFallback,
  wrapAnsiWithStateFallback
} from '../dist/terminal-input.js';

const status = getNativeTerminalEngineStatus();
const cases = [
  { value: '', width: 80, initialStyle: '' },
  { value: 'plain ASCII text\nnext line', width: 8, initialStyle: '' },
  { value: '\x1b[31m你a\x1b[0m\n🙂b', width: 3, initialStyle: '' },
  { value: 'e\u0301 · 👨‍👩‍👧‍👦 · 𠀀', width: 6, initialStyle: '\x1b[1m' },
  { value: 'a\r\nb\rignored', width: 2, initialStyle: '' },
  { value: '\x1b[38;5;208mcolored text without reset', width: 5, initialStyle: '' },
  { value: `prefix ${'中abc🙂'.repeat(400)} suffix`, width: 37, initialStyle: '' }
];

function randomizedCases() {
  const tokens = [
    'a', 'Z', '中', '🙂', 'e\u0301', '👨‍👩‍👧‍👦',
    '\n', '\r', '\r\n', '\x1b[31m', '\x1b[0m', '\x1b[?25l', '\x1bX'
  ];
  let state = 0x5eed1234;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: 100 }, () => {
    const parts = Array.from(
      { length: 1 + (next() % 30) },
      () => tokens[next() % tokens.length]
    );
    return {
      value: parts.join(''),
      width: 1 + (next() % 24),
      initialStyle: next() % 3 === 0 ? '\x1b[1m' : ''
    };
  });
}

test('native terminal engine matches the TypeScript golden implementation', {
  skip: status.available ? false : `native engine unavailable: ${status.error || status.mode}`
}, () => {
  for (const item of [...cases, ...randomizedCases()]) {
    assert.deepEqual(
      tryNativeWrapAnsi(item.value, item.width, item.initialStyle),
      wrapAnsiWithStateFallback(item.value, item.width, item.initialStyle)
    );
    assert.deepEqual(
      tryNativeLayoutAnsiDocument(item.value, item.width),
      layoutAnsiDocumentFallback(item.value, item.width)
    );
  }
});

test('native renderer can be disabled without affecting the TypeScript fallback', () => {
  const previous = process.env.HAJI_NATIVE_RENDERER;
  process.env.HAJI_NATIVE_RENDERER = 'off';
  try {
    assert.equal(getNativeTerminalEngineStatus().available, false);
    assert.equal(tryNativeWrapAnsi('text', 10), undefined);
    assert.equal(tryNativeLayoutAnsiDocument('text', 10), undefined);
  } finally {
    if (previous === undefined) delete process.env.HAJI_NATIVE_RENDERER;
    else process.env.HAJI_NATIVE_RENDERER = previous;
  }
});
