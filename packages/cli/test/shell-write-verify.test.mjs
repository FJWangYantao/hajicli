import assert from "node:assert/strict";
import test from "node:test";

import {
  detectShellFileWrites,
  editedPathsForTool,
  PostEditVerifier,
} from "../dist/post-edit-verify.js";

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

test("PostEditVerifier：bash 写源码触发验证，只读命令、子代理与失败调用不触发", async () => {
  const runs = [];
  const hints = [];
  let clock = 1_000_000;
  const verifier = new PostEditVerifier({
    showHint: (hint) => hints.push(hint),
    cwd: () => "/tmp/not-haji",
    env: { HAJI_POST_EDIT_VERIFY: "npm run typecheck" },
    cooldownMs: 0,
    now: () => clock++,
    runCheck: async (command, cwd) => {
      runs.push({ command, cwd });
      return { ok: false, timedOut: false, output: "src/a.ts(3,1): error TS2304" };
    },
  });

  assert.equal(
    await verifier.afterToolUse({ toolName: "bash", args: { command: "ls src" }, succeeded: true }),
    undefined,
  );
  assert.equal(
    await verifier.afterToolUse({
      toolName: "bash",
      args: { command: "sed -i s/a/b/ src/a.ts" },
      agentId: "sub-1",
      succeeded: true,
    }),
    undefined,
  );
  assert.equal(
    await verifier.afterToolUse({
      toolName: "edit",
      args: { path: "src/a.ts" },
      succeeded: false,
    }),
    undefined,
  );
  assert.equal(runs.length, 0);

  const notice = await verifier.afterToolUse({
    toolName: "bash",
    args: { command: "sed -i s/a/b/ src/a.ts src/b.ts" },
    succeeded: true,
  });
  assert.equal(runs.length, 1);
  assert.match(notice, /\[编辑后验证\] npm run typecheck 发现以下问题/);
  assert.equal(verifier.lastCheckSince(0)?.ok, false);

  // 同一结论在窗口内不重复注入（但仍会跑检查）。
  const repeat = await verifier.afterToolUse({
    toolName: "edit",
    args: { path: "src/a.ts" },
    succeeded: true,
  });
  assert.equal(runs.length, 2);
  assert.equal(repeat, undefined);
  assert.deepEqual(hints, []);
});

test("editedPathsForTool：write/edit 取 path，bash 走写入识别，opaque 记为空数组", () => {
  assert.deepEqual(editedPathsForTool("write", { path: "a.ts" }), ["a.ts"]);
  assert.deepEqual(editedPathsForTool("edit", {}), []);
  assert.deepEqual(editedPathsForTool("bash", { command: "cat > b.ts <<EOF\nx\nEOF" }), ["b.ts"]);
  assert.deepEqual(
    editedPathsForTool("bash", { command: "grep -rl a . | xargs sed -i s/a/b/" }),
    [],
  );
  assert.equal(editedPathsForTool("bash", { command: "npm test > out.log" }), undefined);
  assert.equal(editedPathsForTool("read", { path: "a.ts" }), undefined);
  assert.equal(editedPathsForTool("write", { path: "a.ts" }, "sub"), undefined);
});
