import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { detectShellFileWrites } from "../dist/post-edit-verify.js";

/**
 * bash 写源码也要触发编辑后验证：写路径基准里重命名任务一条 `sed -i` 就完成，
 * write/edit 钩子从不触发（design/ab/2026-10-27-write-baseline.md）。
 */
const cases = [
  ['sed -i "s/foo/bar/g" src/a.ts src/b.ts', ["src/a.ts", "src/b.ts"], false],
  ["sed -i '' -e s/a/b/ x.ts", ["x.ts"], false],
  ["FOO=1 sed -i.bak -e s/a/b/ -e s/c/d/ y.py", ["y.py"], false],
  ['perl -pi -e "s/a/b/" lib/x.js', ["lib/x.js"], false],
  ["cat > src/new.ts <<EOF\nexport const a = 1;\nEOF", ["src/new.ts"], false],
  ["echo '{}' >> config.json", ["config.json"], false],
  ["node gen.js | tee src/gen.ts", ["src/gen.ts"], false],
  ["grep -rl foo src | xargs sed -i s/foo/bar/", [], true],
  ["grep -rlZ foo src | xargs -0 -n 1 sed -i -e s/foo/bar/", [], true],
  ['find src -name "*.ts" -exec sed -i s/a/b/ {} +', [], true],
  ['find src -name "*.ts" -exec sed -i s/a/b/ {} ;', [], true],
];

const readOnly = [
  "sed s/a/b/ x.ts",
  "npm test > out.log 2>&1",
  "pnpm test 2>&1 | tail -20",
  "echo hi >> notes.md",
  "ls > /dev/null",
  "echo x 2> err.ts",
  "grep -rl foo src | xargs cat",
  "find . -name x -exec grep foo {} +",
  'git commit -m "sed -i s/a/b/ > x.ts"',
];

test("识别 sed -i / perl -i / 重定向 / tee 写的源码文件", () => {
  for (const [command, files, opaque] of cases) {
    assert.deepEqual(detectShellFileWrites(command), { files, opaque }, command);
  }
});

test("只读命令、日志重定向与引号里的文本不触发验证", () => {
  for (const command of readOnly) {
    assert.deepEqual(detectShellFileWrites(command), { files: [], opaque: false }, command);
  }
});

test("PostToolUse 钩子对 bash 写源码同样跑编辑后验证", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /ctx\.toolName === "bash"[\s\S]{0,120}detectShellFileWrites\(ctx\.args\.command\)/,
  );
  assert.match(source, /maybeRunPostEditVerify\(editedPaths\)/);
});
