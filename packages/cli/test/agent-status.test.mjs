import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildStatusSequence,
  createAgentStatusReporter,
  resolveStatusReportEnabled,
} from "../dist/agent-status.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

/** Kero 的 OSC 7501 语法约束（internal/daemon/osc.go）：整条不合规会被丢弃。 */
const KEY_RE = /^[a-z]{1,16}$/;
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const STATES = new Set(["idle", "working", "done", "blocked", "error", "clear"]);

function parseSequence(sequence) {
  assert.ok(sequence.startsWith("\x1b]7501;"), `bad prefix: ${JSON.stringify(sequence)}`);
  assert.ok(sequence.endsWith("\x1b\\"), "sequence must end with ST");
  assert.equal(sequence.slice(0, 2), "\x1b]", "no other bytes before the OSC");
  const body = sequence.slice("\x1b]7501;".length, -2);
  const pairs = {};
  for (const part of body.split(":")) {
    const [key, ...rest] = part.split("=");
    const value = rest.join("=");
    assert.match(key, KEY_RE, `bad key ${key}`);
    assert.match(value, VALUE_RE, `bad value for ${key}: ${value}`);
    pairs[key] = value;
  }
  return pairs;
}

test("Kero 里（$KERO_PANE）与 ssh 会话默认开启，其它本地环境默认不发", () => {
  assert.equal(resolveStatusReportEnabled({ KERO_PANE: "pane-1" }), true);
  assert.equal(resolveStatusReportEnabled({}), false);
  assert.equal(resolveStatusReportEnabled({ KERO_PANE: "" }), false);
  // ssh 不转发 KERO_PANE，但 OSC 会原样回到本机终端，所以 ssh 会话也开。
  assert.equal(resolveStatusReportEnabled({ SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" }), true);
  assert.equal(resolveStatusReportEnabled({ SSH_TTY: "/dev/pts/3" }), true);
  // 显式开关优先，便于在其它终端里试 / 关。
  assert.equal(resolveStatusReportEnabled({ HAJI_STATUS_REPORT: "0", KERO_PANE: "p" }), false);
  assert.equal(resolveStatusReportEnabled({ HAJI_STATUS_REPORT: "off", KERO_PANE: "p" }), false);
  assert.equal(
    resolveStatusReportEnabled({ HAJI_STATUS_REPORT: "0", SSH_TTY: "/dev/pts/3" }),
    false,
  );
  assert.equal(resolveStatusReportEnabled({ HAJI_STATUS_REPORT: "1" }), true);
});

test("报文满足 Kero 的语法：状态、app、base64 正文", () => {
  const sequence = buildStatusSequence({
    state: "working",
    message: "执行 read、grep",
  });
  const pairs = parseSequence(sequence);
  assert.equal(pairs.state, "working");
  assert.equal(pairs.app, "haji");
  assert.ok(STATES.has(pairs.state));
  assert.equal(Buffer.from(pairs.msg, "base64").toString("utf8"), "执行 read、grep");
});

test("kind 只在 blocked 时出现，progress 只在 working / blocked 时出现", () => {
  const blocked = parseSequence(
    buildStatusSequence({ state: "blocked", kind: "permission", message: "等待授权" }),
  );
  assert.equal(blocked.kind, "permission");
  assert.equal(Buffer.from(blocked.msg, "base64").toString("utf8"), "等待授权");

  // working 上的 kind 没有意义，按协议省略；非法进度也不发（整条仍合法）。
  const working = parseSequence(
    buildStatusSequence({ state: "working", kind: "question", progress: 42 }),
  );
  assert.equal(working.kind, undefined);
  assert.equal(working.progress, "42");

  const overflowing = parseSequence(
    buildStatusSequence({ state: "idle", progress: 120, message: "空闲" }),
  );
  assert.equal(overflowing.progress, undefined);

  const clear = parseSequence(buildStatusSequence({ state: "clear" }));
  assert.deepEqual(Object.keys(clear).sort(), ["app", "state"]);
  assert.equal(clear.state, "clear");
});

test("控制字符与换行会被压平，零宽/双向控制符被丢弃", () => {
  const pairs = parseSequence(
    buildStatusSequence({
      state: "working",
      message: "执行 bash\nrm -rf\u0007 /\u202e",
    }),
  );
  const text = Buffer.from(pairs.msg, "base64").toString("utf8");
  assert.equal(text, "执行 bash rm -rf /");
  // 报文本身除 OSC 前缀/结尾外不含裸控制字符。
  assert.doesNotMatch(pairs.msg, /[\u0000-\u001f]/u);
});

test("超长正文按 UTF-8 字符边界截断到 2048 字节内", () => {
  const pairs = parseSequence(
    buildStatusSequence({ state: "working", message: "汉".repeat(2000) }),
  );
  const bytes = Buffer.from(pairs.msg, "base64");
  assert.ok(bytes.length <= 2048, `decoded ${bytes.length} bytes`);
  assert.ok(bytes.length > 2000, "should keep as much as fits");
  const text = bytes.toString("utf8");
  assert.doesNotMatch(text, /\uFFFD/, "truncation must not split a code point");
});

test("最坏情况（长 title + 长 msg + 各字段）也短于 Kero 的单条 4096 字节上限", () => {
  const sequence = buildStatusSequence({
    state: "blocked",
    kind: "permission",
    progress: 100,
    title: "题".repeat(500),
    message: "汉".repeat(2000),
  });
  assert.ok(Buffer.byteLength(sequence, "utf8") < 4096, `sequence is ${sequence.length} bytes`);
  const pairs = parseSequence(sequence);
  // title 上限 192 字节（64 个汉字）。
  assert.ok(Buffer.from(pairs.title, "base64").length <= 192);
  assert.equal(Buffer.from(pairs.title, "base64").toString("utf8"), "题".repeat(64));
});

test("同一份状态重复上报只写一次，状态变化才再写", () => {
  const writes = [];
  const reporter = createAgentStatusReporter({
    env: { KERO_PANE: "p1" },
    isTTY: true,
    write: (sequence) => writes.push(sequence),
  });
  assert.equal(reporter.enabled, true);
  reporter.working("执行 read");
  reporter.working("执行 read");
  reporter.done("本轮完成");
  reporter.done("本轮完成");
  reporter.clear();
  assert.equal(writes.length, 3);
  assert.match(writes[0], /state=working/);
  assert.match(writes[1], /state=done/);
  assert.match(writes[2], /state=clear/);
  // 运行期关掉后不再写（无头模式走这条）。
  reporter.setEnabled(false);
  reporter.working("执行 grep");
  assert.equal(writes.length, 3);
});

test("不在 Kero 里时一个字节都不写", () => {
  const writes = [];
  const reporter = createAgentStatusReporter({
    env: {},
    isTTY: true,
    write: (sequence) => writes.push(sequence),
  });
  assert.equal(reporter.enabled, false);
  reporter.working("执行 read");
  reporter.blocked("permission", "等待授权");
  reporter.done("本轮完成");
  reporter.error("本轮失败");
  reporter.idle("已中止");
  reporter.clear();
  assert.deepEqual(writes, []);
});

test("stdout 不是终端时不上报（不污染 --output-format json 的管道）", () => {
  const writes = [];
  const reporter = createAgentStatusReporter({
    env: { KERO_PANE: "p1" },
    isTTY: false,
    write: (sequence) => writes.push(sequence),
  });
  assert.equal(reporter.enabled, false);
  reporter.working("执行 read");
  assert.deepEqual(writes, []);
});

test("写终端失败（EPIPE）不影响主流程", () => {
  const reporter = createAgentStatusReporter({
    env: { KERO_PANE: "p1" },
    isTTY: true,
    write: () => {
      throw new Error("EPIPE");
    },
  });
  assert.doesNotThrow(() => reporter.working("执行 read"));
});

test("回合生命周期挂上状态上报（turn-runner / index 源码断言）", () => {
  const turnSource = fs.readFileSync(path.resolve(testDir, "../src/turn-runner.ts"), "utf8");
  assert.match(turnSource, /agentStatus\.working\("正在思考"\)/);
  assert.match(turnSource, /agentStatus\.working\(\s*`执行 /);
  assert.match(turnSource, /agentStatus\.blocked\("question", "计划待审批"\)/);
  assert.match(turnSource, /agentStatus\.done\("本轮完成"\)/);
  assert.match(turnSource, /agentStatus\.error\("本轮失败"\)/);
  assert.match(turnSource, /agentStatus\.idle\("已中止"\)/);

  const indexSource = fs.readFileSync(path.resolve(testDir, "../src/index.ts"), "utf8");
  assert.match(indexSource, /agentStatus\.blocked\("permission", `等待授权/);
  assert.match(indexSource, /agentStatus\.blocked\("question", `Agent 申请/);
  assert.match(indexSource, /agentStatus\.setEnabled\(false\)/);
});
