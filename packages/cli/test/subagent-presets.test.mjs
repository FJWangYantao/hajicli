import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parsePresetCommand } from '../dist/agent-commands.js';
import {
  applySubagentPreset,
  findSubagentPreset,
  loadSubagentPresets,
  saveSubagentPresets,
  updateSubagentPreset
} from '../dist/subagent-presets.js';

test('parsePresetCommand parses name and optional fields', () => {
  assert.deepEqual(parsePresetCommand('fast --role research --model deepseek-v4-flash --provider deepseek --effort high --instructions "只读调研" --timeout-ms 45000 --max-tokens 24000 --max-tool-calls 12'), {
    name: 'fast',
    role: 'research',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    reasoningEffort: 'high',
    instructions: '只读调研',
    timeoutMs: 45000,
    maxTokens: 24000,
    maxToolCalls: 12
  });
  assert.deepEqual(parsePresetCommand('"my preset"'), { name: 'my preset' });
  assert.deepEqual(parsePresetCommand("'调研' --effort max"), { name: '调研', reasoningEffort: 'max' });
});

test('parsePresetCommand rejects invalid input', () => {
  assert.throws(() => parsePresetCommand(''), /预设名称不能为空/);
  assert.throws(() => parsePresetCommand('   '), /预设名称不能为空/);
  assert.throws(() => parsePresetCommand('-foo'), /预设名称不能以 - 开头/);
  assert.throws(() => parsePresetCommand('--model x'), /预设名称不能以 - 开头/);
  assert.throws(() => parsePresetCommand('fast --effort ultra'), /--effort 必须是 low、medium、high、xhigh 或 max/);
  assert.throws(() => parsePresetCommand('fast --role hacker'), /--role 必须是 research、review 或 implement/);
  assert.throws(() => parsePresetCommand('fast --max-tokens 20'), /1000 到 2000000/);
  assert.throws(() => parsePresetCommand('fast --max-tokens 1e3'), /1000 到 2000000/);
  assert.throws(() => parsePresetCommand('fast --max-tool-calls 0'), /1 到 500/);
  assert.throws(() => parsePresetCommand('fast --timeout-ms 20'), /100 到 3600000/);
  assert.throws(() => parsePresetCommand('fast --model ""'), /--model 不能为空/);
  assert.throws(() => parsePresetCommand('fast --model "abc'), /--model 的引号未闭合/);
  assert.throws(() => parsePresetCommand('fast unknown'), /无法识别的参数: unknown/);
  // 引号包裹的 - 开头名称仍允许
  assert.deepEqual(parsePresetCommand('"-foo"'), { name: '-foo' });
});

test('presets round-trip through file and find is case-insensitive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-preset-'));
  const file = path.join(dir, 'subagent-presets.json');
  const presets = [
    { name: 'fast', role: 'research', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 24000 },
    { name: 'deep', instructions: '只读审查' }
  ];
  assert.equal(saveSubagentPresets(presets, file), true);
  assert.deepEqual(loadSubagentPresets(file), presets);
  assert.equal(findSubagentPreset(loadSubagentPresets(file), 'FAST')?.name, 'fast');
  assert.equal(findSubagentPreset(loadSubagentPresets(file), 'Deep')?.name, 'deep');
  assert.equal(findSubagentPreset(loadSubagentPresets(file), 'missing'), undefined);
});

test('loadSubagentPresets tolerates missing or corrupted files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-preset-'));
  assert.deepEqual(loadSubagentPresets(path.join(dir, 'nope.json')), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{broken', 'utf8');
  assert.deepEqual(loadSubagentPresets(path.join(dir, 'bad.json')), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"presets": [{"name": 1}, {"name": "ok"}]}', 'utf8');
  assert.deepEqual(loadSubagentPresets(path.join(dir, 'bad.json')), [{ name: 'ok' }]);
});

test('updateSubagentPreset merges patch and keeps unspecified fields', () => {
  const presets = [
    { name: '调研', role: 'research', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 50000, maxToolCalls: 30, timeoutMs: 300000, instructions: '只读调研' },
    { name: 'other', role: 'review' }
  ];
  // 只更新 effort 和 max-tokens，其余字段与 name 保持原值
  const updated = updateSubagentPreset(presets, '调研', { reasoningEffort: 'max', maxTokens: 80000 });
  assert.deepEqual(updated[0], {
    name: '调研',
    role: 'research',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max',
    maxTokens: 80000,
    maxToolCalls: 30,
    timeoutMs: 300000,
    instructions: '只读调研'
  });
  // 其他预设不受影响
  assert.deepEqual(updated[1], { name: 'other', role: 'review' });
  // 大小写不敏感
  const caseUpdated = updateSubagentPreset(presets, '调研'.toUpperCase(), { role: 'review' });
  assert.equal(caseUpdated[0].role, 'review');
  // 不存在的名称返回原列表
  assert.deepEqual(updateSubagentPreset(presets, 'missing', { role: 'review' }), presets);
});

test('corrupted preset file is backed up instead of silently wiped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-preset-'));
  const file = path.join(dir, 'subagent-presets.json');
  fs.writeFileSync(file, '{broken json', 'utf8');
  // 加载损坏文件 → 备份为 .bak，返回空列表
  assert.deepEqual(loadSubagentPresets(file), []);
  assert.equal(fs.existsSync(`${file}.bak`), true);
  assert.equal(fs.existsSync(file), false);
  // 备份后保存不会覆盖备份
  saveSubagentPresets([{ name: 'new' }], file);
  assert.equal(fs.existsSync(`${file}.bak`), true);
  assert.deepEqual(loadSubagentPresets(file), [{ name: 'new' }]);
});

test('loadSubagentPresets sanitizes dirty field values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-preset-'));
  const file = path.join(dir, 'subagent-presets.json');
  fs.writeFileSync(file, JSON.stringify({
    presets: [
      {
        name: 'dirty',
        role: 'hacker',
        reasoningEffort: 'ultra',
        maxTokens: 999999999,
        maxToolCalls: -5,
        timeoutMs: 'abc',
        instructions: 12345,
        model: '  deepseek-v4-flash  ',
        provider: 'deepseek'
      }
    ]
  }), 'utf8');
  const loaded = loadSubagentPresets(file);
  assert.deepEqual(loaded, [{ name: 'dirty', model: 'deepseek-v4-flash', provider: 'deepseek' }]);
});

test('updateSubagentPreset ignores undefined patch values', () => {
  const presets = [{ name: '调研', role: 'research', maxTokens: 50000 }];
  const updated = updateSubagentPreset(presets, '调研', { role: undefined, maxTokens: 80000 });
  assert.deepEqual(updated, [{ name: '调研', role: 'research', maxTokens: 80000 }]);
  // 非字符串名称防御：不抛错
  assert.deepEqual(updateSubagentPreset(presets, 123, { role: 'review' }), presets);
  assert.equal(findSubagentPreset(presets, 123), undefined);
});

test('saveSubagentPresets writes atomically without temp residue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-preset-'));
  const file = path.join(dir, 'subagent-presets.json');
  assert.equal(saveSubagentPresets([{ name: 'a' }], file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.deepEqual(loadSubagentPresets(file), [{ name: 'a' }]);
  // 再次覆盖保存仍无残留
  assert.equal(saveSubagentPresets([{ name: 'b' }], file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.deepEqual(loadSubagentPresets(file), [{ name: 'b' }]);
});

test('applySubagentPreset prefers explicit arguments over preset values', () => {
  const preset = {
    name: 'fast',
    role: 'research',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    instructions: '只读调研',
    maxTokens: 24000,
    maxToolCalls: 12,
    timeoutMs: 45000
  };
  const merged = applySubagentPreset(
    { background: false, description: '调研', role: 'review', maxTokens: 50000 },
    preset
  );
  assert.equal(merged.role, 'review');
  assert.equal(merged.maxTokens, 50000);
  assert.equal(merged.model, 'deepseek-v4-flash');
  assert.equal(merged.reasoningEffort, 'high');
  assert.equal(merged.instructions, '只读调研');
  assert.equal(merged.maxToolCalls, 12);
  assert.equal(merged.timeoutMs, 45000);
});

test('applySubagentPreset fills gaps when arguments are absent', () => {
  const preset = { name: 'fast', role: 'research', model: 'deepseek-v4-flash', maxTokens: 24000 };
  const merged = applySubagentPreset({ background: true, description: '调研' }, preset);
  assert.equal(merged.role, 'research');
  assert.equal(merged.model, 'deepseek-v4-flash');
  assert.equal(merged.maxTokens, 24000);
  assert.equal(merged.reasoningEffort, undefined);
  assert.equal(merged.background, true);
  assert.equal(merged.description, '调研');
});
