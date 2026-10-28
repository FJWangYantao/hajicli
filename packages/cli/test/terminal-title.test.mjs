import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { terminalWidth } from "../dist/terminal-text.js";
import {
  buildTitleSequence,
  createTerminalTitleReporter,
  formatTerminalTitle,
  MAX_TITLE_WIDTH,
} from "../dist/terminal-title.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

test("标题形态是「haji · 会话标题」，没有会话标题时只留 haji", () => {
  assert.equal(formatTerminalTitle("修 Kero 标题上报"), "haji · 修 Kero 标题上报");
  assert.equal(formatTerminalTitle(""), "haji");
  assert.equal(formatTerminalTitle(undefined), "haji");
  assert.equal(formatTerminalTitle("   "), "haji");
  // 前缀可换，便于别的入口复用。
  assert.equal(formatTerminalTitle("部署", "haji-dev"), "haji-dev · 部署");
});

test("控制字符 / 换行 / 零宽与双向控制符会被压掉，不留裸 ESC 打断 OSC", () => {
  const title = formatTerminalTitle("修\u0007标题\n第二行\u001b]2;evil\u202e");
  assert.equal(title.includes("\x1b"), false);
  assert.equal(title.includes("\u0007"), false);
  assert.equal(title.includes("\n"), false);
  assert.equal(title.includes("\u202e"), false);
  assert.equal(title, "haji · 修 标题 第二行 ]2;evil");
});

test("超长标题按显示宽度截断（CJK 占两列），不会劈开字符", () => {
  const title = formatTerminalTitle("汉".repeat(200));
  assert.ok(terminalWidth(title) <= MAX_TITLE_WIDTH, `width ${terminalWidth(title)}`);
  assert.match(title, /…$/);
  assert.doesNotMatch(title, /\uFFFD/);
  assert.equal(formatTerminalTitle("汉".repeat(200)).includes("汉"), true);
});

test("报文是 OSC 2 + BEL，不含裸控制字符", () => {
  const sequence = buildTitleSequence("haji · 修 Kero");
  assert.equal(sequence, "\x1b]2;haji · 修 Kero\x07");
  assert.equal(sequence.endsWith("\x07"), true);
  // 只有开头那个 ESC 是转义的一部分。
  assert.equal(sequence.slice(2).includes("\x1b"), false);
});

test("判定与状态上报同一套：KERO_PANE / ssh 会话才写，其它环境一个字节都不发", () => {
  const writes = [];
  const make = (env, isTTY = true) =>
    createTerminalTitleReporter({ env, isTTY, write: (sequence) => writes.push(sequence) });

  assert.equal(make({}).enabled, false);
  make({}).set("标题");
  assert.deepEqual(writes, []);

  const kero = make({ KERO_PANE: "p1" });
  assert.equal(kero.enabled, true);
  kero.set("标题");
  assert.equal(writes.length, 1);

  const ssh = make({ SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" });
  assert.equal(ssh.enabled, true);

  // stdout 不是终端（--output-format json 的管道）时不上报。
  assert.equal(make({ KERO_PANE: "p1" }, false).enabled, false);
  // 显式关闭优先。
  assert.equal(make({ KERO_PANE: "p1", HAJI_STATUS_REPORT: "0" }).enabled, false);
});

test("同一条标题只写一次，换标题才再写；运行期关掉后不再写", () => {
  const writes = [];
  const reporter = createTerminalTitleReporter({
    env: { KERO_PANE: "p1" },
    isTTY: true,
    write: (sequence) => writes.push(sequence),
  });
  reporter.set("新对话会话");
  reporter.set("新对话会话");
  assert.equal(writes.length, 1);
  assert.equal(writes[0], buildTitleSequence("haji · 新对话会话"));
  // 自动生成的标题到了：换一条。
  reporter.set("修 Kero 标题上报");
  assert.equal(writes.length, 2);
  // 无头模式关掉后静默。
  reporter.setEnabled(false);
  reporter.set("另一个标题");
  assert.equal(writes.length, 2);
});

test("写终端失败（EPIPE）不影响主流程", () => {
  const reporter = createTerminalTitleReporter({
    env: { KERO_PANE: "p1" },
    isTTY: true,
    write: () => {
      throw new Error("EPIPE");
    },
  });
  assert.doesNotThrow(() => reporter.set("标题"));
});

test("updateStatusUI 负责同步标题，无头模式关掉（index.ts 源码断言）", () => {
  const source = fs.readFileSync(path.resolve(testDir, "../src/index.ts"), "utf8");
  assert.match(source, /terminalTitle\.set\(sessionManager\.getCurrentSession\(\)\.title\)/);
  assert.match(source, /terminalTitle\.setEnabled\(false\)/);
  // 与 ui.setSessionTitle 同一个函数里同步：/resume、/clear、标题生成都经过它。
  const statusUiBody = source.slice(source.indexOf("const updateStatusUI = () => {"));
  const body = statusUiBody.slice(0, statusUiBody.indexOf("\n  };"));
  assert.match(body, /ui\.setSessionTitle\(/);
  assert.match(body, /terminalTitle\.set\(/);
});
