import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HookEngine } from "@hajicli/core";
import { describeHookLoadWarnings } from "../dist/extension-commands.js";
import {
  hookMatchesTool,
  loadUserHooks,
  parseHooksFile,
  runHookCommand,
  trustProjectHooks,
  UserHookRunner,
} from "../dist/user-hooks.js";

/**
 * 用户 Hook：配置解析、项目级按内容哈希信任、四个事件的语义，以及真子进程里
 * 「拦截 / 反馈回注 / 补充上下文」确实到达模型（回注必须排在工具结果之后）。
 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const posix = process.platform !== "win32";

function withIsolatedHome(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-hooks-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  fs.mkdirSync(path.join(home, ".haji"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".haji"), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return run({ root, home, cwd });
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

test("parseHooksFile keeps good entries and reports bad ones", () => {
  const parsed = parseHooksFile(
    JSON.stringify({
      PreToolUse: [
        { matcher: "bash|write", command: "guard.sh", timeoutMs: 5000 },
        { matcher: "(", command: "bad-regex" },
        { command: "" },
      ],
      Stop: [{ command: "notify" }],
      Nope: [],
    }),
    "user",
  );
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.event, entry.command, entry.matcher, entry.timeoutMs]),
    [
      ["PreToolUse", "guard.sh", "bash|write", 5000],
      ["Stop", "notify", undefined, 30000],
    ],
  );
  assert.equal(parsed.errors.length, 3);
  assert.match(parsed.errors.join("\n"), /不是合法正则/);
  assert.match(parsed.errors.join("\n"), /缺少 command/);
  assert.match(parsed.errors.join("\n"), /未知事件 Nope/);
  // 外层包一层 hooks 也接受；坏 JSON 只报错不抛。
  assert.equal(parseHooksFile('{"hooks":{"Stop":[{"command":"x"}]}}', "user").entries.length, 1);
  assert.match(parseHooksFile("{", "user").errors[0], /JSON 解析失败/);
});

test("matcher is a whole-name, case-insensitive regex; empty or * matches everything", () => {
  const entry = (matcher) => ({
    event: "PreToolUse",
    command: "x",
    matcher,
    timeoutMs: 1,
    scope: "user",
  });
  assert.ok(hookMatchesTool(entry("bash"), "Bash"));
  assert.ok(!hookMatchesTool(entry("bash"), "bashful"));
  assert.ok(hookMatchesTool(entry("write|edit"), "edit"));
  assert.ok(hookMatchesTool(entry(undefined), "read"));
  assert.ok(hookMatchesTool(entry("*"), "read"));
});

test("project hooks run only after their exact content is trusted", () => {
  withIsolatedHome(({ home, cwd }) => {
    fs.writeFileSync(path.join(home, ".haji", "hooks.json"), '{"Stop":[{"command":"user-stop"}]}');
    const projectFile = path.join(cwd, ".haji", "hooks.json");
    fs.writeFileSync(projectFile, '{"PreToolUse":[{"command":"project-guard"}]}');

    let loaded = loadUserHooks(cwd, {});
    assert.equal(loaded.project?.trusted, false);
    assert.deepEqual(
      loaded.active.map((entry) => entry.command),
      ["user-stop"],
    );
    const warnings = describeHookLoadWarnings(loaded, false);
    assert.match(warnings.join("\n"), /尚未信任.*\/hooks trust/);

    assert.ok(trustProjectHooks(cwd, loaded.project.hash));
    loaded = loadUserHooks(cwd, {});
    assert.equal(loaded.project?.trusted, true);
    assert.deepEqual(
      loaded.active.map((entry) => entry.command),
      ["user-stop", "project-guard"],
    );

    // 内容一改就失效，需要重新信任。
    fs.writeFileSync(projectFile, '{"PreToolUse":[{"command":"project-guard --evil"}]}');
    loaded = loadUserHooks(cwd, {});
    assert.equal(loaded.project?.trusted, false);
    // CI 显式信任。
    assert.equal(loadUserHooks(cwd, { HAJI_TRUST_PROJECT_HOOKS: "1" }).project?.trusted, true);
  });
});

test("runner semantics: exit 2 blocks PreToolUse, feeds back PostToolUse, stdout adds context", async () => {
  const calls = [];
  const fakeRun = async (command, payload, options) => {
    calls.push({ command, payload: JSON.parse(payload), env: options.env });
    const [code, stdout = "", stderr = ""] = JSON.parse(command);
    return { code, stdout, stderr, timedOut: false };
  };
  const warnings = [];
  const injected = [];
  const runner = new UserHookRunner({
    warn: (message) => warnings.push(message),
    inject: (content, event) => injected.push([event, content]),
    getSessionId: () => "s-1",
    run: fakeRun,
  });
  const entries = [
    { event: "PreToolUse", matcher: "bash", command: JSON.stringify([2, "", "禁止 rm"]) },
    { event: "PreToolUse", matcher: "read", command: JSON.stringify([1, "", "脚本坏了"]) },
    { event: "PostToolUse", matcher: "write", command: JSON.stringify([2, "", "lint: 少分号"]) },
    { event: "UserPromptSubmit", command: JSON.stringify([0, "branch: main"]) },
  ].map((entry) => ({ ...entry, timeoutMs: 1000, scope: "user" }));
  // dispatch 读 this.loaded：直接覆写私有字段模拟 reload。
  runner.loaded = { user: { entries, errors: [] }, active: entries };

  const engine = new HookEngine();
  runner.registerPreToolUse(engine);
  engine.register("PreToolUse", () => null);
  runner.registerAfterBuiltins(engine);

  const blocked = await engine.trigger("PreToolUse", {
    toolName: "bash",
    args: { command: "rm -rf x" },
    cwd: "/tmp",
  });
  assert.match(blocked, /\[Hook 拦截\] 工具 "bash" 未执行/);
  assert.match(blocked, /禁止 rm/);
  assert.equal(calls[0].payload.toolName, "bash");
  assert.equal(calls[0].payload.sessionId, "s-1");
  assert.equal(calls[0].env.HAJI_TOOL_NAME, "bash");

  // 非 0/2 只告警、不拦截，且同类问题只提示一次。
  assert.equal(await engine.trigger("PreToolUse", { toolName: "read", args: {} }), null);
  assert.equal(await engine.trigger("PreToolUse", { toolName: "read", args: {} }), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /退出码 1：脚本坏了/);

  // 工具被拦下时 PostToolUse 不跑；真正执行过才回注。
  await engine.trigger("PostToolUse", { toolName: "write", args: { path: "a.ts" }, blocked: true });
  assert.equal(injected.length, 0);
  await engine.trigger("PostToolUse", { toolName: "write", args: { path: "a.ts" }, cwd: "/w" });
  assert.equal(calls.at(-1).env.HAJI_TOOL_PATH, path.resolve("/w", "a.ts"));
  assert.deepEqual(injected[0][0], "PostToolUse");
  assert.match(injected[0][1], /\[Hook 反馈 · PostToolUse\[write\]/);
  assert.match(injected[0][1], /lint: 少分号/);

  await engine.trigger("UserPromptSubmit", { messages: [{ role: "user", content: "改一下" }] });
  assert.equal(calls.at(-1).payload.prompt, "改一下");
  assert.match(injected[1][1], /^\[Hook 上下文 · UserPromptSubmit .*\]\nbranch: main$/);
});

test("runHookCommand pipes the payload to stdin and kills on timeout", {
  skip: !posix,
}, async () => {
  const echoed = await runHookCommand('cat; echo " $HAJI_HOOK_EVENT" 1>&2; exit 3', '{"a":1}', {
    cwd: os.tmpdir(),
    timeoutMs: 5000,
    env: { ...process.env, HAJI_HOOK_EVENT: "Stop" },
  });
  assert.equal(echoed.code, 3);
  assert.equal(echoed.stdout, '{"a":1}');
  assert.equal(echoed.stderr.trim(), "Stop");

  const started = Date.now();
  const slow = await runHookCommand("sleep 5", "", { cwd: os.tmpdir(), timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 3000, "timeout must kill the process group promptly");
});

// ---- 端到端：假模型 + 真子进程 ----

const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;

async function startFakeModel() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    const messages = payload.messages ?? [];
    if (payload.tools) requests.push(messages);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const last = messages.at(-1);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const hasToolResult = messages.some((message) => message.role === "tool");
    if (payload.tools && !hasToolResult && String(lastUser?.content).includes("WRITE")) {
      const toolCall = {
        index: 0,
        id: "call_w1",
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: "a.txt", content: "hi\n" }) },
      };
      res.end(`${sse({ tool_calls: [toolCall] })}${sse({}, "tool_calls")}data: [DONE]\n\n`);
      return;
    }
    res.end(`${sse({ content: `完成（${last?.role}）` }, "stop")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function runHeadless(baseUrl, { home, cwd }, args) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DEEPSEEK_API_KEY: "sk-fake-for-test",
    DEEPSEEK_BASE_URL: baseUrl,
    HAJI_POST_EDIT_VERIFY: "0",
  };
  delete env.VOLC_API_KEY;
  delete env.ARK_API_KEY;
  delete env.HAJI_TRUST_PROJECT_HOOKS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-hooks-e2e-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  fs.mkdirSync(path.join(home, ".haji"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".haji"), { recursive: true });
  return { root, home, cwd };
}

test("e2e: PostToolUse feedback lands after the tool result, prompt context reaches the model", {
  skip: !posix,
}, async () => {
  const model = await startFakeModel();
  try {
    const sandbox = makeSandbox();
    const log = path.join(sandbox.root, "stop.log");
    fs.writeFileSync(
      path.join(sandbox.home, ".haji", "hooks.json"),
      JSON.stringify({
        UserPromptSubmit: [{ command: "echo 当前分支 feature-x" }],
        PostToolUse: [
          {
            matcher: "write",
            command: 'echo "lint 失败: $(basename "$HAJI_TOOL_PATH")" >&2; exit 2',
          },
        ],
        Stop: [{ command: `cat > ${JSON.stringify(log)}` }],
      }),
    );
    const result = await runHeadless(model.baseUrl, sandbox, [
      "-p",
      "WRITE a file",
      "--permission-mode",
      "bypass-permissions",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(sandbox.cwd, "a.txt"), "utf8"), "hi\n");

    const first = model.requests[0];
    const context = first.find((message) => String(message.content).includes("[Hook 上下文"));
    assert.ok(context, "UserPromptSubmit stdout must be injected before the first request");
    assert.match(context.content, /当前分支 feature-x/);

    // 第二次请求：assistant(tool_calls) → tool(真实结果) → system(Hook 反馈)，顺序不能乱。
    const second = model.requests[1];
    const toolIndex = second.findIndex((message) => message.role === "tool");
    assert.ok(toolIndex > 0);
    assert.equal(second[toolIndex - 1].role, "assistant");
    assert.doesNotMatch(second[toolIndex].content, /工具执行状态未知/);
    const feedback = second.at(-1);
    assert.equal(feedback.role, "system");
    assert.match(feedback.content, /\[Hook 反馈 · PostToolUse\[write\]/);
    assert.match(feedback.content, /lint 失败: a\.txt/);

    const stopPayload = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.equal(stopPayload.event, "Stop");
    assert.ok(stopPayload.sessionId);
  } finally {
    model.close();
  }
});

test("e2e: PreToolUse exit 2 blocks the call; untrusted project hooks never run", {
  skip: !posix,
}, async () => {
  const model = await startFakeModel();
  try {
    const sandbox = makeSandbox();
    const marker = path.join(sandbox.root, "project-hook-ran");
    fs.writeFileSync(
      path.join(sandbox.home, ".haji", "hooks.json"),
      JSON.stringify({
        PreToolUse: [{ matcher: "write", command: 'echo "a.txt 不许写" >&2; exit 2' }],
      }),
    );
    fs.writeFileSync(
      path.join(sandbox.cwd, ".haji", "hooks.json"),
      JSON.stringify({ PreToolUse: [{ command: `touch ${JSON.stringify(marker)}` }] }),
    );
    const result = await runHeadless(model.baseUrl, sandbox, [
      "-p",
      "WRITE a file",
      "--permission-mode",
      "bypass-permissions",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!fs.existsSync(path.join(sandbox.cwd, "a.txt")), "blocked write must not run");
    assert.ok(!fs.existsSync(marker), "untrusted project hook must not run");
    assert.match(result.stderr, /项目级 hooks（1 条）未信任/);
    const toolResult = model.requests[1].find((message) => message.role === "tool");
    assert.match(toolResult.content, /\[Hook 拦截\] 工具 "write" 未执行/);
    assert.match(toolResult.content, /a\.txt 不许写/);
  } finally {
    model.close();
  }
});
