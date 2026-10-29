import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTask, qualityTasks } from "./quality-tasks.mjs";

export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, error, timedOut, wallMs: Date.now() - started, output, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
        killer.on("error", () => child.kill("SIGKILL"));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, options.timeoutMs ?? 120000);
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-1000000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1000000);
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

export async function verifyTask(task, cwd) {
  // 新进程运行父进程持有的断言，避免模块缓存或受测代码死循环挂住评测。
  const script = `const assert=require('node:assert/strict'); const m=require(${JSON.stringify(path.join(cwd, "math.cjs"))}); const c=${task.extra ? `require(${JSON.stringify(path.join(cwd, "consumer.cjs"))})` : "undefined"}; (${task.verify.toString()})(m,c);`;
  return runProcess(process.execPath, ["-e", script], { cwd, timeoutMs: 3000 });
}

export async function evaluateTask(
  task,
  { runner, root, timeoutMs = 120000, interventions = null },
) {
  const cwd = path.join(root, task.id);
  prepareTask(task, cwd);
  const started = Date.now();
  const execution = await runner(task, cwd, timeoutMs);
  const verification =
    execution.code === 0 && !execution.timedOut && !execution.error
      ? await verifyTask(task, cwd)
      : null;
  let reported;
  try {
    reported = JSON.parse(execution.output.trim());
  } catch {}
  const passed =
    reported?.ok !== false &&
    verification !== null &&
    verification.code === 0 &&
    !verification.timedOut;
  return {
    task: task.id,
    passed,
    code: execution.code,
    timedOut: execution.timedOut,
    validation: verification === null ? "not-run" : passed ? "passed" : "failed",
    wallMs: Date.now() - started,
    interventions,
    costCny:
      reported?.usage?.hasUnpricedModels === false &&
      Number.isFinite(reported?.usage?.estimatedCostCny) &&
      reported.usage.estimatedCostCny >= 0
        ? reported.usage.estimatedCostCny
        : null,
  };
}

export function summarize(results) {
  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    completionRate: results.length ? passed / results.length : 0,
    interventions: results.every((r) => Number.isInteger(r.interventions) && r.interventions >= 0)
      ? results.reduce((sum, r) => sum + r.interventions, 0)
      : null,
    wallMs: results.reduce((sum, r) => sum + r.wallMs, 0),
    costCny: results.every((r) => r.costCny !== null)
      ? results.reduce((sum, r) => sum + r.costCny, 0)
      : null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--run")) {
    console.log(
      JSON.stringify(
        { dryRun: true, tasks: qualityTasks.map(({ id, prompt }) => ({ id, prompt })) },
        null,
        2,
      ),
    );
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-quality-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const entry = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));
  // 只继承显式环境变量凭据；不读取或改写真实用户目录。
  const env = { ...process.env, HOME: home, USERPROFILE: home, HAJI_POST_EDIT_VERIFY: "0" };
  try {
    const results = [];
    for (const task of qualityTasks) {
      results.push(
        await evaluateTask(task, {
          root,
          interventions: 0,
          runner: (item, cwd, timeoutMs) =>
            runProcess(
              process.execPath,
              [
                entry,
                "-p",
                item.prompt,
                "--no-worktree",
                "--permission-mode",
                "accept-edit",
                "--output-format",
                "json",
              ],
              { cwd, env, timeoutMs },
            ),
        }),
      );
    }
    const report = { summary: summarize(results), results };
    const outIndex = args.indexOf("--out");
    if (outIndex >= 0) {
      if (!args[outIndex + 1]) throw new Error("--out 需要文件路径");
      fs.writeFileSync(args[outIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
    if (results.some((r) => !r.passed)) process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
