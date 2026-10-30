/**
 * 侧栏的 PR 巡检入口：探测「有 agent PR 但巡检没在跑」，并支持一键后台启动。
 *
 * 分工约定：
 * - 探测只做一次（启动时），绝不每帧联网；失败静默——侧栏不显示，而不是把错误糊到对话区。
 * - 点击入口跑一次 `PatrolService.drain()`（后台，不阻塞输入），跑到没有可推进的步骤即停；
 *   运行中每 5s 读本地 store 刷新阶段与计数（纯文件读取，不联网）。
 * - 不写任何配置文件：仓库由 `git remote origin` 推断，PR 由分支前缀自动登记（见 service.ts），
 *   所以「自动配置」的产物只有 `.haji/patrol/` 下的运行数据。
 */
import path from "node:path";
import { isTerminalPatrolStatus, type PatrolJob, PatrolStore, patrolJobId } from "@hajicli/core";
import { WORKTREE_BRANCH_PREFIX } from "../worktree.js";
import { resolvePatrolRepo } from "./config.js";
import { GitHubPatrolAdapter } from "./github.js";
import { createHeadlessRunners } from "./runners.js";
import { PatrolService } from "./service.js";
import type { PatrolForgeAdapter, PatrolRunners } from "./types.js";

/** 侧栏入口状态；结构与 `SidebarPatrolState` 一致（渲染层只读，不反向依赖本模块）。 */
export interface PatrolHintState {
  status: "ready" | "running" | "no-token";
  /** ready 时探测到的、分支命中 agent 前缀的开放 PR 数。 */
  pending: number;
  /** running 时的任务总数。 */
  tasks?: number;
  /** running 时已合并的任务数。 */
  merged?: number;
  /** running 时「当前在做什么」，如 `#12 审查中 · 3m`；无进行中任务时缺省。 */
  activity?: string;
  /** 巡检仓库（owner/name）。 */
  repo?: string;
}

export interface PatrolHintOptions {
  cwd: string;
  /** 解析 GitHub 令牌；undefined 表示没有（侧栏只提示，不启动）。 */
  resolveToken: () => Promise<string | undefined>;
  onChange: (state: PatrolHintState | null) => void;
  /** 启动 / 停止 / 失败的可见反馈（一行文本）。 */
  log?: (line: string) => void;
  /** 运行中刷新任务计数的间隔，默认 5s。 */
  pollIntervalMs?: number;
  /** 「巡查中」状态至少可见的时长（毫秒），默认 1500；没活时 drain 会瞬间结束。 */
  minRunningMs?: number;
  /** 测试注入点：默认走 GitHub REST 适配器。 */
  createAdapter?: (repo: string, token: string) => PatrolForgeAdapter;
  /** 测试注入点：默认起无头 haji 进程。 */
  createRunners?: () => PatrolRunners;
}

export class PatrolHint {
  private readonly cwd: string;
  private readonly resolveToken: () => Promise<string | undefined>;
  private readonly onChange: (state: PatrolHintState | null) => void;
  private readonly log?: (line: string) => void;
  private readonly pollIntervalMs: number;
  private readonly minRunningMs: number;
  private readonly createAdapter: (repo: string, token: string) => PatrolForgeAdapter;
  private readonly createRunners: () => PatrolRunners;
  private repo?: string;
  private service?: PatrolService;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(options: PatrolHintOptions) {
    this.cwd = options.cwd;
    this.resolveToken = options.resolveToken;
    this.onChange = options.onChange;
    this.log = options.log;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.minRunningMs = options.minRunningMs ?? 1_500;
    this.createAdapter =
      options.createAdapter ?? ((repo, token) => new GitHubPatrolAdapter({ repo, token }));
    this.createRunners =
      options.createRunners ?? (() => createHeadlessRunners({ repoDir: this.cwd }));
  }

  /**
   * 启动时探测一次：推断仓库、检查令牌、数一数待接管的 agent PR。
   * 任何一步失败都只是不显示入口（返回 null），不抛错。
   */
  async probe(): Promise<void> {
    if (this.disposed || this.service) return;
    const repo = resolvePatrolRepo(this.cwd);
    if (!repo) {
      this.onChange(null);
      return;
    }
    this.repo = repo;
    const token = await this.resolveToken();
    if (this.disposed) return;
    if (!token) {
      this.onChange({ status: "no-token", pending: 0, repo });
      return;
    }
    try {
      const adapter = this.createAdapter(repo, token);
      const prs = await adapter.listOpenPullRequests();
      if (this.disposed) return;
      const store = new PatrolStore(path.join(this.cwd, ".haji", "patrol"));
      const pending = prs.filter((pr) => {
        if (!pr.branch.startsWith(WORKTREE_BRANCH_PREFIX)) return false;
        return !store.getJob(patrolJobId(repo, pr.number));
      }).length;
      this.onChange({ status: "ready", pending, repo });
    } catch {
      // 网络不可达 / 401 / 仓库不存在：侧栏不显示入口，用户仍可用 /patrol 命令。
      this.onChange(null);
    }
  }

  /**
   * 侧栏点击入口：后台跑一次巡查（drain 到没有可推进的步骤即停），不是常驻循环。
   * 幂等：巡查进行中重复点击只提示，不叠加第二次。
   */
  async start(): Promise<void> {
    if (this.service) {
      this.log?.("PR 巡查进行中，完成后再点一次。");
      return;
    }
    const repo = this.repo ?? resolvePatrolRepo(this.cwd);
    if (!repo) {
      this.log?.("无法确定巡检仓库：在该 git 仓库配置 origin 远端后再试。");
      return;
    }
    const token = await this.resolveToken();
    if (this.disposed) return;
    if (!token) {
      this.repo = repo;
      this.onChange({ status: "no-token", pending: 0, repo });
      this.log?.("PR 巡检需要 GitHub 令牌：先 `gh auth login`，或设置 GH_TOKEN。");
      return;
    }
    this.repo = repo;
    const controller = new AbortController();
    const service = new PatrolService({
      cwd: this.cwd,
      store: new PatrolStore(path.join(this.cwd, ".haji", "patrol")),
      adapter: this.createAdapter(repo, token),
      runners: this.createRunners(),
      logger: (line) => this.log?.(line),
    });
    this.service = service;
    this.controller = controller;
    this.onChange({ status: "running", pending: 0, tasks: 0, merged: 0, repo });
    this.log?.(
      `PR 巡查已启动（${repo}），自动接管 ${WORKTREE_BRANCH_PREFIX} 分支的 PR；本次跑到没有可推进的步骤为止。`,
    );
    const startedAt = Date.now();
    void service
      .drain()
      .then((result) => {
        for (const event of result.events) this.log?.(event);
        if (result.processed === 0 && !result.pendingExternal) {
          this.log?.(
            `没有可接管的 agent PR（分支前缀 ${WORKTREE_BRANCH_PREFIX} 或已 /patrol register 登记）。`,
          );
          return;
        }
        this.log?.(
          `本次巡查推进 ${result.processed} 步${result.pendingExternal ? "，仍有任务在等外部状态（CI / 草稿 / head）" : ""}。`,
        );
      })
      .catch((error) => this.log?.(`PR 巡查失败：${(error as Error).message}`))
      .finally(async () => {
        // 没活时 drain 会瞬间结束：让「巡查中」至少可见 minRunningMs，避免点了像没反应。
        const remain = this.minRunningMs - (Date.now() - startedAt);
        if (remain > 0) await delay(remain);
        this.service = undefined;
        this.controller = undefined;
        this.stopTimer();
        if (!this.disposed) this.onChange({ status: "ready", pending: 0, repo });
      });
    this.startTimer();
  }

  /** 停止巡检并释放定时器；退出流程必须调用，否则 interval 会挂住进程。 */
  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.controller?.abort();
    this.controller = undefined;
    this.service = undefined;
  }

  private startTimer(): void {
    this.stopTimer();
    const timer = setInterval(() => this.refreshTasks(), this.pollIntervalMs);
    // 只用于刷新 UI，不该阻止进程退出。
    timer.unref?.();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private refreshTasks(): void {
    if (!this.repo || !this.service) return;
    try {
      const jobs = new PatrolStore(path.join(this.cwd, ".haji", "patrol")).listJobs();
      const activity = describeActivity(jobs);
      this.onChange({
        status: "running",
        pending: 0,
        tasks: jobs.length,
        merged: jobs.filter((job) => job.status === "merged").length,
        ...(activity ? { activity } : {}),
        repo: this.repo,
      });
    } catch {
      // 运行数据读失败不影响巡检本身；保持上一帧状态即可。
    }
  }
}

const RUN_ROLE_LABELS: Record<string, string> = {
  review: "审查中",
  fix: "修复中",
  adjudicate: "裁决中",
  merge: "合并中",
};

/**
 * 侧栏「当前在做什么」：优先取运行中的 run，其次合并门禁 / 草稿等待。
 * 含已耗时（分钟取整），分钟不变时字符串不变，避免 5s 轮询空转重绘。
 */
export function describeActivity(jobs: PatrolJob[]): string | undefined {
  for (const job of jobs) {
    if (isTerminalPatrolStatus(job.status)) continue;
    const run = [...job.runs].reverse().find((item) => item.status === "running");
    if (run) {
      const label = RUN_ROLE_LABELS[run.role] ?? run.role;
      const mins = Math.floor((Date.now() - Date.parse(run.startedAt)) / 60_000);
      return `#${job.prNumber} ${label}${Number.isFinite(mins) && mins >= 1 ? ` · ${mins}m` : ""}`;
    }
    if (job.status === "ready_to_merge" || job.status === "merging") {
      return `#${job.prNumber} 合并门禁`;
    }
    if (job.draft) return `#${job.prNumber} 草稿等待`;
  }
  return undefined;
}

/** 可被进程退出打断的等待（timer unref，不挂住退出）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
