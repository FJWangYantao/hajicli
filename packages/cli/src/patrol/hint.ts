/**
 * 侧栏的 PR 巡检入口：探测「有 agent PR 但巡检没在跑」，并支持一键后台启动。
 *
 * 分工约定：
 * - 探测只做一次（启动时），绝不每帧联网；失败静默——侧栏不显示，而不是把错误糊到对话区。
 * - 点击入口启动**常驻**巡查：`runLoop()` 有活连续推进、没活按 `pollIntervalMs` 探测新 PR
 *   （不吃 64 分钟指数退避，保证「PR 一来就跑」）；再点一次或 `/patrol stop` 停止。
 * - 常驻期间每 5s 读本地 store 刷新状态（纯文件读取，不联网）：有非终态任务显示「巡检中」，
 *   没有则显示「等待中」，让「在等」这件事可见。
 * - 不写任何配置文件：仓库由 `git remote origin` 推断，PR 由接管策略自动登记（见 service.ts），
 *   所以「自动配置」的产物只有 `.haji/patrol/` 下的运行数据。
 */
import path from "node:path";
import {
  type AdoptPolicy,
  decideAdoption,
  isTerminalPatrolStatus,
  type PatrolJob,
  PatrolStore,
  patrolJobId,
} from "@hajicli/core";
import { GitHubPatrolAdapter } from "@hajicli/patrol-github";
import { DEFAULT_PATROL_CONFIG, loadPatrolConfig, resolvePatrolRepo } from "./config.js";
import { createHeadlessRunners } from "./runners.js";
import { PatrolService } from "./service.js";
import type { PatrolForgeAdapter, PatrolRunners } from "./types.js";

/** 侧栏入口状态；结构与 `SidebarPatrolState` 一致（渲染层只读，不反向依赖本模块）。 */
export interface PatrolHintState {
  /** waiting = 常驻循环在跑，但当前没有可推进的任务（正在按间隔探测新 PR）。 */
  status: "ready" | "running" | "waiting" | "no-token";
  /** ready 时探测到的、命中接管策略的开放 PR 数。 */
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
  /** 本轮常驻的启动时刻：用于「巡检中」至少可见 minRunningMs。 */
  private startedAt = 0;
  /** 当前生效的接管策略（探测 / 启动时从配置 + 令牌登录名解析）。 */
  private policy: AdoptPolicy = {
    branchPrefixes: [...DEFAULT_PATROL_CONFIG.autoAdoptBranchPrefixes],
    selfAuthored: DEFAULT_PATROL_CONFIG.autoAdoptSelfAuthored,
    labels: [...DEFAULT_PATROL_CONFIG.autoAdoptLabels],
    viewerLogin: null,
  };

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

  /** 提示文案里的接管条件；多前缀用 ` / ` 连接。 */
  private adoptLabel(): string {
    const parts: string[] = [];
    if (this.policy.branchPrefixes.length > 0) {
      parts.push(`分支前缀 ${this.policy.branchPrefixes.join(" / ")}`);
    }
    if (this.policy.selfAuthored) {
      parts.push(`本人提交${this.policy.viewerLogin ? `（${this.policy.viewerLogin}）` : ""}`);
    }
    if (this.policy.labels.length > 0) parts.push(`label ${this.policy.labels.join(" / ")}`);
    return parts.length > 0
      ? `自动接管${parts.join(" 或 ")}的 PR`
      : "未配置自动接管条件，只处理 /patrol register 登记过的 PR";
  }

  /** 读配置里的接管条件；配置损坏时退回默认值，不影响提示渲染。 */
  private readPolicyBase(): Omit<AdoptPolicy, "viewerLogin"> {
    try {
      const config = loadPatrolConfig(this.cwd);
      return {
        branchPrefixes: config.autoAdoptBranchPrefixes,
        selfAuthored: config.autoAdoptSelfAuthored,
        labels: config.autoAdoptLabels,
      };
    } catch {
      return {
        branchPrefixes: [...DEFAULT_PATROL_CONFIG.autoAdoptBranchPrefixes],
        selfAuthored: DEFAULT_PATROL_CONFIG.autoAdoptSelfAuthored,
        labels: [...DEFAULT_PATROL_CONFIG.autoAdoptLabels],
      };
    }
  }

  /** 解析当前策略：配置 + 令牌对应的登录名（读不到时按「无法判定作者」处理）。 */
  private async resolvePolicy(adapter: PatrolForgeAdapter): Promise<AdoptPolicy> {
    let viewerLogin: string | null = null;
    try {
      viewerLogin = (await adapter.getViewerLogin?.()) ?? null;
    } catch {
      viewerLogin = null;
    }
    this.policy = { ...this.readPolicyBase(), viewerLogin };
    return this.policy;
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
      const policy = await this.resolvePolicy(adapter);
      if (this.disposed) return;
      const pending = prs.filter((pr) => {
        if (!decideAdoption(pr, policy).adopted) return false;
        return !store.getJob(patrolJobId(repo, pr.number));
      }).length;
      this.onChange({ status: "ready", pending, repo });
    } catch {
      // 网络不可达 / 401 / 仓库不存在：侧栏不显示入口，用户仍可用 /patrol 命令。
      this.onChange(null);
    }
  }

  /**
   * 侧栏点击入口：启动**常驻**巡查（后台，不阻塞输入）。
   *
   * 有活连续推进；没活按 `pollIntervalMs` 探测新 PR——刻意不吃 64 分钟指数退避，
   * 否则「点完就等着」会退化成半小时才发现新 PR。
   *
   * 停止走 `stop()`：侧栏在运行中 / 等待中点击是「进页面看任务」（保留查看入口），
   * 停止用 `/patrol stop`；这里的 `this.service` 分支只是防止重复启动的兜底。
   */
  async start(): Promise<void> {
    if (this.service) {
      this.stop();
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
    const adapter = this.createAdapter(repo, token);
    await this.resolvePolicy(adapter);
    if (this.disposed) return;
    const controller = new AbortController();
    const service = new PatrolService({
      cwd: this.cwd,
      store: new PatrolStore(path.join(this.cwd, ".haji", "patrol")),
      adapter,
      runners: this.createRunners(),
      logger: (line) => this.log?.(line),
    });
    this.service = service;
    this.controller = controller;
    this.startedAt = Date.now();
    this.onChange({ status: "running", pending: 0, tasks: 0, merged: 0, repo });
    this.log?.(
      `PR 巡查已启动（${repo}），${this.adoptLabel()}；没活时每 ${Math.round(this.pollIntervalMs / 1000)}s 探测新 PR，再点一次或 /patrol stop 停止。`,
    );
    void service
      .runLoop(controller.signal, { idleBackoffCapMs: this.pollIntervalMs })
      .catch((error) => this.log?.(`PR 巡查失败：${(error as Error).message}`))
      .finally(() => {
        // 已被 stop() 清理、或已被下一次点击接管：不动状态，避免覆盖新的常驻。
        if (this.service !== service) return;
        this.service = undefined;
        this.controller = undefined;
        this.stopTimer();
        if (this.disposed) return;
        this.onChange({ status: "ready", pending: 0, repo });
      });
    this.startTimer();
  }

  /** 停止常驻巡查（侧栏再次点击 / `/patrol stop`）；没有在跑时只提示。 */
  stop(): void {
    if (!this.service) {
      this.log?.("PR 巡查没有在运行。");
      return;
    }
    // 同步清掉运行态：`isRunning()` 必须立刻为 false，不能等 runLoop 的 finally。
    this.service = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.stopTimer();
    this.log?.("PR 巡查已停止（点侧栏入口可重新开始）。");
    if (this.disposed) return;
    this.onChange({ status: "ready", pending: 0, ...(this.repo ? { repo: this.repo } : {}) });
    // 停止后重新探测一次，把「还有几个待接管」刷新成最新值。
    void this.probe();
  }

  /** 常驻巡查是否在运行；供 `/patrol stop` 等命令判断。 */
  isRunning(): boolean {
    return this.service !== undefined;
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
      const active = jobs.filter((job) => !isTerminalPatrolStatus(job.status)).length;
      const activity = describeActivity(jobs);
      // 没有非终态任务 = 在等新 PR；刚启动时先保持「巡检中」minRunningMs，避免点了像没反应。
      const waiting = active === 0 && Date.now() - this.startedAt >= this.minRunningMs;
      this.onChange({
        status: waiting ? "waiting" : "running",
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
