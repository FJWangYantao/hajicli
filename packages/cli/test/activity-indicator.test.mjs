import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityIndicator,
  buildActivityFrame,
  formatActivityDuration,
  ToolRunView,
} from "../dist/activity-indicator.js";
import { setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

test("formats activity duration without noisy sub-second precision", () => {
  assert.equal(formatActivityDuration(-1), "0s");
  assert.equal(formatActivityDuration(9_999), "9s");
  assert.equal(formatActivityDuration(65_000), "1m05s");
});

test("activity frames expose active, waiting and stalled states", () => {
  const state = {
    phase: "thinking",
    label: "思考中",
    detail: "等待模型事件",
    startedAt: 1_000,
    lastProgressAt: 2_000,
  };

  const active = buildActivityFrame(state, 0, 5_000, 12_000, 30_000);
  const waiting = buildActivityFrame(state, 1, 15_000, 12_000, 30_000);
  const stalled = buildActivityFrame(state, 2, 33_000, 12_000, 30_000);

  assert.equal(active.tone, "active");
  assert.equal(waiting.tone, "waiting");
  assert.match(waiting.idleText, /13s 无新进展/);
  assert.equal(stalled.tone, "stalled");
  assert.match(stalled.idleText, /31s 无新进展/);
  assert.notEqual(active.icon, waiting.icon);
  assert.equal("meter" in active, false, "the activity row carries a single animation");
});

test("permission is an explicit waiting phase instead of a false stall", () => {
  const frame = buildActivityFrame(
    {
      phase: "permission",
      label: "等待授权",
      startedAt: 0,
      lastProgressAt: 0,
    },
    0,
    90_000,
    12_000,
    30_000,
  );

  assert.equal(frame.tone, "waiting");
  assert.equal(frame.idleText, undefined);
  assert.equal(frame.elapsed, "1m30s");
});

test("indicator owns one timer and progress resets idle detection", () => {
  let now = 1_000;
  let scheduled;
  let cancelled = 0;
  const frames = [];
  const indicator = new ActivityIndicator({
    render: (frame) => frames.push(frame),
    now: () => now,
    intervalMs: 100,
    waitingAfterMs: 1_000,
    stalledAfterMs: 2_000,
    schedule: (callback) => {
      scheduled = callback;
      return { unref() {} };
    },
    cancel: () => {
      cancelled += 1;
    },
  });

  indicator.start("tool", "执行工具", "read");
  assert.equal(frames.at(-1).tone, "active");

  now = 2_500;
  scheduled();
  assert.equal(frames.at(-1).tone, "waiting");

  indicator.progress("read: 50%");
  now = 2_600;
  scheduled();
  assert.equal(frames.at(-1).tone, "active");
  assert.equal(frames.at(-1).detail, "read: 50%");

  indicator.transition("responding", "生成回复");
  assert.equal(cancelled, 1);
  assert.equal(frames.at(-1).phase, "responding");

  indicator.stop();
  assert.equal(cancelled, 2);
  assert.equal(frames.at(-1), undefined);
});

test("waiting for permission renders one static frame without an animation timer", () => {
  let scheduled = 0;
  const frames = [];
  const indicator = new ActivityIndicator({
    render: (frame) => frames.push(frame),
    schedule: () => {
      scheduled += 1;
      return { unref() {} };
    },
    cancel: () => {},
  });
  indicator.start("permission", "等待授权");
  assert.equal(scheduled, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].icon, "◆");
  indicator.stop();
});

function createToolRunView() {
  let now = 0;
  let tick;
  let cancelled = 0;
  const renders = [];
  const view = new ToolRunView({
    render: (text) => renders.push(text),
    getWidth: () => 60,
    now: () => now,
    schedule: (callback) => {
      tick = callback;
      return { unref() {} };
    },
    cancel: () => {
      cancelled += 1;
      tick = undefined;
    },
  });
  return {
    view,
    renders,
    advance(ms) {
      now += ms;
      tick?.();
    },
    get ticking() {
      return Boolean(tick);
    },
    get cancelled() {
      return cancelled;
    },
  };
}

test("tool run view hides calls until they start and streams an output tail", () => {
  const harness = createToolRunView();
  const { view, renders } = harness;
  view.register("c1", "bash", "make all");
  assert.equal(renders.length, 0, "a call waiting for permission is not shown");

  view.start("c1");
  assert.match(renders.at(-1), /^ {2}● bash {2}make all +0s\n$/);
  assert.ok(harness.ticking);

  view.output("c1", "step 1\nstep 2\nstep 3\nstep 4\nstep 5\nprogress 10%\rprogress 90%");
  const live = renders.at(-1).split("\n");
  assert.deepEqual(live.slice(1, -1), [
    "    │ step 3",
    "    │ step 4",
    "    │ step 5",
    "    │ progress 90%",
  ]);

  harness.advance(3_000);
  assert.match(
    renders.at(-1),
    /^ {2}● bash {2}make all +3s/,
    "the mark stays still; only the elapsed time advances",
  );

  view.finish("c1", { status: "success", text: "5 行输出 · step 5" }, 6_049);
  assert.equal(harness.ticking, false, "the refresh timer stops once nothing is running");
  assert.match(renders.at(-1), /^ {2}✓ bash {2}make all +6\.0s\n {4}└ 5 行输出 · step 5\n$/);
});

test("tool run view expands multi-line arguments only in the committed block", () => {
  const harness = createToolRunView();
  const { view, renders } = harness;
  view.register("c1", "bash", "", undefined, ["for f in *.ts; do", "  echo $f", "done"]);
  view.start("c1");
  assert.equal(
    renders.at(-1).includes("for f in"),
    false,
    "executing keeps the live block to the output tail",
  );

  view.finish("c1", { status: "success", text: "退出码 0" }, 1_200);
  assert.match(renders.at(-1), /│ for f in \*\.ts; do/);
  const committed = view.commit();
  assert.match(committed, /│ for f in \*\.ts; do\n {4}│ {3}echo \$f\n {4}│ done/);
  assert.match(committed, /└ 退出码 0/);
});

test("tool run view shows the auto-judge state and a short-lived verdict in place", () => {
  const harness = createToolRunView();
  const { view, renders } = harness;
  view.register("c1", "bash", "make all");
  assert.equal(renders.length, 0, "a call waiting for permission is not shown");

  view.judge("c1");
  assert.match(renders.at(-1), /^ {2}◈ bash {2}make all +判定中 0s\n$/);
  assert.ok(harness.ticking, "the judging state animates like a running tool");

  harness.advance(1_000);
  assert.match(renders.at(-1), /判定中 1s/);

  view.judged("c1", "AI 放行 · 1234ms");
  assert.match(renders.at(-1), /判定中 1s +AI 放行 · 1234ms/);

  view.start("c1");
  assert.match(renders.at(-1), /bash {2}make all +0s +AI 放行 · 1234ms\n$/);

  harness.advance(4_000);
  assert.doesNotMatch(renders.at(-1), /AI 放行/, "the verdict expires instead of piling up");

  view.finish("c1", { status: "success", text: "ok" }, 4_100);
  const committed = view.commit();
  assert.doesNotMatch(committed, /AI 放行|判定中/, "the transcript keeps the plain result cell");
  assert.match(committed, /^ {2}✓ bash {2}make all +4\.1s/);
});

test("a denied call keeps its verdict on the rejecting cell", () => {
  const harness = createToolRunView();
  const { view, renders } = harness;
  view.register("c1", "bash", "rm -rf /");
  view.judge("c1");
  view.judged("c1", "AI 拦截 · 2100ms");
  view.finish("c1", { status: "rejected", text: "安全策略拦截：越权删除" }, 0);
  assert.match(renders.at(-1), /⊘ bash {2}rm -rf \/ +AI 拦截 · 2100ms/);
  assert.match(renders.at(-1), /└ 安全策略拦截：越权删除/);
  assert.doesNotMatch(view.commit(), /AI 拦截/, "the transcript drops the verdict note");
});

test("tool run view commits finished cells in call order and clears the live area", () => {
  const { view, renders } = createToolRunView();
  view.register("a", "read", "a.ts");
  view.register("b", "grep", '"x"');
  view.register("c", "bash", "rm -rf build");
  view.start("a");
  view.start("b");
  view.finish("b", { status: "success", text: "3 条结果" }, 4);
  view.finish("a", { status: "success", text: "10 行" }, 7);
  view.finish("c", { status: "rejected", text: "已拒绝执行" }, 0);

  const committed = view.commit();
  assert.deepEqual(committed.split("\n"), [
    "  ✓ read  a.ts  7ms",
    "    └ 10 行",
    '  ✓ grep  "x"  4ms',
    "    └ 3 条结果",
    "  ⊘ bash  rm -rf build",
    "    └ 已拒绝执行",
    "",
  ]);
  assert.equal(renders.at(-1), "");
  assert.equal(view.hasEntries(), false);
  assert.equal(view.commit(), "", "pending and aborted calls never leak into the transcript");
});

test("idle time is omitted when nothing has happened since the phase started", () => {
  const frame = buildActivityFrame(
    { phase: "thinking", label: "思考中", detail: "模型尚未响应", startedAt: 0, lastProgressAt: 0 },
    0,
    13_000,
    12_000,
    30_000,
  );
  assert.equal(frame.tone, "waiting");
  assert.equal(frame.idleText, undefined, "elapsed already shows the same duration");
  assert.equal(frame.elapsed, "13s");
});
