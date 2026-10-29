import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager, startTraceServer } from "@hajicli/core";
import { buildSlashCommandCatalog, classifyCommandTiming } from "../dist/cli-help.js";
import { buildReloadArgs, runReloadProcess } from "../dist/reload.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-reload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("reload 进入补全且在回合结束后排队执行", () => {
  assert.ok(buildSlashCommandCatalog([]).some((entry) => entry.command === "/reload"));
  assert.equal(classifyCommandTiming("/reload"), "queued");
  assert.deepEqual(buildReloadArgs(undefined, []), ["--no-worktree"]);
});

test("新进程读取更新后的代码，并按 ID 恢复同名会话中的正确对话和目标", async (t) => {
  const root = fixture(t);
  const sessions = path.join(root, ".haji", "sessions");
  const manager = new SessionManager(sessions);
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "继续实现 reload" },
    { role: "assistant", content: "已有进展" },
  ];
  const id = manager.getCurrentSession().id;
  manager.setGoal({ text: "实现 reload", status: "active", createdAt: new Date().toISOString() });
  manager.saveCurrentSession(messages, "同名会话");
  await manager.flush();
  manager.startNewSession();
  manager.saveCurrentSession([{ role: "user", content: "另一个会话" }], "同名会话");
  await manager.flush();
  const coreUrl = new URL("../../core/dist/index.js", import.meta.url).href;
  const entryPath = path.join(root, "entry.mjs");
  const extraRoot = path.join(root, "带 空格目录");
  for (const version of ["build-one", "build-two"]) {
    fs.writeFileSync(
      entryPath,
      `
      import { SessionManager } from ${JSON.stringify(coreUrl)};
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      const manager = new SessionManager(${JSON.stringify(sessions)});
      const session = manager.loadSession(args[args.indexOf('--reload-session') + 1]);
      fs.writeFileSync('result.json', JSON.stringify({ version: ${JSON.stringify(version)}, session, args, cwd: process.cwd() }));
      process.exit(7);
    `,
    );
    const reloadUrl = new URL("../dist/reload.js", import.meta.url).href;
    const launcher = path.join(root, "launcher.mjs");
    fs.writeFileSync(
      launcher,
      `import {runReloadProcess} from ${JSON.stringify(reloadUrl)}; await runReloadProcess(${JSON.stringify({ entryPath, sessionId: id, workspaceRoots: [extraRoot], cwd: root })});`,
    );
    const child = spawnSync(process.execPath, [launcher], { encoding: "utf8" });
    assert.equal(child.status, 7, child.stderr);
    const result = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
    assert.equal(result.version, version);
    assert.equal(result.session.id, id);
    assert.deepEqual(result.session.messages, messages);
    assert.equal(result.session.goal.text, "实现 reload");
    assert.deepEqual(result.args, ["--reload-session", id, "--add-dir", extraRoot]);
    assert.equal(result.cwd, root);
  }
});

test("启动失败返回错误，并移除临时信号处理器", async (t) => {
  const root = fixture(t);
  const listeners = process.listenerCount("SIGINT");
  await assert.rejects(
    runReloadProcess({
      entryPath: fileURLToPath(import.meta.url),
      sessionId: "id",
      workspaceRoots: [],
      cwd: path.join(root, "missing"),
    }),
    /ENOENT/,
  );
  assert.equal(process.listenerCount("SIGINT"), listeners);
});

test("连续原位重载保持PID且SIGTERM不被忽略", async (t) => {
  const root = fixture(t);
  const entry = path.join(root, "repeat.mjs");
  const reloadUrl = new URL("../dist/reload.js", import.meta.url).href;
  fs.writeFileSync(
    entry,
    `import fs from 'node:fs'; import {runReloadProcess} from ${JSON.stringify(reloadUrl)};
    const file=${JSON.stringify(path.join(root, "pids.json"))};
    const pids=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[]; pids.push(process.pid); fs.writeFileSync(file,JSON.stringify(pids));
    if(pids.length<4) await runReloadProcess({entryPath:${JSON.stringify(entry)},cwd:${JSON.stringify(root)},workspaceRoots:[]});
    else { console.log('ready'); setInterval(()=>{},1000); }
  `,
  );
  const child = spawn(process.execPath, [entry], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("reload timeout")), 10000);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, "pids.json"))),
    Array(4).fill(child.pid),
  );
  child.kill("SIGTERM");
  assert.equal((await exit).signal, "SIGTERM");
});

test("重载清理释放 Trace 端口，连续启动可复用同一端口", async () => {
  for (let index = 0, port = 0; index < 2; index++) {
    const controller = new AbortController();
    port = await startTraceServer(port, false, false, 0, () => {}, controller.signal);
    controller.abort();
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, () => probe.close(resolve));
    });
  }
});
