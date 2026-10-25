import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { performanceMonitor } from "@hajicli/core";
import {
  buildConcurrentWriteNotice,
  buildConcurrentWriteSkipMessage,
  buildRepeatedFailureNotice,
  buildRepeatedFailureSkipMessage,
  classifyEditFailure,
  createToolCallBatches,
  EDIT_CONCURRENT_MARKER,
  isConcurrentWriteFailure,
  MAX_PARALLEL_READ_ONLY_TOOLS,
  normalizeFailureReason,
  RepeatedFailureTracker,
  raceWithAbort,
  runToolCallBatch,
} from "../dist/tool-batch.js";

const call = (id, name) => ({ id, function: { name } });

test("tool batching parallelizes only contiguous allowlisted read-only calls", () => {
  const batches = createToolCallBatches([
    call("1", "read"),
    call("2", "grep"),
    call("3", "global"),
    call("4", "projectinfo"),
    call("5", "edit"),
    call("6", "read"),
    call("7", "tasklist"),
    call("8", "webfetch"),
  ]);

  assert.equal(MAX_PARALLEL_READ_ONLY_TOOLS, 3);
  assert.deepEqual(
    batches.map((batch) => ({
      ids: batch.calls.map((item) => item.id),
      parallel: batch.parallel,
    })),
    [
      { ids: ["1", "2", "3"], parallel: true },
      { ids: ["4"], parallel: false },
      { ids: ["5"], parallel: false },
      { ids: ["6"], parallel: false },
      { ids: ["7"], parallel: false },
      { ids: ["8"], parallel: false },
    ],
  );
});

test("tool batching caps concurrency at three and treats bash, Skill and task calls as barriers", () => {
  const batches = createToolCallBatches([
    call("1", "read"),
    call("2", "grep"),
    call("3", "global"),
    call("4", "read"),
    call("5", "bash"),
    call("6", "loadskill"),
    call("7", "taskcreate"),
    call("8", "listskillresources"),
    call("9", "readskillresource"),
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.calls.map((item) => item.id)),
    [["1", "2", "3"], ["4"], ["5"], ["6"], ["7"], ["8", "9"]],
  );
  assert.deepEqual(
    batches.map((batch) => batch.parallel),
    [true, false, false, false, false, true],
  );
});

test("parallel batch preserves result order, bounds active work and records savings metrics", async () => {
  performanceMonitor.snapshot(true);
  let active = 0;
  let maxActive = 0;
  const batch = createToolCallBatches([
    call("slow", "read"),
    call("fast", "grep"),
    call("middle", "global"),
  ])[0];
  const delays = new Map([
    ["slow", 90],
    ["fast", 20],
    ["middle", 55],
  ]);

  const result = await runToolCallBatch(batch, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const duration = delays.get(item.id);
    await new Promise((resolve) => setTimeout(resolve, duration));
    active -= 1;
    return { id: item.id, duration };
  });

  assert.equal(maxActive, 3);
  assert.deepEqual(
    result.results.map((item) => item.id),
    ["slow", "fast", "middle"],
  );
  assert.equal(result.serialEstimateMs, 165);
  assert.ok(result.wallTimeMs < 150, `并发墙钟时间应小于串行估算，实际 ${result.wallTimeMs}`);
  assert.ok(result.savedTimeMs > 15);

  const metrics = performanceMonitor.snapshot(true).metrics;
  assert.equal(metrics["tool.batch.wall_time"].count, 1);
  assert.equal(metrics["tool.batch.serial_estimate"].count, 1);
  assert.equal(metrics["tool.batch.saved_time"].count, 1);
});

test("parallel batch lets one normal failed result coexist with successful siblings", async () => {
  performanceMonitor.snapshot(true);
  const batch = createToolCallBatches([
    call("ok-1", "read"),
    call("failed", "grep"),
    call("ok-2", "global"),
  ])[0];
  const result = await runToolCallBatch(batch, async (item) => ({
    id: item.id,
    duration: 1,
    blocked: item.id === "failed",
  }));
  assert.deepEqual(
    result.results.map((item) => [item.id, item.blocked]),
    [
      ["ok-1", false],
      ["failed", true],
      ["ok-2", false],
    ],
  );
  performanceMonitor.snapshot(true);
});

test("repeated failure tracker counts same tool, target and reason regardless of content", () => {
  const tracker = new RepeatedFailureTracker();
  const denied = "写入文件失败: 路径越出当前工作区，已拒绝访问: D:\\Desktop\\a.html\n说明";
  assert.equal(tracker.record("write", { path: "D:\\Desktop\\a.html", content: "v1" }, denied), 1);
  assert.equal(tracker.record("write", { path: "D:\\Desktop\\a.html", content: "v2" }, denied), 2);
  // 不同目标单独计数
  assert.equal(
    tracker.record("write", { path: "b.html", content: "x" }, "写入文件失败: 磁盘满"),
    1,
  );
  assert.equal(tracker.record("write", { path: "D:\\Desktop\\a.html", content: "v3" }, denied), 3);
});

test("repeated failure tracker resets the same tool and target after success", () => {
  const tracker = new RepeatedFailureTracker();
  const failed = "[退出码: 1]\nFAIL";
  assert.equal(tracker.record("bash", { command: "npm test" }, failed), 1);
  tracker.noteSuccess("bash", { command: "npm test" });
  assert.equal(tracker.record("bash", { command: "npm test" }, failed), 1);
  // 同一退出码、不同命令不算重复
  assert.equal(tracker.record("bash", { command: "npm run lint" }, failed), 1);
});

test("repeated failure tracker normalizes changing hashes into one reason", () => {
  const tracker = new RepeatedFailureTracker();
  const withHash = (expected, current) =>
    `编辑失败: [hash冲突] 文件已被外部修改（期望 hash=${expected}，当前 hash=${current}）。请重新读取后再编辑。\n细节`;
  assert.equal(
    tracker.record("edit", { path: "src/a.ts" }, withHash("0123456789abcdef", "fedcba9876543210")),
    1,
  );
  assert.equal(
    tracker.record("edit", { path: "src/a.ts" }, withHash("ffffffffffffffff", "1111222233334444")),
    2,
  );
  assert.equal(
    tracker.record("edit", { path: "src/a.ts" }, withHash("9999999999999999", "abcdefabcdefabcd")),
    3,
  );
});

test("edit failures keep counting across categories and are not cleared by read", () => {
  const tracker = new RepeatedFailureTracker();
  const miss = (category) => `编辑失败: 在文件中找不到指定的 oldText 原文（${category}）。\n线索`;
  assert.equal(tracker.record("edit", { path: "src/a.ts" }, miss("锚点行不存在")), 1);
  // 换了失败类别（缩进不一致）仍算同一个文件改不动
  assert.equal(tracker.record("edit", { path: "src/a.ts" }, miss("缩进或空白不一致")), 2);
  // 失败后先 read 是标准恢复动作；read 成功不能把 edit 的账洗掉
  tracker.noteSuccess("read", { path: "src/a.ts" });
  assert.equal(tracker.record("edit", { path: "src/a.ts" }, miss("锚点行不存在")), 3);
  // 真正改成功才清零
  tracker.noteSuccess("edit", { path: "src/a.ts" });
  assert.equal(tracker.record("edit", { path: "src/a.ts" }, miss("锚点行不存在")), 1);
  assert.equal(
    normalizeFailureReason("编辑失败: hash=0123456789abcdef 当前 hash=fedcba9876543210\nmore"),
    "编辑失败: hash=<hash> 当前 hash=<hash>",
  );
});

test("edit failure reasons are classified into a stable enum", () => {
  assert.equal(
    classifyEditFailure(
      "编辑失败: [hash冲突] [并发写入] 文件已被外部修改（期望 hash=a，当前 hash=b）",
    ),
    "hash-conflict-external",
  );
  assert.equal(
    classifyEditFailure("编辑失败: [hash冲突] 文件已被外部修改\n注意: 该文件最近一次改动是你自己"),
    "hash-conflict-own",
  );
  assert.equal(
    classifyEditFailure("编辑失败: 在文件中找不到指定的 oldText 原文（缩进或空白不一致）。"),
    "oldtext-miss:缩进或空白不一致",
  );
  assert.equal(
    classifyEditFailure("编辑失败: oldText 匹配到多处，为安全起见已拒绝修改。"),
    "oldtext-ambiguous",
  );
});

test("concurrent-write failures are detected and stop further edits", () => {
  const output = `编辑失败: [hash冲突] ${EDIT_CONCURRENT_MARKER} 文件已被外部修改`;
  assert.equal(isConcurrentWriteFailure("edit", output), true);
  assert.equal(isConcurrentWriteFailure("write", output), false);
  assert.equal(isConcurrentWriteFailure("edit", "编辑失败: oldText 匹配到多处"), false);
  assert.match(buildConcurrentWriteNotice("src/a.ts"), /本回合已停止对该文件的自动编辑/);
  assert.match(buildConcurrentWriteSkipMessage("src/a.ts"), /正被其他进程\/会话写入/);
});

test("repeated failure notice only appears from the second identical failure", () => {
  assert.equal(buildRepeatedFailureNotice(1), "");
  assert.match(buildRepeatedFailureNotice(2), /相同原因失败 2 次.*不要再发起同样的调用/);
  assert.match(buildRepeatedFailureNotice(2), /先 read 重新读取/);
  assert.match(buildRepeatedFailureNotice(2), /hash 冲突.*必须先 read 拿到当前内容与新 hash/);
  assert.match(buildRepeatedFailureNotice(2), /已经是目标内容则无需再写/);
});

test("edit failure notice names the file and the latest reason", () => {
  const text = buildRepeatedFailureNotice(2, {
    toolName: "edit",
    target: "src/a.ts",
    reason: "hash-conflict-external",
  });
  assert.match(text, /同一文件（src\/a\.ts）的编辑已连续失败 2 次/);
  assert.match(text, /最近原因: hash-conflict-external/);
  assert.match(text, /停止编辑并向用户说明/);
});

test("repeated failure skip message names the stop reason for the remaining calls", () => {
  assert.match(buildRepeatedFailureSkipMessage(), /同一工具已连续以相同原因失败 3 次/);
  assert.match(buildRepeatedFailureSkipMessage(), /本轮自动重试已停止/);
});

test("turn-runner skips the remaining tool calls once the repeated-failure limit is hit", () => {
  const source = fs.readFileSync(new URL("../src/turn-runner.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(stoppedByRepeatedFailure\) \{\s*\n\s*for \(const tc of batch\.calls\)/,
    "停止后跳过同一条消息里剩余的批次",
  );
  assert.ok(source.includes("buildRepeatedFailureSkipMessage()"), "为跳过的调用补上工具结果");
});

test("turn-runner keeps edit failures counted across reads and stops on concurrent writes", () => {
  const source = fs.readFileSync(new URL("../src/turn-runner.ts", import.meta.url), "utf8");
  assert.ok(
    source.includes("repeatedFailures.noteSuccess(toolName, args)"),
    "成功时按工具+目标清零，read 不能洗掉 edit 的失败计数",
  );
  assert.ok(
    !source.includes("repeatedFailures.reset()"),
    "不要再无条件清零：read 会因此把 edit 的失败计数洗掉",
  );
  assert.ok(
    source.includes("isConcurrentWriteFailure(toolName, toolOutput)"),
    "并发写要单独识别并结束本回合",
  );
  assert.ok(source.includes("buildConcurrentWriteNotice(concurrentWriteTarget)"));
  assert.ok(source.includes("buildConcurrentWriteSkipMessage(concurrentWriteTarget)"));
});

test("raceWithAbort returns the tool result when it finishes first", async () => {
  const controller = new AbortController();
  assert.equal(await raceWithAbort(Promise.resolve("ok"), controller.signal), "ok");
});

test("raceWithAbort stops waiting as soon as the signal aborts", async () => {
  const controller = new AbortController();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const raced = raceWithAbort(pending, controller.signal);
  controller.abort();
  assert.equal(await raced, undefined);
  // 后台仍可完成；迟到的结果不能再影响调用方。
  release("late");
});

test("raceWithAbort short-circuits an already aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await raceWithAbort(new Promise(() => {}), controller.signal), undefined);
});

test("raceWithAbort absorbs a late rejection after abort", async () => {
  const controller = new AbortController();
  let rejectLate;
  const pending = new Promise((_, reject) => {
    rejectLate = reject;
  });
  const raced = raceWithAbort(pending, controller.signal);
  controller.abort();
  assert.equal(await raced, undefined);
  rejectLate(new Error("late failure"));
  await new Promise((resolve) => setImmediate(resolve));
});
