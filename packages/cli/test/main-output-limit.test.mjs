import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliSource = fs.readFileSync(path.resolve(testDir, '../src/index.ts'), 'utf8');
const contextPolicySource = fs.readFileSync(path.resolve(testDir, '../src/context-policy.ts'), 'utf8');

test('main conversation leaves the provider output length uncapped', () => {
  const requestStart = cliSource.indexOf('const stream = provider.completeStream(messages, {');
  assert.ok(requestStart >= 0, 'main provider request must exist');
  const requestEnd = cliSource.indexOf('\n        });', requestStart);
  assert.ok(requestEnd > requestStart, 'main provider request must have a bounded source slice');
  const requestOptions = cliSource.slice(requestStart, requestEnd);

  assert.doesNotMatch(requestOptions, /maxTokens\s*:/);
  assert.doesNotMatch(cliSource, /getModelMaxOutputTokens|HAJI_MAX_TOKENS/);
  assert.doesNotMatch(contextPolicySource, /MODEL_MAX_OUTPUT_TOKENS|HAJI_MAX_TOKENS/);
});

test('upstream length completion is reported without claiming a Haji limit', () => {
  assert.match(cliSource, /Haji 未设置单次输出上限/);
  assert.doesNotMatch(cliSource, /可设置 HAJI_MAX_TOKENS 调高/);
});
