/**
 * 侧栏的 PR 巡检入口：探测「有 agent PR 但巡检没在跑」，并支持一键后台启动。
 *
 * 分工约定：
 * - 探测只做一次（启动时），绝不每帧联网；失败静默——侧栏不显示，而不是把错误糊到对话区。
 * - 启动走 `PatrolService.runLoop` 的后台任务，不阻塞输入；运行中每 5s 读本地 store 刷新计数
 *   （纯文件读取，不联网）。
 * - 不写任何配置文件：仓库由 `git remote origin` 推断，PR 由分支前缀自动登记（见 service.ts），
 *   所以「自动配置」的产物只有 `.haji/patrol/` 下的运行数据。
 */
import path from "node:path";
import { PatrolStore, patrolJobId } from "@hajicli/core";
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

  /** 侧栏点击入口：后台启动巡检（幂等，重复点击不会起第二个循环）。 */
  async start(): Promise<void> {
    if (this.service) {
      this.log?.("PR 巡检已在运行。");
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
    this.log?.(`PR 巡检已启动（${repo}），自动接管 ${WORKTREE_BRANCH_PREFIX} 分支的 PR。`);
    void service.runLoop(controller.signal).catch((error) => {
      this.service = undefined;
      this.controller = undefined;
      this.stopTimer();
      this.onChange({ status: "ready", pending: 0, repo });
      this.log?.(`PR 巡检已停止：${(error as Error).message}`);
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
      this.onChange({
        status: "running",
        pending: 0,
        tasks: jobs.length,
        merged: jobs.filter((job) => job.status === "merged").length,
        repo: this.repo,
      });
    } catch {
      // 运行数据读失败不影响巡检本身；保持上一帧状态即可。
    }
  }
}
