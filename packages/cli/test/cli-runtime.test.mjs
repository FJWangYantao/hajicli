import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatToolArgs, loadPreference, savePreference } from '../dist/cli-runtime.js';

test('CLI preferences persist normally and report write failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-preference-'));
  const preferencePath = path.join(root, 'preferences.json');
  const blockedParent = path.join(root, 'blocked');
  const blockedPath = path.join(blockedParent, 'preferences.json');
  const warnings = [];

  try {
    assert.equal(savePreference({ model: 'test', reasoningEffort: 'low' }, undefined, preferencePath), true);
    assert.equal(loadPreference(preferencePath).model, 'test');

    fs.writeFileSync(blockedParent, 'not a directory', 'utf8');
    assert.equal(
      savePreference(
        { model: 'test', reasoningEffort: 'low' },
        warning => warnings.push(warning),
        blockedPath
      ),
      false
    );
    assert.match(warnings.join('\n'), /用户偏好保存失败/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool argument summaries stay single-line and bounded', () => {
  assert.equal(formatToolArgs({ path: 'a\nb' }), 'path: "a b"');
  assert.equal(formatToolArgs({ content: 'x'.repeat(100) }, 20).length, 20);
});
