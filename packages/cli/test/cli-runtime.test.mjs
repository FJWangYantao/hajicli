import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPermissionPreview,
  describeModelError,
  findGitHeadPath,
  formatExpandedToolOutput,
  formatReasoningPreview,
  formatToolArgs,
  formatToolCell,
  formatToolDuration,
  formatWorkspaceLabel,
  getPermissionGrant,
  loadPreference,
  readGitBranch,
  savePreference,
  summarizeToolCall,
  summarizeToolResult,
} from "../dist/cli-runtime.js";
import { terminalWidth } from "../dist/terminal-text.js";
import { setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

test("CLI preferences persist normally and report write failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-preference-"));
  const preferencePath = path.join(root, "preferences.json");
  const blockedParent = path.join(root, "blocked");
  const blockedPath = path.join(blockedParent, "preferences.json");
  const warnings = [];

  try {
    assert.equal(
      savePreference({ model: "test", reasoningEffort: "low" }, undefined, preferencePath),
      true,
    );
    assert.equal(loadPreference(preferencePath).model, "test");

    fs.writeFileSync(blockedParent, "not a directory", "utf8");
    assert.equal(
      savePreference(
        { model: "test", reasoningEffort: "low" },
        (warning) => warnings.push(warning),
        blockedPath,
      ),
      false,
    );
    assert.match(warnings.join("\n"), /用户偏好保存失败/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tool argument summaries stay single-line and bounded", () => {
  assert.equal(formatToolArgs({ path: "a\nb" }), 'path: "a b"');
  assert.equal(formatToolArgs({ content: "x".repeat(100) }, 20).length, 20);
});

test("tool call summaries lead with what matters for each tool", () => {
  assert.equal(summarizeToolCall("bash", { command: "npm test" }), "npm test");
  assert.equal(
    summarizeToolCall("bash", { command: "cd app\nnpm ci\nnpm test" }),
    "cd app …(+2 行)",
  );
  assert.equal(
    summarizeToolCall("read", { path: "src/a.ts", startLine: 10, endLine: 20 }),
    "src/a.ts:10-20",
  );
  assert.equal(summarizeToolCall("write", { path: "out.txt", content: "a\nb" }), "out.txt");
  assert.equal(summarizeToolCall("grep", { query: "TODO", path: "packages" }), '"TODO" · packages');
  assert.equal(
    summarizeToolCall("webfetch", { url: "https://example.com" }),
    "https://example.com",
  );
  assert.equal(summarizeToolCall("mcp__x__y", { id: 1 }), 'id: "1"');
  assert.doesNotMatch(summarizeToolCall("bash", { command: "echo \x1b[31mred" }), /\x1b/);
});

test("tool result summaries surface exit codes, counts and rejections", () => {
  const bashOk = summarizeToolResult(
    "bash",
    "[命令执行结果 - 退出码 0；耗时 5ms]\n--- 标准输出 (stdout，保留头尾) ---\nstep 1\nstep 2\n\n[verification_evidence_id: c1]",
    { blocked: false },
  );
  assert.deepEqual(bashOk, { status: "success", text: "2 行输出 · step 2" });

  const bashFailed = summarizeToolResult(
    "bash",
    "[命令执行结果 - 退出码 2；耗时 5ms]\n--- 标准错误 (stderr，保留头尾) ---\nboom\n",
    { blocked: false },
  );
  assert.equal(bashFailed.status, "failed");
  assert.match(bashFailed.text, /退出码 2 · 1 行输出 · boom/);

  assert.deepEqual(
    summarizeToolResult(
      "read",
      "[文件读取结果 - a]\n总行数=29；返回=1-29；hash=x；hasMore=false\n1 | {",
      {
        blocked: false,
      },
    ),
    { status: "success", text: "29 行" },
  );
  assert.deepEqual(
    summarizeToolResult("grep", "[Grep]\n引擎=ripgrep；offset=0；limit=20；返回=7；hasMore=true", {
      blocked: false,
    }),
    { status: "success", text: "7 条结果（还有更多）" },
  );
  assert.deepEqual(
    summarizeToolResult("edit", "编辑失败: 在文件中找不到指定的 oldText 原文", { blocked: false }),
    { status: "failed", text: "编辑失败: 在文件中找不到指定的 oldText 原文" },
  );
  assert.deepEqual(
    summarizeToolResult("bash", "错误: 用户拒绝了此命令的执行请求。", {
      blocked: true,
      rejected: true,
    }),
    { status: "rejected", text: "已拒绝执行" },
  );
  const policy = summarizeToolResult(
    "bash",
    '[安全引擎拒绝拦截] 命令 "bash" 被 Auto 分类器检测为超出允许的危险阈值 (high)。拒绝原因: 删除系统目录。请重新分析',
    { blocked: true, rejected: true },
  );
  assert.equal(policy.status, "rejected");
  assert.match(policy.text, /安全策略拦截.*删除系统目录/);
  assert.deepEqual(summarizeToolResult("grep", "错误: 缺少 query 参数。", { blocked: true }), {
    status: "failed",
    text: "缺少 query 参数。",
  });
});

test("tool durations use ms below a second and one decimal below a minute", () => {
  assert.equal(formatToolDuration(5), "5ms");
  assert.equal(formatToolDuration(6_049), "6.0s");
  assert.equal(formatToolDuration(65_000), "1m05s");
});

test("tool cells fit the given width and expand results on a second row", () => {
  const rows = formatToolCell({
    status: "success",
    toolName: "bash",
    summary: `for i in ${"1 ".repeat(60)}; do echo $i; done`,
    width: 60,
    timing: "6.0s",
    resultText: "6 行输出 · step 6",
  });
  assert.equal(rows.length, 2);
  assert.ok(terminalWidth(rows[0]) <= 60, `header width ${terminalWidth(rows[0])}`);
  assert.match(rows[0], /^ {2}✓ bash {2}for i in .*… +6\.0s$/);
  assert.equal(rows[1], "    └ 6 行输出 · step 6");

  const running = formatToolCell({
    status: "running",
    toolName: "bash",
    summary: "make",
    width: 40,
    spinner: "⠋",
    timing: "3s",
    outputTail: ["compiling a", "compiling b"],
  });
  assert.match(running[0], /^ {2}⠋ bash {2}make +3s$/);
  assert.deepEqual(running.slice(1), ["    │ compiling a", "    │ compiling b"]);
});

test("permission preview shows the complete command and the files being written", () => {
  const preview = buildPermissionPreview(
    "bash",
    { command: "for i in 1 2 3; do\n  echo $i\ndone" },
    "/tmp/project",
  );
  assert.deepEqual(preview.slice(0, 3), ["for i in 1 2 3; do", "  echo $i", "done"]);
  assert.match(preview[3], /工作目录 \/tmp\/project/);

  const write = buildPermissionPreview(
    "write",
    { path: "definitely-missing-file.txt", content: "hello\nworld\n" },
    os.tmpdir(),
  );
  assert.match(write[0], /definitely-missing-file\.txt {2}新建文件 · 2 行/);
  assert.deepEqual(write.slice(1), ["+ hello", "+ world"]);

  const edit = buildPermissionPreview("edit", { path: "a.ts", oldText: "x", newText: "y" }, "/");
  assert.deepEqual(edit, ["a.ts", "- x", "+ y"]);
});

test("model errors are classified with a specific next step", () => {
  const providerError = (message, status) => Object.assign(new Error(message), { status });
  const cases = [
    [
      providerError("Authentication Fails, Your api key is invalid", 401),
      /^认证失败（401）$/,
      /\/provider/,
    ],
    [providerError("Insufficient Balance", 402), /^账户额度不足/, /余额/],
    [providerError("Rate limit reached", 429), /^请求过于频繁/, /稍等/],
    [
      new Error("This model's maximum context length is 65536 tokens"),
      /^上下文超出模型窗口$/,
      /\/compact/,
    ],
    [providerError("Model Not Exist", 400), /^模型不可用/, /\/model/],
    [
      Object.assign(new Error("无法连接目标服务（ECONNREFUSED）"), { name: "ConnectionError" }),
      /^网络连接失败$/,
      /HAJI_PROXY/,
    ],
    [providerError("Service Unavailable", 503), /^模型服务暂时不可用/, /稍后/],
    [new Error("something odd"), /^模型调用出错$/, /\/config/],
  ];
  for (const [error, title, hint] of cases) {
    const described = describeModelError(error);
    assert.match(described.title, title, error.message);
    assert.match(described.hint, hint, error.message);
    assert.equal(described.detail, error.message);
  }
});

test("reasoning preview shows the last wrapped rows within the width", () => {
  const reasoning = `${"先确认需求。".repeat(30)}\n最后一步：检查输出。`;
  const preview = formatReasoningPreview(reasoning, 40);
  const rows = preview.split("\n").filter(Boolean);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.ok(terminalWidth(row) <= 40, row);
  assert.match(rows.map((row) => row.replace(/^ {2}┊ /, "")).join(""), /最后一步：检查输出。$/);
  assert.doesNotMatch(preview, /\x1b/, "no stray escape codes in no-color mode");
  assert.equal(formatReasoningPreview("  \n ", 40), "");
});

test("session grants scope bash approvals to a command prefix", () => {
  assert.deepEqual(getPermissionGrant("bash", { command: "npm test -- --watch" }), {
    key: "bash:npm test",
    scope: "npm test 开头的命令",
  });
  assert.equal(getPermissionGrant("bash", { command: "python scripts/a.py" })?.key, "bash:python");
  // 旗标不作为子命令；组合/重定向命令无法按前缀安全授权。
  assert.equal(getPermissionGrant("bash", { command: "git -C x status" })?.key, "bash:git");
  assert.equal(getPermissionGrant("bash", { command: "npm test && rm -rf ." }), undefined);
  assert.equal(getPermissionGrant("bash", { command: "echo hi > a.txt" }), undefined);
  assert.equal(getPermissionGrant("edit", { path: "a.ts" })?.scope, "编辑文件");
  assert.equal(getPermissionGrant("mcp_x_y", {})?.key, "mcp_x_y");
});

test("edit and write summaries report line counts from the call arguments", () => {
  const edit = summarizeToolResult(
    "edit",
    "[文件精准编辑成功]\n路径: a.ts",
    { blocked: false },
    { oldText: "a\nb", newText: "a\nb\nc\n" },
  );
  assert.equal(edit.text, "已替换 1 处 · +3 −2 行");
  assert.equal(
    summarizeToolResult("edit", "[文件精准编辑成功]", { blocked: false }).text,
    "已替换 1 处",
  );
  const write = summarizeToolResult(
    "write",
    "[文件写入成功]\n大小: 2048 字节",
    { blocked: false },
    { content: "x\ny\n" },
  );
  assert.equal(write.text, "已写入 2.0 KB · 2 行");
});

test("expanded tool output caps lines and strips terminal escapes", () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index}\x1b[31m`).join("\n");
  const rows = formatExpandedToolOutput("bash", "ls -la", output, 80, 3);
  assert.equal(rows.length, 5);
  assert.match(rows[0], /bash {2}ls -la/);
  assert.match(rows[1], /│ line 0$/);
  assert.match(rows.at(-1), /另有 7 行未显示/);
  assert.doesNotMatch(rows.join("\n"), /\x1b\[31m/);
});

test("workspace label abbreviates home and shows the git branch", () => {
  const home = os.homedir();
  assert.equal(formatWorkspaceLabel(path.join(home, "proj"), "main"), `~${path.sep}proj (main)`);
  assert.equal(formatWorkspaceLabel("/srv/app"), "/srv/app");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "haji-git-"));
  try {
    const nested = path.join(tmp, "a", "b");
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(tmp, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    const headPath = findGitHeadPath(nested);
    assert.equal(headPath, path.join(tmp, ".git", "HEAD"));
    assert.equal(readGitBranch(headPath), "feature/x");
    fs.writeFileSync(path.join(tmp, ".git", "HEAD"), "0123456789abcdef\n");
    assert.equal(readGitBranch(headPath), "0123456");
    assert.equal(readGitBranch(undefined), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("failed bash summaries surface the first error line instead of trailing noise", () => {
  const summary = summarizeToolResult(
    "bash",
    "[命令执行结果 - 退出码 1；耗时 5ms]\n--- 标准错误 (stderr，保留头尾) ---\nnpm ERR! Missing script: test\nnpm ERR! A complete log of this run can be found in: /tmp/x.log\n",
    { blocked: false },
  );
  assert.equal(summary.status, "failed");
  assert.match(summary.text, /退出码 1 · 2 行输出 · npm ERR! Missing script: test$/);
});
