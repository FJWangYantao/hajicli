import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSensitiveCommand, sanitizeTerminalText } from '../dist/terminal-sanitize.js';

test('preserves printable Unicode, tabs and normalized newlines', () => {
  const input = '你好🙂\r\n第二行\r第三行\t完成\0\b\x7f\u0085';
  assert.equal(sanitizeTerminalText(input), '你好🙂\n第二行\n第三行\t完成');
});

test('removes CSI screen, cursor, style and private-mode controls', () => {
  const input = [
    'before',
    '\x1b[2J',
    '\x1b[H',
    '\x1b[12;40H',
    '\x1b[31mred\x1b[0m',
    '\x1b[?25l',
    '\u009b2J',
    'after'
  ].join('');
  assert.equal(sanitizeTerminalText(input), 'beforeredafter');
});

test('removes OSC 8 hyperlinks and OSC 52 clipboard writes with BEL or ST', () => {
  const input = [
    '链接：',
    '\x1b]8;;https://example.com\x1b\\',
    '文字',
    '\x1b]8;;\x07',
    '\x1b]52;c;U0VDUkVU\x07',
    '\u009d52;c;TU9SRQ==\u009c',
    '完成'
  ].join('');
  assert.equal(sanitizeTerminalText(input), '链接：文字完成');
});

test('removes DCS, APC, PM and SOS strings terminated by ST', () => {
  const input = [
    'A', '\x1bPdevice-data\x1b\\',
    'B', '\x1b_private-data\u009c',
    'C', '\x1b^private-message\x1b\\',
    'D', '\x1bXstart-of-string\x1b\\',
    'E', '\u0090c1-dcs\u009c',
    'F', '\u009f c1-apc\u009c',
    'G'
  ].join('');
  assert.equal(sanitizeTerminalText(input), 'ABCDEFG');
});

test('sanitizes a complete sequence assembled from arbitrary chunks', () => {
  const chunks = [
    '前缀\x1b]52;',
    'c;QUJD\x1b',
    '\\中间\x1b[',
    '2J后缀'
  ];
  assert.equal(sanitizeTerminalText(chunks.join('')), '前缀中间后缀');
});

test('drops incomplete escapes and cannot stall on malformed sequences', () => {
  assert.equal(sanitizeTerminalText('安全文本\x1b'), '安全文本');
  assert.equal(sanitizeTerminalText('安全文本\x1b[31'), '安全文本');
  assert.equal(sanitizeTerminalText('安全文本\x1b]52;c;AAAA'), '安全文本');
  assert.equal(sanitizeTerminalText('A\x1b[\0B'), 'AB');
  assert.equal(sanitizeTerminalText(`开始\x1b[${';'.repeat(100_000)}`), '开始');
  assert.equal(sanitizeTerminalText('保留\x1b中文🙂'), '保留中文🙂');
});

test('removes generic escape and standalone C0/C1 controls', () => {
  const input = 'A\x1b7B\x1b8C\x1bcD\x07\x0b\x0c\u0080\u009cE';
  assert.equal(sanitizeTerminalText(input), 'ABCDE');
});

test('redacts legacy inline provider API keys for display and history', () => {
  const command = '/provider set deepseek sk-secret-123';
  assert.equal(redactSensitiveCommand(command), '/provider set deepseek [API Key 已隐藏]');
  assert.equal(redactSensitiveCommand(command, ''), '/provider set deepseek');
  assert.equal(redactSensitiveCommand('/provider set deepseek'), '/provider set deepseek');
  assert.equal(redactSensitiveCommand('/provider set deepseek --project'), '/provider set deepseek --project');
  assert.equal(redactSensitiveCommand('/provider set deepseek sk-secret --project'), '/provider set deepseek [API Key 已隐藏] --project');
  assert.equal(redactSensitiveCommand('/provider set deepseek --project sk-secret', ''), '/provider set deepseek --project');
  assert.equal(redactSensitiveCommand('/model set deepseek sk-secret-123'), '/model set deepseek sk-secret-123');
});
