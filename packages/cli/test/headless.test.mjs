import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseHeadlessArgs, parseSessionResumeArgs } from "../dist/headless.js";

/** dist 入口按测试文件位置解析，兼容从仓库根或包目录发起的 node --test。 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("parseHeadlessArgs returns empty when no -p flag is present", () => {
  assert.deepEqual(parseHeadlessArgs([]), {});
  assert.deepEqual(parseHeadlessArgs(["--permission-mode", "auto"]), {});
  assert.deepEqual(parseHeadlessArgs(["--something-else", "x"]), {});
});

test("parseHeadlessArgs accepts -p and --print with a prompt", () => {
  assert.deepEqual(parseHeadlessArgs(["-p", "解释这段代码"]), {
    request: { prompt: "解释这段代码", permissionMode: undefined, outputFormat: undefined },
  });
  assert.deepEqual(parseHeadlessArgs(["--print", "hello"]), {
    request: { prompt: "hello", permissionMode: undefined, outputFormat: undefined },
  });
});

test("parseHeadlessArgs combines -p with --permission-mode in any order", () => {
  assert.deepEqual(parseHeadlessArgs(["-p", "hi", "--permission-mode", "accept-edit"]), {
    request: { prompt: "hi", permissionMode: "accept-edit", outputFormat: undefined },
  });
  assert.deepEqual(parseHeadlessArgs(["--permission-mode", "auto", "-p", "hi"]), {
    request: { prompt: "hi", permissionMode: "auto", outputFormat: undefined },
  });
  assert.deepEqual(parseHeadlessArgs(["-p", "hi", "--output-format", "json"]), {
    request: { prompt: "hi", permissionMode: undefined, outputFormat: "json" },
  });
  assert.match(
    parseHeadlessArgs(["-p", "hi", "--output-format", "xml"]).error ?? "",
    /text 或 json/,
  );
});

test("parseHeadlessArgs rejects missing prompt and invalid modes", () => {
  assert.match(parseHeadlessArgs(["-p"]).error ?? "", /需要一个 prompt 参数/);
  assert.match(parseHeadlessArgs(["-p", "--permission-mode"]).error ?? "", /需要一个 prompt 参数/);
  assert.match(
    parseHeadlessArgs(["-p", "hi", "--permission-mode"]).error ?? "",
    /需要一个模式参数/,
  );
  assert.match(
    parseHeadlessArgs(["-p", "hi", "--permission-mode", "yolo"]).error ?? "",
    /无效权限模式/,
  );
  assert.equal(parseHeadlessArgs(["-p", "hi", "--permission-mode", "plan"]).error, undefined);
});

test("parseHeadlessArgs 接受 --allow 放行键（可重复、不落盘）", () => {
  assert.deepEqual(
    parseHeadlessArgs(["-p", "hi", "--allow", "bash:npm test", "--allow=write"]).request,
    {
      prompt: "hi",
      permissionMode: undefined,
      outputFormat: undefined,
      allow: ["bash:npm test", "write"],
    },
  );
  // 与权限档位同时使用、顺序无关
  assert.deepEqual(
    parseHeadlessArgs([
      "--allow",
      "bash:node verify.js",
      "-p",
      "hi",
      "--permission-mode",
      "accept-edit",
    ]).request,
    {
      prompt: "hi",
      permissionMode: "accept-edit",
      outputFormat: undefined,
      allow: ["bash:node verify.js"],
    },
  );
  // 没写 --allow 时字段缺省，保持既有断言与调用方行为不变
  assert.deepEqual(parseHeadlessArgs(["-p", "hi"]).request, {
    prompt: "hi",
    permissionMode: undefined,
    outputFormat: undefined,
  });
});

test("parseHeadlessArgs 拒绝非法 --allow 键", () => {
  // 缺参数
  assert.match(parseHeadlessArgs(["-p", "hi", "--allow"]).error ?? "", /需要一个放行键/);
  assert.match(parseHeadlessArgs(["-p", "hi", "--allow", "--x"]).error ?? "", /需要一个放行键/);
  // 组合命令拿不到 grant，写进来只会是永远不命中的死规则
  assert.match(
    parseHeadlessArgs(["-p", "hi", "--allow", "bash:npm test && rm -rf ."]).error ?? "",
    /无效的 --allow 放行键/,
  );
  assert.match(parseHeadlessArgs(["-p", "hi", "--allow=*"]).error ?? "", /无效的 --allow 放行键/);
  assert.match(
    parseHeadlessArgs(["-p", "hi", "--allow=bash:"]).error ?? "",
    /无效的 --allow 放行键/,
  );
});

test("parseHeadlessArgs 拒绝永远不生效的 --allow 用法", () => {
  // bash 的授权键只有 bash:<前缀> 一种形态，裸 bash 能过正则却匹配不到任何命令。
  assert.match(parseHeadlessArgs(["-p", "hi", "--allow", "bash"]).error ?? "", /bash:<命令前缀>/);
  assert.match(parseHeadlessArgs(["-p", "hi", "--allow=Bash"]).error ?? "", /bash:<命令前缀>/);
  // 没有 -p 时 --allow 不会被使用，报错而不是静默忽略。
  assert.match(parseHeadlessArgs(["--allow", "write"]).error ?? "", /只在无头模式/);
  assert.deepEqual(parseHeadlessArgs(["--allow", "write", "-p", "hi"]).request?.allow, ["write"]);
});

test("index.ts wires the headless branch end to end", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(source.includes("parseHeadlessArgs(cliArgs)"), "启动时解析 -p 参数");
  assert.ok(source.includes("forceNonInteractive: quietMode"), "TerminalUI 强制非交互");
  assert.ok(source.includes('compactHeader: quietMode ? "" :'), "无头模式下不在 stdout 打印头部");
  assert.ok(source.includes("无头模式不支持 Plan 审批"), "plan 档自动升级为 default");
  assert.ok(
    source.includes("headlessRequest && !process.stdin.isTTY"),
    "管道/CI 下未命中放行规则时自动拒绝",
  );
  // 主循环顶部的无头分支：跑完一个回合即 break 进入退出清理
  const loopStart = source.indexOf("while (true) {");
  const headlessBranch = source.indexOf("if (headlessRequest) {", loopStart);
  assert.ok(loopStart >= 0 && headlessBranch > loopStart, "主循环内有无头分支");
  const turnCall = source.indexOf("runAgentTurn(headlessTurnDeps", headlessBranch);
  const loopBreak = source.indexOf("break;", headlessBranch);
  assert.ok(turnCall > headlessBranch && loopBreak > turnCall, "无头分支跑完回合即退出循环");
  // 无头下不挂后台输入 readline
  assert.match(
    source.slice(
      source.indexOf("const startBackgroundInput"),
      source.indexOf("const startBackgroundInput") + 300,
    ),
    /if \(quietMode\) return;/,
  );
});

test("smoke: -p without any API key exits 1 with a config hint on stderr", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-headless-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.DEEPSEEK_API_KEY;
    delete env.VOLC_API_KEY;
    delete env.ARK_API_KEY;
    const result = spawnSync(process.execPath, [cliEntry, "-p", "hi"], {
      cwd: path.dirname(cliEntry),
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1, "缺 key 应以退出码 1 结束");
    assert.match(result.stderr, /DEEPSEEK_API_KEY|VOLC_API_KEY/, "stderr 应给出配置指引");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("smoke: -p without a prompt argument exits 1 with usage hint", () => {
  const result = spawnSync(process.execPath, [cliEntry, "-p"], {
    cwd: path.dirname(cliEntry),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /需要一个 prompt 参数/);
});

test("parseSessionResumeArgs supports -c/--continue and -r/--resume", () => {
  assert.deepEqual(parseSessionResumeArgs([]), undefined);
  assert.deepEqual(parseSessionResumeArgs(["-c"]), { mode: "latest" });
  assert.deepEqual(parseSessionResumeArgs(["--continue"]), { mode: "latest" });
  assert.deepEqual(parseSessionResumeArgs(["-r", "重构"]), {
    mode: "search",
    keyword: "重构",
  });
  // 旗标后没有参数：进入搜索选择器（不带关键词）。
  assert.deepEqual(parseSessionResumeArgs(["--resume"]), { mode: "search" });
  // 其他旗标不会被误认为关键词。
  assert.deepEqual(parseSessionResumeArgs(["-r", "--help"]), { mode: "search" });
});
