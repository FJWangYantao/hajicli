/**
 * 守护进程状态文件：`.haji/patrol/daemon.json`。
 *
 * 无头守护进程（`scripts/patrol-daemon.mjs`，由 systemd --user 托管）每 5s 心跳写入；
 * 侧栏只读它来判断「巡检在外部跑着」——纯文件读取，不联网、不翻进程命令行。
 *
 * 两条失效判据缺一不可：
 * - **心跳陈旧**：进程卡死但 pid 还在时，靠 `updatedAt` 兜住；
 * - **pid 已消失**：进程被 kill 但文件残留时，靠 `kill(pid, 0)` 兜住。
 *
 * 读不到 / 判为失效一律返回 undefined，调用方按「没有守护进程」处理——
 * 侧栏退回「就绪」或本会话自己的常驻，绝不让一个坏文件把入口卡死。
 */
import fs from "node:fs";
import path from "node:path";

export interface PatrolDaemonState {
  /** 写入方进程号，用于存活判断。 */
  pid: number;
  /** 巡检仓库（owner/name）。 */
  repo?: string;
  /** 守护进程启动时刻（ISO）。 */
  startedAt: string;
  /** 最近一次心跳（ISO）。 */
  updatedAt: string;
  /** running = 有任务在推进；waiting = 在等新 PR。 */
  status: "running" | "waiting";
  /** 任务总数。 */
  tasks?: number;
  /** 已合并数。 */
  merged?: number;
  /** 「当前在做什么」，如 `#12 审查中 · 3m`。 */
  activity?: string;
}

/** 写入方心跳间隔；读取方据此判定陈旧。 */
export const DAEMON_HEARTBEAT_MS = 5_000;
/** 超过这个时长没心跳即视为失效（容忍两三次丢帧 + 一次 GC 停顿）。 */
export const DAEMON_STALE_MS = 30_000;

export function daemonStatePath(cwd: string): string {
  return path.join(cwd, ".haji", "patrol", "daemon.json");
}

/**
 * 原子写入：先写临时文件再 rename，读取方永远看不到半截 JSON。
 * 心跳高频调用，失败只静默——状态文件坏了不该拖垮巡检本身。
 */
export function writeDaemonState(cwd: string, state: PatrolDaemonState): void {
  const file = daemonStatePath(cwd);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败也无所谓：下次心跳会覆盖同名临时文件。
    }
  }
}

/** 退出时删除；只删自己写的，避免误删另一个守护进程的状态。 */
export function clearDaemonState(cwd: string, pid = process.pid): void {
  try {
    const raw = readRaw(cwd);
    if (raw && raw.pid !== pid) return;
    fs.rmSync(daemonStatePath(cwd), { force: true });
  } catch {
    // 文件不存在 / 无权限：退出路径上不值得再报错。
  }
}

export interface ReadDaemonStateOptions {
  /** 判定「现在」的时刻，测试注入用。 */
  now?: number;
  /** 心跳陈旧阈值，默认 {@link DAEMON_STALE_MS}。 */
  staleMs?: number;
  /** pid 存活判断，测试注入用。 */
  isAlive?: (pid: number) => boolean;
}

/** 读守护进程状态；文件缺失、损坏、陈旧或进程已退出时返回 undefined。 */
export function readDaemonState(
  cwd: string,
  options: ReadDaemonStateOptions = {},
): PatrolDaemonState | undefined {
  const state = readRaw(cwd);
  if (!state) return undefined;
  const now = options.now ?? Date.now();
  const updated = Date.parse(state.updatedAt);
  if (!Number.isFinite(updated)) return undefined;
  if (now - updated > (options.staleMs ?? DAEMON_STALE_MS)) return undefined;
  const isAlive = options.isAlive ?? isProcessAlive;
  if (!isAlive(state.pid)) return undefined;
  return state;
}

/** 解析并校验结构；任何字段类型不对都当坏文件。 */
function readRaw(cwd: string): PatrolDaemonState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(daemonStatePath(cwd), "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return undefined;
  if (typeof raw.startedAt !== "string" || typeof raw.updatedAt !== "string") return undefined;
  if (raw.status !== "running" && raw.status !== "waiting") return undefined;
  return {
    pid: raw.pid,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    status: raw.status,
    ...(typeof raw.repo === "string" && raw.repo ? { repo: raw.repo } : {}),
    ...(typeof raw.tasks === "number" ? { tasks: raw.tasks } : {}),
    ...(typeof raw.merged === "number" ? { merged: raw.merged } : {}),
    ...(typeof raw.activity === "string" && raw.activity ? { activity: raw.activity } : {}),
  };
}

/** 默认存活判断：`kill(pid, 0)` 不抛错即视为活着；EPERM 说明进程存在但属于别人。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
