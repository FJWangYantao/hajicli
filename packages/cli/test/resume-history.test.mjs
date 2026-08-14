import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const indexSource = fs.readFileSync(
  new URL('../src/index.ts', import.meta.url),
  'utf8'
);

test('/resume 恢复的历史思考标题不显示图标', () => {
  assert.match(
    indexSource,
    /appendHistoryLine\(colors\.gray\(`深度思考 \(\$\{m\.reasoning_content\.length\} 字\)`\)\)/
  );
  assert.doesNotMatch(indexSource, /💭 深度思考/);
});
