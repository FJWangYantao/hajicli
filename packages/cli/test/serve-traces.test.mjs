import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { startTraceServer } from "@hajicli/core";

// startTraceServer 会打印 banner；并行测试下子进程 stdout 高压会干扰
// node:test runner 的 IPC 反序列化，这里统一静音。
const originalLog = console.log;
console.log = () => {};

/** 占住一个随机端口，返回 { port, release }。 */
function occupyPort() {
  return new Promise((resolve, reject) => {
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("blocker");
    });
    blocker.on("error", reject);
    // 不指定 host（与 trace server 一致绑所有接口），否则 IPv4/IPv6 同端口不冲突。
    blocker.listen(0, () => {
      resolve({
        port: blocker.address().port,
        release: () => blocker.close(),
      });
    });
  });
}

test("startTraceServer 端口被占时自动落到下一个可用端口", async () => {
  const blocker = await occupyPort();
  try {
    const boundPort = await startTraceServer(blocker.port, false, false, 5);
    assert.ok(boundPort > blocker.port, `应在 ${blocker.port} 之后取端口，实际 ${boundPort}`);

    // 返回的端口上服务真实可用。
    const response = await fetch(`http://127.0.0.1:${boundPort}/api/sessions`);
    assert.equal(response.status, 200);
    const sessions = await response.json();
    assert.ok(Array.isArray(sessions));
  } finally {
    blocker.release();
  }
});

test("startTraceServer 严格模式下端口被占直接抛 EADDRINUSE", async () => {
  const blocker = await occupyPort();
  try {
    await assert.rejects(
      startTraceServer(blocker.port, false, false, 0),
      (error) => error?.code === "EADDRINUSE",
    );
  } finally {
    blocker.release();
  }
});

test("startTraceServer 首选端口空闲时原样使用", async () => {
  // 先占一个端口再释放，确保该端口当前空闲。
  const probe = await occupyPort();
  const port = probe.port;
  probe.release();
  await new Promise((resolve) => setImmediate(resolve));

  const boundPort = await startTraceServer(port, false, false, 5);
  assert.equal(boundPort, port);
  const response = await fetch(`http://127.0.0.1:${boundPort}/api/sessions`);
  assert.equal(response.status, 200);
});

process.on("exit", () => {
  console.log = originalLog;
});
