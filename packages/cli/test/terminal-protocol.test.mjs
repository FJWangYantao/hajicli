import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalProtocolParser } from '../dist/terminal-protocol.js';

const dragSequence = [
  '\x1b[<0;5;10M',
  '\x1b[<32;20;12M',
  '\x1b[<64;20;8M',
  '\x1b[<65;20;8M',
  '\x1b[<0;20;8m'
].join('');

test('decodes SGR drag and wheel events', () => {
  const parser = new TerminalProtocolParser();
  const events = parser.push(dragSequence);

  assert.deepEqual(events.map(event => event.type === 'mouse' ? event.action : event.type), [
    'down', 'move', 'wheel', 'wheel', 'up'
  ]);
  assert.equal(events[2].wheelRows, 3);
  assert.equal(events[3].wheelRows, -3);
});

test('reassembles a mouse stream split at every byte', () => {
  const parser = new TerminalProtocolParser();
  const events = [];
  for (const byte of Buffer.from(dragSequence, 'utf8')) {
    events.push(...parser.push(Buffer.from([byte])));
  }

  assert.equal(events.length, 5);
  assert.ok(events.every(event => event.type === 'mouse'));
});

test('never leaks dense mouse traffic into keyboard events', () => {
  const parser = new TerminalProtocolParser();
  const denseDrag = Array.from({ length: 500 }, (_, index) =>
    `\x1b[<32;${2 + (index % 70)};${2 + (index % 20)}M`
  ).join('');
  const events = parser.push(`${denseDrag}\x03`);

  const keyboard = events.filter(event => event.type === 'keyboard');
  assert.deepEqual(keyboard, [{ type: 'keyboard', data: '\x03' }]);
  assert.equal(events.filter(event => event.type === 'mouse').length, 500);
});

test('keeps bracketed paste atomic across arbitrary packets', () => {
  const parser = new TerminalProtocolParser();
  const events = [
    ...parser.push('\x1b[20'),
    ...parser.push('0~第一行\n'),
    ...parser.push('第二行\x1b[20'),
    ...parser.push('1~')
  ];

  assert.deepEqual(events, [{ type: 'paste', text: '第一行\n第二行' }]);
});

test('flushes a standalone escape as keyboard input', () => {
  const parser = new TerminalProtocolParser();
  assert.deepEqual(parser.push('\x1b'), []);
  assert.deepEqual(parser.flushPending(), [{ type: 'keyboard', data: '\x1b' }]);
});
