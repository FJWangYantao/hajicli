import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 可指定发布包安装后的入口；所有配置、会话与HTTP均隔离。 */
export async function firstUseSmoke(
  entry = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url)),
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-first-use-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".haji"), { recursive: true });
  fs.mkdirSync(cwd);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    HAJI_REDUCED_MOTION: "1",
    HAJI_POST_EDIT_VERIFY: "0",
    HAJI_MODEL_TIMEOUT_MS: "5000",
    HAJI_HTTP_TIMEOUT_MS: "1000",
  };
  for (const key of [
    "DEEPSEEK_API_KEY",
    "VOLC_API_KEY",
    "ARK_API_KEY",
    "HAJI_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
  ])
    delete env[key];
  env.NO_PROXY = "127.0.0.1,localhost";
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "首次任务" } }] }));
      return;
    }
    const second = body.messages.some(
      (m) => m.role === "assistant" && m.content.includes("FIRST_USE_OK"),
    );
    const content = second ? "RESUME_OK" : "FIRST_USE_OK";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fs.writeFileSync(
    path.join(home, ".haji", "config.json"),
    JSON.stringify({
      providers: {
        localtest: {
          apiKey: "test-only-key",
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          model: "local-test",
          models: ["local-test"],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(home, ".haji", "preferences.json"),
    JSON.stringify({ provider: "localtest", model: "local-test", autoDistill: false }),
  );
  function run(args, resume = false) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        sent = false,
        exited = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`首次使用超时: ${stderr.slice(-1000)} ${stdout.slice(-1000)}`));
      }, 20000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (resume && !sent && /FIRST_USE_OK/.test(stdout)) {
          sent = true;
          setTimeout(() => {
            if (!exited) child.stdin.write("继续验证恢复\n");
          }, 150);
        }
        if (resume && /RESUME_OK/.test(stdout)) {
          setTimeout(() => {
            if (!exited) child.stdin.end("/exit\n");
          }, 150);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        exited = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (!resume) child.stdin.end();
    });
  }
  try {
    const first = await run(["-p", "首次任务", "--no-worktree", "--output-format", "json"]);
    assert.equal(first.code, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.text, "FIRST_USE_OK");
    const sessionsDir = path.join(cwd, ".haji", "sessions");
    const sessionFile = path.join(sessionsDir, `session_${result.sessionId}.json`);
    assert.ok(
      JSON.parse(fs.readFileSync(sessionFile)).messages.some((m) =>
        m.content.includes("FIRST_USE_OK"),
      ),
    );
    const resumed = await run(["-c", "--no-worktree"], true);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /RESUME_OK/);
    assert.ok(
      requests.some(
        (r) =>
          r.stream &&
          r.messages.some((m) => m.role === "assistant" && m.content.includes("FIRST_USE_OK")),
      ),
    );
    const stored = JSON.parse(fs.readFileSync(sessionFile));
    assert.ok(stored.messages.some((m) => m.content.includes("RESUME_OK")));
    assert.equal(fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(
      (first.stdout + first.stderr + resumed.stdout + resumed.stderr).includes("test-only-key"),
      false,
    );
    return {
      ok: true,
      stages: ["first-task", "exit-save", "resume-context", "continue-save"],
      requests: requests.length,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  firstUseSmoke(process.argv[2])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
