/**
 * 巡检持久化：任务 / 动作幂等记录 / 来源登记。
 *
 * - 全部状态落在 `<dir>/state.json`（默认 `<cwd>/.haji/patrol/`），原子写；
 * - 读取即恢复：运行中的 run 与过期的租约在 `recover()` 里归一化，
 *   「执行中」的远端动作回退为「已存意图」，由调度器重查远端后再决定是否重发；
 * - 远端动作先存意图再执行：`beginAction` 返回已完成的同 ID 动作时调用方必须跳过。
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicallySync } from "../persistence-file.js";
import type { PatrolActionRecord, PatrolJob, PatrolSourceRegistration } from "./types.js";

interface PatrolStateFile {
  version: 1;
  paused: boolean;
  jobs: PatrolJob[];
  actions: PatrolActionRecord[];
}

const MAX_ACTIONS = 500;
const MAX_RUNS_PER_JOB = 50;

export class PatrolStore {
  private readonly statePath: string;
  private readonly registryPath: string;
  private state: PatrolStateFile;

  constructor(dir = path.join(process.cwd(), ".haji", "patrol")) {
    this.statePath = path.join(dir, "state.json");
    this.registryPath = path.join(dir, "registry.json");
    this.state = this.readState();
    this.recover();
  }

  /** 读取并归一化状态；文件损坏时报错而不是静默清空。 */
  private readState(): PatrolStateFile {
    try {
      if (!fs.existsSync(this.statePath))
        return { version: 1, paused: false, jobs: [], actions: [] };
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<PatrolStateFile>;
      const jobs = Array.isArray(raw.jobs)
        ? raw.jobs.filter((job) => job && typeof job.jobId === "string")
        : [];
      const actions = Array.isArray(raw.actions)
        ? raw.actions.filter((action) => action && typeof action.actionId === "string")
        : (raw.actions ?? []);
      return {
        version: 1,
        paused: raw.paused === true,
        jobs: jobs as PatrolJob[],
        actions: actions as PatrolActionRecord[],
      };
    } catch (error) {
      throw new Error(`巡检状态文件读取失败（${this.statePath}）：${(error as Error).message}`);
    }
  }

  isPaused(): boolean {
    return this.state.paused;
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
    this.persist();
  }

  /**
   * 崩溃 / 重启恢复语义：
   * - running 的 run → aborted（旧进程已不在，其结论不可信）；
   * - 租约：持有者的 run 已中止则清除，否则保留到期时间交由调度器判断；
   * - executing 的动作 → intended（重发前必须先查远端是否已生效）。
   */
  recover(now = new Date()): { recoveredRuns: number; recoveredActions: number } {
    let recoveredRuns = 0;
    let recoveredActions = 0;
    const nowIso = now.toISOString();
    for (const job of this.state.jobs) {
      job.runs = (job.runs ?? []).slice(-MAX_RUNS_PER_JOB);
      for (const run of job.runs) {
        if (run.status === "running") {
          run.status = "aborted";
          run.finishedAt = nowIso;
          recoveredRuns += 1;
        }
      }
      if (job.lease) {
        const leaseAlive =
          Date.parse(job.lease.expiresAt) > now.getTime() &&
          job.runs.some((run) => run.runId === job.lease?.holder && run.status !== "aborted");
        if (!leaseAlive) job.lease = undefined;
      }
    }
    for (const action of this.state.actions) {
      if (action.status === "executing") {
        action.status = "intended";
        recoveredActions += 1;
      }
    }
    if (recoveredRuns > 0 || recoveredActions > 0) this.persist();
    return { recoveredRuns, recoveredActions };
  }

  listJobs(): PatrolJob[] {
    return this.state.jobs.map((job) => structuredClone(job));
  }

  getJob(jobId: string): PatrolJob | null {
    const found = this.state.jobs.find((job) => job.jobId === jobId);
    return found ? structuredClone(found) : null;
  }

  saveJob(job: PatrolJob): PatrolJob {
    const copy = structuredClone(job);
    copy.runs = copy.runs.slice(-MAX_RUNS_PER_JOB);
    const index = this.state.jobs.findIndex((item) => item.jobId === job.jobId);
    if (index >= 0) this.state.jobs[index] = copy;
    else this.state.jobs.push(copy);
    this.persist();
    return structuredClone(copy);
  }

  /** 原子地把当前内存中的任务回写（调度器在内存中改完后统一落盘）。 */
  commit(job: PatrolJob): void {
    this.saveJob(job);
  }

  // ---- 远端动作幂等记录 -------------------------------------------------

  getAction(actionId: string): PatrolActionRecord | null {
    const found = this.state.actions.find((action) => action.actionId === actionId);
    return found ? structuredClone(found) : null;
  }

  /**
   * 记录执行意图。若同 ID 动作已完成则返回 `{ skip: true }`——调用方不得再次执行；
   * 处于 intended / executing 的动作返回 `{ skip: false }` 由调用方先查远端再重发。
   */
  beginAction(action: Omit<PatrolActionRecord, "status" | "attempt" | "createdAt">): {
    skip: boolean;
    action: PatrolActionRecord;
  } {
    const existing = this.getAction(action.actionId);
    if (existing) return { skip: existing.status === "done", action: existing };
    const record: PatrolActionRecord = {
      ...action,
      status: "intended",
      attempt: 0,
      createdAt: new Date().toISOString(),
    };
    this.state.actions.push(record);
    this.trimActions();
    this.persist();
    return { skip: false, action: record };
  }

  markActionExecuting(actionId: string): void {
    const action = this.requireAction(actionId);
    action.status = "executing";
    action.attempt += 1;
    this.persist();
  }

  markActionResult(actionId: string, result: { ok: boolean; error?: string }): void {
    const action = this.requireAction(actionId);
    action.status = result.ok ? "done" : "failed";
    action.lastError = result.ok ? undefined : (result.error ?? "未知错误");
    action.finishedAt = new Date().toISOString();
    this.persist();
  }

  /** 失败后重置为 intended，允许下一轮重试（调用方先确认远端未生效）。 */
  resetActionForRetry(actionId: string): void {
    const action = this.requireAction(actionId);
    if (action.status === "done") throw new Error(`动作 ${actionId} 已完成，不能重置`);
    action.status = "intended";
    this.persist();
  }

  listActions(limit = 50): PatrolActionRecord[] {
    return this.state.actions.slice(-limit).map((action) => structuredClone(action));
  }

  private requireAction(actionId: string): PatrolActionRecord {
    const found = this.state.actions.find((action) => action.actionId === actionId);
    if (!found) throw new Error(`巡检动作不存在: ${actionId}`);
    return found;
  }

  private trimActions(): void {
    if (this.state.actions.length > MAX_ACTIONS) {
      this.state.actions = this.state.actions.slice(-MAX_ACTIONS);
    }
  }

  // ---- 来源登记 ---------------------------------------------------------

  listRegistrations(): PatrolSourceRegistration[] {
    try {
      if (!fs.existsSync(this.registryPath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.registryPath, "utf8")) as {
        registrations?: PatrolSourceRegistration[];
      };
      return Array.isArray(raw.registrations) ? raw.registrations : [];
    } catch {
      return [];
    }
  }

  getRegistration(jobId: string): PatrolSourceRegistration | null {
    return this.listRegistrations().find((item) => item.jobId === jobId) ?? null;
  }

  saveRegistration(registration: PatrolSourceRegistration): void {
    const list = this.listRegistrations().filter((item) => item.jobId !== registration.jobId);
    list.push(registration);
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    writeFileAtomicallySync(this.registryPath, JSON.stringify({ registrations: list }, null, 2));
  }

  removeRegistration(jobId: string): boolean {
    const list = this.listRegistrations();
    const next = list.filter((item) => item.jobId !== jobId);
    if (next.length === list.length) return false;
    writeFileAtomicallySync(this.registryPath, JSON.stringify({ registrations: next }, null, 2));
    return true;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    writeFileAtomicallySync(this.statePath, JSON.stringify(this.state, null, 2));
  }
}
