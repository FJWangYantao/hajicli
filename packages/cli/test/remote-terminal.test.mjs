import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { clipboardSequence, liteDisplay, renderDelay } from "../dist/remote-terminal.js";
import { installTerminalShutdown } from "../dist/terminal-shutdown.js";

test("SSH display selection and interactive priority", () => {
  assert.equal(liteDisplay({}), false);
  assert.equal(liteDisplay({ SSH_TTY: "/dev/pts/1" }), true);
  assert.equal(liteDisplay({ SSH_CONNECTION: "remote", HAJI_DISPLAY: "full" }), false);
  assert.equal(liteDisplay({ HAJI_DISPLAY: "lite" }), true);
  assert.equal(renderDelay(false, { HAJI_DISPLAY: "lite" }), 100);
  assert.equal(renderDelay(true, { HAJI_DISPLAY: "lite" }), 8);
  assert.equal(renderDelay(false, { HAJI_DISPLAY: "full" }), 16);
});

test("tmux envelope decodes to original OSC52 with unicode payload", () => {
  const text = "你好\ncopy";
  const plain = clipboardSequence(text, false);
  assert.equal(plain, `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  const wrapped = clipboardSequence(text, true);
  assert.ok(wrapped.startsWith("\x1bPtmux;"));
  assert.ok(wrapped.endsWith("\x1b\\"));
  assert.equal(wrapped.slice(7, -2).replaceAll("\x1b\x1b", "\x1b"), plain);
});

for (const [event, code] of [
  ["SIGHUP", 129],
  ["SIGTERM", 143],
  ["end", 129],
  ["error", 1],
]) {
  test(`terminal ${event} flushes before exiting and removes listeners`, async () => {
    const signals = new EventEmitter();
    const stream = new EventEmitter();
    const calls = [];
    const remove = installTerminalShutdown({
      signals,
      input: stream,
      output: stream,
      flush: async () => {
        calls.push("flush");
      },
      exit: (value) => calls.push(value),
    });
    (event.startsWith("SIG") ? signals : stream).emit(event);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["flush", code]);
    remove();
    assert.equal(signals.listenerCount("SIGHUP"), 0);
    assert.equal(stream.listenerCount("end"), 0);
  });
}

test("failed persistence still exits", async () => {
  const signals = new EventEmitter();
  const exited = new Promise((resolve) => {
    installTerminalShutdown({
      signals,
      flush: async () => {
        throw Error("disk");
      },
      exit: resolve,
    });
  });
  signals.emit("SIGTERM");
  assert.equal(await exited, 143);
});

test("hung persistence is bounded", async () => {
  const signals = new EventEmitter();
  const hold = setTimeout(() => {}, 1000);
  try {
    const exited = new Promise((resolve) => {
      installTerminalShutdown({
        signals,
        flush: () => new Promise(() => {}),
        exit: resolve,
        timeoutMs: 10,
      });
    });
    signals.emit("SIGHUP");
    assert.equal(await exited, 129);
  } finally {
    clearTimeout(hold);
  }
});
