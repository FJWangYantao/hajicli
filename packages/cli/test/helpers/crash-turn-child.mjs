import { SessionManager } from "@hajicli/core";
import { recoveryCalls, recoveryHarness } from "./recovery-harness.mjs";

const [dir, boundary] = process.argv.slice(2);
const manager = new SessionManager(dir);
manager.saveCurrentSession([{ role: "user", content: "原有进度" }]);
await manager.flush();
manager.setGoal({ text: "完成两步操作", status: "active", createdAt: new Date().toISOString() });
manager.setUsage({ lastTurnMs: 42 });
function stopAtBoundary() {
  process.send({ id: manager.getCurrentSession().id });
  // 确定性停在边界：禁止防抖计时器碰巧完成，由父进程强杀。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
let requests = 0;
const harness = recoveryHarness(
  manager,
  {
    async *completeStream(_messages, options) {
      options.onRequestStart?.();
      if (++requests === 1) {
        options.onToolCall?.(recoveryCalls);
        options.onFinish?.({ reason: "tool_calls" });
      } else {
        if (boundary === "next-request") stopAtBoundary();
        yield "全部完成";
        options.onFinish?.({ reason: "stop" });
      }
    },
  },
  async (_name, args) => {
    if (args.command === "second" && boundary === "second-tool") stopAtBoundary();
    return { output: `${args.command} 已完成`, duration: 1 };
  },
);
await harness.run();
stopAtBoundary();
