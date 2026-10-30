#!/usr/bin/env node
/**
 * PR 巡检的无头守护进程：把 `runLoop` 从 haji 的 TUI 进程里搬出来，
 * 交给 systemd --user 托管，这样关掉终端 / 退出 haji 都不会中断巡检。
 *
 * 与 TUI 内 `/patrol start` 的唯一区别是「谁持有 AbortSignal」：
 * 这里由 SIGTERM / SIGINT 触发中止，其余（仓库推断、令牌来源、接管策略、
 * 唤醒通道、轮询兜底）完全复用同一套模块，不另起逻辑。
 *
 * 用法：
 *   node scripts/patrol-daemon.mjs          # 前台跑，Ctrl+C 退出
 *   systemctl --user start haji-patrol      # 交给 systemd（见同目录 unit）
 *
 * 注意：同一份 `.haji/patrol` store 只应有**一个**巡检在写。
 * 守护进程运行时，不要在 haji 里再 `/patrol start`。
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 项目根：本文件位于 `<root>/scripts/`。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { PatrolService } = await import(path.join(root, "packages/cli/dist/patrol/service.js"));
const { createSmeeWakeSource } = await import(path.join(root, "packages/cli/dist/patrol/wake.js"));
const { loadPatrolConfig, resolvePatrolRepo } = await import(
  path.join(root, "packages/cli/dist/patrol/config.js")
);
const { createHeadlessRunners } = await import(
  path.join(root, "packages/cli/dist/patrol/runners.js")
);
const { GitHubPatrolAdapter } = await import(
  path.join(root, "packages/patrol-github/dist/index.js")
);
const { PatrolStore, isTerminalPatrolStatus } = await import(
  path.join(root, "packages/core/dist/index.js")
);
const { describeActivity } = await import(path.join(root, "packages/cli/dist/patrol/hint.js"));
const { writeDaemonState, clearDaemonState, DAEMON_HEARTBEAT_MS } = await import(
  path.join(root, "packages/cli/dist/patrol/daemon-state.js")
);

/** 令牌：GH_TOKEN > GITHUB_TOKEN > `gh auth token`（与 `/patrol start` 一致）。 */
async function resolveToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf8" });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function log(line) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

const repo = resolvePatrolRepo(root);
if (!repo) {
  log(`无法确定巡检仓库：在 ${root}/.haji/patrol/config.json 设置 repo，或配置 git remote origin`);
  process.exit(1);
}

const config = loadPatrolConfig(root);
const token = await resolveToken();
if (!token) log("警告：未找到 GitHub 令牌，只能读公开仓库，评论与合并会失败");

const adapter = new GitHubPatrolAdapter({ repo, token });
const runners = createHeadlessRunners({ repoDir: root });
const service = new PatrolService({
  cwd: root,
  store: new PatrolStore(path.join(root, ".haji", "patrol")),
  adapter,
  runners,
  logger: log,
});

const wake = config.wakeUrl
  ? createSmeeWakeSource(config.wakeUrl, { logger: (line) => log(`  ${line}`) })
  : undefined;

/**
 * 心跳：把「巡检在外部跑着」这件事写成文件，让 haji 侧栏读得到。
 * 侧栏只读不探进程，所以这里必须持续刷新——停更 30s 就被判定为失效。
 */
const startedAt = new Date().toISOString();
const store = new PatrolStore(path.join(root, ".haji", "patrol"));
function heartbeat() {
  let jobs = [];
  try {
    jobs = store.listJobs();
  } catch {
    // 运行数据读失败不该影响巡检本身；下一拍再试。
  }
  const active = jobs.filter((job) => !isTerminalPatrolStatus(job.status)).length;
  // 刚启动时先显示「巡检中」，避免侧栏在第一次 drain 完成前就闪成「等待中」。
  const waiting = active === 0 && Date.now() - Date.parse(startedAt) >= 1_500;
  const activity = describeActivity(jobs);
  writeDaemonState(root, {
    pid: process.pid,
    repo,
    startedAt,
    updatedAt: new Date().toISOString(),
    status: waiting ? "waiting" : "running",
    tasks: jobs.length,
    merged: jobs.filter((job) => job.status === "merged").length,
    ...(activity ? { activity } : {}),
  });
}
heartbeat();
const heartbeatTimer = setInterval(heartbeat, DAEMON_HEARTBEAT_MS);

const controller = new AbortController();
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，停止巡检`);
  clearInterval(heartbeatTimer);
  clearDaemonState(root);
  controller.abort();
  wake?.close();
  // 给 runLoop 一点时间收尾（正在跑的 headless 子进程不在这里强杀）。
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log(
  `巡检守护启动：${repo}，轮询 ${Math.round(config.pollIntervalMs / 1000)}s，` +
    `唤醒通道 ${config.wakeUrl || "（未配置，纯轮询）"}，令牌 ${token ? "已就绪" : "缺失"}`,
);

try {
  await service.runLoop(controller.signal, {
    idleBackoffCapMs: config.pollIntervalMs,
    wake,
  });
} catch (error) {
  log(`巡检循环异常退出：${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeatTimer);
  clearDaemonState(root);
  wake?.close();
  log("巡检循环已退出");
}
