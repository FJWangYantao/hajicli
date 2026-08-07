import assert from 'node:assert/strict';
import test from 'node:test';

import {
  budgetPrompt,
  parseOptionalInteger,
  textPrompt,
  validateDescription,
  validateInstructionsInput
} from '../dist/agent-wizard.js';

test('parseOptionalInteger accepts empty, valid and rejects invalid input', () => {
  assert.deepEqual(parseOptionalInteger('', 100, 1000), { ok: true, value: undefined });
  assert.deepEqual(parseOptionalInteger('   ', 100, 1000), { ok: true, value: undefined });
  assert.deepEqual(parseOptionalInteger('500', 100, 1000), { ok: true, value: 500 });
  assert.deepEqual(parseOptionalInteger('1000', 100, 1000), { ok: true, value: 1000 });
  assert.deepEqual(parseOptionalInteger('abc', 100, 1000), { ok: false, message: '必须是 100 到 1000 之间的整数' });
  assert.deepEqual(parseOptionalInteger('99', 100, 1000), { ok: false, message: '必须是 100 到 1000 之间的整数' });
  assert.deepEqual(parseOptionalInteger('1001', 100, 1000), { ok: false, message: '必须是 100 到 1000 之间的整数' });
  assert.deepEqual(parseOptionalInteger('1.5', 100, 1000), { ok: false, message: '必须是 100 到 1000 之间的整数' });
  assert.deepEqual(parseOptionalInteger('5e2', 100, 1000), { ok: false, message: '必须是 100 到 1000 之间的整数' });
  assert.deepEqual(parseOptionalInteger('0x10', 100, 1000), { ok: false, message: '必须是 100 到 1000 之间的整数' });
  assert.deepEqual(parseOptionalInteger('1.0', 100, 1000), { ok: false, message: '必须是 100 到 1000 之间的整数' });
  assert.deepEqual(parseOptionalInteger('+500', 100, 1000), { ok: true, value: 500 });
  assert.deepEqual(parseOptionalInteger('-5', 100, 1000), { ok: false, message: '必须是 100 到 1000 之间的整数' });
});

test('validateDescription rejects empty input only', () => {
  assert.equal(validateDescription(''), '任务描述不能为空');
  assert.equal(validateDescription('   '), '任务描述不能为空');
  assert.equal(validateDescription('调研超时链路'), null);
});

test('validateInstructionsInput allows empty and enforces length limit', () => {
  assert.equal(validateInstructionsInput('', 100), null);
  assert.equal(validateInstructionsInput('   ', 100), null);
  assert.equal(validateInstructionsInput('只读调研', 100), null);
  assert.equal(validateInstructionsInput('x'.repeat(100), 100), null);
  assert.equal(validateInstructionsInput('x'.repeat(101), 100), '最多 100 个字符');
});

test('prompt helpers include current value and back hint', () => {
  assert.match(budgetPrompt('max-tokens', 50000, 1000, 2000000), /max-tokens/);
  assert.match(budgetPrompt('max-tokens', 50000, 1000, 2000000), /50000/);
  assert.match(budgetPrompt('max-tokens', undefined, 1000, 2000000), /默认/);
  assert.match(budgetPrompt('max-tokens', undefined, 1000, 2000000), /b 返回上一步/);
  assert.match(textPrompt('任务描述', '必填'), /必填/);
  assert.match(textPrompt('任务描述', '必填'), /b 返回上一步/);
});
