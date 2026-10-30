/**
 * 巡检服务编排：轮询 → 版本快照比对 → 派发审查 / 修改 / 裁决 → 合并门禁 → 合并 / 终止。
 *
 * 单轮 `tick()` 的顺序（全部状态经 PatrolStore 持久化）：
 * 1. 暂停检查；
 * 2. 拉取开放 PR，为「已登记来源」的 PR 建任务；
 * 3. 对账：PR 关闭 / 合并 / head 变化 → 外部事件直接收敛任务状态；
 * 4. 逐任务推进（按创建时间排序；同一目标分支一轮只允许一个合并）；
 * 5. 状态评论 upsert（Action 幂等，重复内容不重发）。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AdoptPolicy,
  applyAdjudicationToFindings,
  applyPatrolTransition,
  decideAdoption,
  evaluatePatrolMergeGate,
  isTerminalPatrolStatus,
  latestApplicableDecision,
  mergeReviewFindings,
  openBlockingFindings,
  type PatrolDecision,
  type PatrolFinding,
  type PatrolJob,
  PatrolStore,
  type PatrolUsage,
  type PatrolWakeEvent,
  type PatrolWakeSource,
  patrolBudgetStatus,
  patrolJobId,
  planNextStatusAfterReview,
  resetPatrolJobForNewCommit,
} from "@hajicli/core";
import { loadPatrolConfig, type PatrolConfig } from "./config.js";
import { stableFindingId } from "./runners.js";
import type { ForgePullRequest, PatrolForgeAdapter, PatrolRunners } from "./types.js";

export interface PatrolServiceOptions {
  cwd?: string;
  store?: PatrolStore;
  adapter: PatrolForgeAdapter;
  runners: PatrolRunners;
  config?: Partial<PatrolConfig>;
  logger?: (line: string) => void;
  /** run 租约时长（同时是无头进程的兜底超时），默认 30 分钟。 */
  runTimeoutMs?: number;
  /** run 日志目录，默认 `<cwd>/.haji/patrol/runs`。 */
  runsDir?: string;
}

export interface PatrolTickResult {
  skipped?: "paused";
  processed: number;
  events: string[];
}

export interface PatrolDrainResult {
  processed: number;
  events: string[];
  /** 本轮是否推进了任何任务状态；用于重置退避。 */
  progressed: boolean;
  /** 是否仍有非终态任务在等外部状态（CI / 草稿转正 / head 变化）。 */
  pendingExternal: boolean;
}

/** 等外部状态（CI 未跑完、草稿转正）时的首次复查间隔，之后指数退避。 */
const EXTERNAL_RECHECK_MS = 20_000;
/** 退避上限：64 分钟。 */
const IDLE_BACKOFF_MAX_MS = 64 * 60_000;
/** 单次 drain 的最大推进轮数，防止异常状态下无限循环。 */
const MAX_DRAIN_ROUNDS = 50;

export class PatrolService {
  readonly store: PatrolStore;
  readonly config: PatrolConfig;
  private readonly adapter: PatrolForgeAdapter;
  private readonly runners: PatrolRunners;
  private readonly logger: (line: string) => void;
  private readonly runTimeoutMs: number;
  private readonly runsDir: string;
  private readonly disputes = new Map<string, string>();
  /** `GET /user` 的登录名缓存；undefined = 尚未解析，null = 解析失败。 */
  private viewerLogin?: string | null;

  constructor(options: PatrolServiceOptions) {
    const cwd = options.cwd ?? process.cwd();
    this.store = options.store ?? new PatrolStore(`${cwd}/.haji/patrol`);
    this.config = { ...loadPatrolConfig(cwd), ...options.config } as PatrolConfig;
    this.adapter = options.adapter;
    this.runners = options.runners;
    this.logger = options.logger ?? (() => {});
    this.runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;
    this.runsDir = options.runsDir ?? path.join(cwd, ".haji", "patrol", "runs");
  }

  /**
   * 自动登记可接管的 PR：只写 registry.json，仍走「来源登记是接管前提」的既有路径，
   * 因此可随时 `/patrol unregister` 收回。
   *
   * 接管条件（见 core 的 `decideAdoption`）：分支前缀命中 ∥ 本人提交（可配置）∥ 命中授权 label。
   * 合并授权单独判定：只有「本人提交 / 授权 label / 前缀命中且解析不到登录名」才允许自动合并，
   * 别人用同样前缀提的 PR 会被接管审查，但不会被自动合并。
   */
  private async adoptAgentPullRequests(prs: ForgePullRequest[], events: string[]): Promise<void> {
    const policy = await this.adoptPolicy();
    const now = new Date().toISOString();
    for (const pr of prs) {
      const decision = decideAdoption(pr, policy);
      if (!decision.adopted) continue;
      const jobId = patrolJobId(this.adapter.repo, pr.number);
      if (this.store.getRegistration(jobId) || this.store.getJob(jobId)) continue;
      const taskId =
        (decision.matchedPrefix
          ? pr.branch.slice(decision.matchedPrefix.length)
          : pr.branch
        ).trim() || `pr-${pr.number}`;
      this.store.saveRegistration({
        jobId,
        repo: this.adapter.repo,
        prNumber: pr.number,
        taskId,
        origin: "haji",
        registeredAt: now,
        taskBrief: pr.title || taskId,
        acceptance: [],
        scope: [],
        mergeAuthorized: decision.mergeAuthorized,
      });
      events.push(
        `自动登记 PR #${pr.number}（${decision.reason}；${decision.mergeAuthorized ? "允许合并" : "仅审查不合并"}）`,
      );
    }
  }

  /** 接管策略快照：配置 + 当前令牌对应的登录名（解析失败时退化为只按前缀 / label 判定）。 */
  private async adoptPolicy(): Promise<AdoptPolicy> {
    return {
      branchPrefixes: this.config.autoAdoptBranchPrefixes,
      selfAuthored: this.config.autoAdoptSelfAuthored,
      labels: this.config.autoAdoptLabels,
      viewerLogin: await this.resolveViewerLogin(),
    };
  }

  /** `GET /user` 结果缓存：一次会话只查一次，失败也只查一次。 */
  private async resolveViewerLogin(): Promise<string | null> {
    if (this.viewerLogin !== undefined) return this.viewerLogin;
    try {
      this.viewerLogin = (await this.adapter.getViewerLogin?.()) ?? null;
    } catch {
      this.viewerLogin = null;
    }
    return this.viewerLogin;
  }

  /**
   * 事件驱动主循环：有活连续推进，没活指数退避。
   *
   * - `drain()` 内部一直推进到「没有任何状态变化」为止，不再按固定周期空等；
   * - 仍有任务在等外部（CI / 草稿转正 / head 变化）时，从 20s 起指数退避复查；
   * - 完全空闲时按 `pollIntervalMs` 起指数退避探测新 PR，上限 64 分钟；
   * - 任何一轮有推进都重置退避。signal 中止后退出。
   * - 传入 `wake` 时，等待可被 webhook 事件提前打断；轮询仍是兜底（事件会丢、会乱序）。
   */
  async runLoop(
    signal: AbortSignal,
    options: { idleBackoffCapMs?: number; wake?: PatrolWakeSource } = {},
  ): Promise<void> {
    const idleCap = options.idleBackoffCapMs ?? IDLE_BACKOFF_MAX_MS;
    const wake = options.wake;
    let externalBackoff = 0;
    let idleBackoff = 0;
    while (!signal.aborted) {
      // 暂停期间固定按 pollIntervalMs 复查，避免退避到 64 分钟后恢复延迟。
      // 暂停是显式意图，这段时间不响应唤醒事件。
      if (this.store.isPaused()) {
        await sleep(signal, this.config.pollIntervalMs);
        continue;
      }
      let result: PatrolDrainResult;
      try {
        result = await this.drain();
      } catch (error) {
        this.logger(`巡检轮失败：${(error as Error).message}`);
        externalBackoff = 0;
        idleBackoff += 1;
        await sleep(signal, backoffMs(this.config.pollIntervalMs, idleBackoff));
        continue;
      }
      for (const event of result.events) this.logger(event);
      if (result.progressed) {
        externalBackoff = 0;
        idleBackoff = 0;
      }
      if (result.pendingExternal) {
        const woke = await this.waitForWake(
          signal,
          backoffMs(EXTERNAL_RECHECK_MS, externalBackoff),
          wake,
        );
        if (woke) {
          externalBackoff = 0;
          idleBackoff = 0;
        } else {
          externalBackoff += 1;
        }
      } else {
        const woke = await this.waitForWake(
          signal,
          Math.min(backoffMs(this.config.pollIntervalMs, idleBackoff), idleCap),
          wake,
        );
        if (woke) {
          idleBackoff = 0;
        } else {
          idleBackoff += 1;
        }
      }
    }
  }

  /**
   * 等到「退避到期」或「唤醒事件到达」，先到者胜。
   * 没有唤醒源、或唤醒源抛错时退化为纯 sleep——**绝不能因为唤醒通道坏了就不干活**。
   */
  private async waitForWake(
    signal: AbortSignal,
    ms: number,
    wake?: PatrolWakeSource,
  ): Promise<PatrolWakeEvent | undefined> {
    if (!wake) {
      await sleep(signal, ms);
      return undefined;
    }
    try {
      const event = await wake.wait(signal, ms);
      if (event) {
        const target = event.prNumber === undefined ? "" : ` #${event.prNumber}`;
        const action = event.action ? `（${event.action}）` : "";
        this.logger(`收到 ${event.event}${action}${target} 事件，立即复查`);
      }
      return event ?? undefined;
    } catch (error) {
      this.logger(`唤醒通道不可用（${(error as Error).message}），退回轮询`);
      await sleep(signal, ms);
      return undefined;
    }
  }

  /**
   * 连续推进所有任务，直到本轮不再产生任何状态变化。
   *
   * 一次状态跃迁（审查通过 → 待合并 → 合并）不再需要各等一个轮询周期：
   * 同一次调用内会一路推进到必须等待外部状态为止。
   * `processed` 是各轮推进次数的累加，仅用于日志，不代表去重后的任务数。
   */
  async drain(): Promise<PatrolDrainResult> {
    const events: string[] = [];
    let processed = 0;
    let progressed = false;
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
      if (this.store.isPaused()) break;
      const before = this.jobSignature();
      const result = await this.tick();
      events.push(...result.events);
      processed += result.processed;
      // 没有状态变化 = 所有任务都在等外部（CI / 草稿 / head）或已终态，退出。
      if (this.jobSignature() === before) break;
      progressed = true;
    }
    return {
      processed,
      events,
      progressed,
      pendingExternal: this.hasPendingExternal(),
    };
  }

  /** 任务状态指纹：任一字段变化都算「有进展」。 */
  private jobSignature(): string {
    return JSON.stringify(
      this.store
        .listJobs()
        .map((job) => [
          job.jobId,
          job.status,
          job.version.headSha,
          job.fixRounds,
          job.adjudicationRounds,
          job.draft,
          job.runs.length,
          job.findings.length,
          job.decisions.length,
          job.lease?.holder ?? "",
          job.updatedAt,
        ]),
    );
  }

  /** 仍有非终态任务 = 在等外部状态（CI、草稿转正、head 变化）。 */
  private hasPendingExternal(): boolean {
    return this.store
      .listJobs()
      .some((job) => job.repo === this.adapter.repo && !isTerminalPatrolStatus(job.status));
  }

  async tick(): Promise<PatrolTickResult> {
    if (this.store.isPaused()) return { skipped: "paused", processed: 0, events: [] };
    const events: string[] = [];
    const prs = await this.adapter.listOpenPullRequests();
    const openByNumber = new Map(prs.map((pr) => [pr.number, pr]));

    // 0. 自动登记：分支名命中 autoAdoptBranchPrefixes 任一前缀的开放 PR 视为 agent 产出，无需手动 register。
    await this.adoptAgentPullRequests(prs, events);

    // 1. 为已登记来源的开放 PR 建任务（未登记的不自动接管）。
    for (const pr of prs) {
      const jobId = patrolJobId(this.adapter.repo, pr.number);
      const registration = this.store.getRegistration(jobId);
      if (!registration || this.store.getJob(jobId)) continue;
      const job = this.createJobFromRegistration(pr, registration);
      this.store.saveJob(job);
      events.push(`登记新任务 ${job.jobId}（head ${short(job.version.headSha)}）`);
    }

    // 2. 对账：关闭 / 合并 / head 变化。
    for (const job of this.store.listJobs()) {
      if (job.repo !== this.adapter.repo) continue;
      const pr = openByNumber.get(job.prNumber);
      if (pr) {
        if (isTerminalPatrolStatus(job.status)) continue;
        const current = this.store.getJob(job.jobId);
        if (!current) continue;
        current.draft = pr.draft;
        if (
          resetPatrolJobForNewCommit(current, {
            headSha: pr.headSha,
            baseSha: pr.baseSha,
            ruleVersion: this.config.ruleVersion,
          })
        ) {
          this.store.saveJob(current);
          events.push(`${job.jobId} head 更新为 ${short(pr.headSha)}，旧结论作废，重新审查`);
        } else if (current.draft !== job.draft) {
          this.store.saveJob(current);
        }
        continue;
      }
      // 不在开放列表：确认是被合并还是被关闭。
      const detail = await this.adapter.getPullRequest(job.prNumber);
      if (!detail) continue;
      if (isTerminalPatrolStatus(job.status)) continue;
      const current = this.store.getJob(job.jobId);
      if (!current) continue;
      if (detail.merged) {
        current.status = "merged";
        current.mergedAt = new Date().toISOString();
        current.updatedAt = current.mergedAt;
        current.terminatedReason = undefined;
        this.store.saveJob(current);
        events.push(`${job.jobId} 已在外部合并`);
      } else if (detail.state === "closed") {
        this.terminate(current, `PR 已被关闭`);
        events.push(`${job.jobId} 终止：PR 已被关闭`);
      }
    }

    // 3. 逐任务推进；草稿等待 ready，同一目标分支一轮只合并一个。
    const jobs = this.store
      .listJobs()
      .filter((job) => job.repo === this.adapter.repo && !isTerminalPatrolStatus(job.status))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let processed = 0;
    for (const snapshot of jobs) {
      const job = this.store.getJob(snapshot.jobId);
      if (!job) continue;
      if (job.draft) {
        await this.postDraftWaitingComment(job);
        continue;
      }
      const jobEvents = await this.advance(job);
      processed += 1;
      events.push(...jobEvents);
    }
    return { processed, events };
  }

  // ---- 单任务状态推进 ---------------------------------------------------

  private async advance(job: PatrolJob): Promise<string[]> {
    const events: string[] = [];
    const budget = patrolBudgetStatus(job, this.config.limits);
    switch (job.status) {
      case "discovered":
      case "reviewing":
        return this.dispatchReview(job);
      case "awaiting_changes":
      case "fixing":
        if (budget.exhausted) {
          this.terminate(job, `预算耗尽：${budget.reasons.join("；")}`);
          return [`${job.jobId} 终止：预算耗尽`];
        }
        if (budget.normalPhaseExhausted) {
          if (budget.adjudicationAllowed) {
            applyPatrolTransition(job, "adjudicating", { reason: "普通阶段预算耗尽，升级裁决" });
            this.store.saveJob(job);
            return [`${job.jobId} 普通阶段预算耗尽，升级裁决`];
          }
          this.terminate(job, `预算耗尽：${budget.reasons.join("；")}`);
          return [`${job.jobId} 终止：预算耗尽`];
        }
        return this.dispatchFix(job);
      case "adjudicating":
        if (job.adjudicationRounds >= this.config.limits.maxAdjudicationRounds) {
          this.terminate(job, "裁决轮次已达上限，问题仍未收敛");
          return [`${job.jobId} 终止：裁决轮次耗尽`];
        }
        if (!budget.adjudicationAllowed || budget.exhausted) {
          this.terminate(job, `预算耗尽无法裁决：${budget.reasons.join("；")}`);
          return [`${job.jobId} 终止：预算耗尽`];
        }
        return this.dispatchAdjudication(job);
      case "enforcing":
        if (budget.exhausted) {
          this.terminate(job, `预算耗尽：${budget.reasons.join("；")}`);
          return [`${job.jobId} 终止：预算耗尽`];
        }
        if (job.adjudicationRounds >= this.config.limits.maxAdjudicationRounds) {
          this.terminate(job, "裁决后修改仍未通过且裁决轮次已耗尽");
          return [`${job.jobId} 终止：裁决轮次耗尽`];
        }
        return this.dispatchFix(job);
      case "ready_to_merge":
      case "merging":
        return this.tryMerge(job, events);
      default:
        return events;
    }
  }

  private async dispatchReview(job: PatrolJob): Promise<string[]> {
    const events: string[] = [];
    const budget = patrolBudgetStatus(job, this.config.limits);
    if (budget.exhausted || budget.normalPhaseExhausted) {
      this.terminate(job, `无法继续审查：${budget.reasons.join("；") || "普通阶段预算耗尽"}`);
      return [`${job.jobId} 终止：预算耗尽`];
    }
    const attempt = this.nextAttempt(job, "review");
    const runId = this.beginRun(job, "review", attempt);
    try {
      if (job.status === "discovered") applyPatrolTransition(job, "reviewing");
      this.store.saveJob(job);
      const diff = await this.adapter.getDiff(job.prNumber);
      const output = await this.runners.review({
        job,
        prTitle: job.branch,
        diff,
        priorFindings: job.findings,
      });
      this.finishRun(job, runId, "succeeded", output.summary);
      this.addUsage(job, output.usage);
      const findings = output.findings.map((raw) => this.toFinding(job, raw));
      const decision: PatrolDecision = {
        decisionId: `dec-${randomUUID().slice(0, 8)}`,
        kind: "review",
        verdict: output.verdict,
        version: { ...job.version },
        createdAt: new Date().toISOString(),
        byAgent: "review-runner",
        reasons: [],
        findings,
        summary: output.summary,
        usage: output.usage,
      };
      job.decisions.push(decision);
      if (output.verdict === "pass") {
        mergeReviewFindings(job, decision);
        applyPatrolTransition(job, "ready_to_merge");
        events.push(`${job.jobId} 审查通过，进入合并门禁`);
      } else if (output.verdict === "changes_required") {
        mergeReviewFindings(job, decision);
        const next = planNextStatusAfterReview(job, decision, this.config.limits);
        applyPatrolTransition(job, next, { reason: "审查退回修改" });
        events.push(
          `${job.jobId} 审查退回（${findings.filter((f) => f.severity === "blocking").length} 个阻塞问题）→ ${next}`,
        );
      } else {
        applyPatrolTransition(job, "adjudicating", { reason: "审查无法判定" });
        events.push(`${job.jobId} 审查无法判定，升级裁决`);
      }
      job.lease = undefined;
      this.store.saveJob(job);
      await this.postStatusComment(job);
    } catch (error) {
      this.handleRunFailure(job, runId, "review", error, events);
    }
    return events;
  }

  private async dispatchFix(job: PatrolJob): Promise<string[]> {
    const events: string[] = [];
    const attempt = this.nextAttempt(job, "fix");
    const orders: string[] = [];
    let acceptance: string[] = [];
    if (job.status === "enforcing") {
      const decision = latestApplicableDecision(job);
      orders.push(...(decision?.orders ?? []));
      acceptance = decision?.acceptance ?? [];
    }
    const runId = this.beginRun(job, "fix", attempt);
    try {
      if (job.status === "awaiting_changes") applyPatrolTransition(job, "fixing");
      this.store.saveJob(job);
      const output = await this.runners.fix({
        job,
        findings: openBlockingFindings(job),
        orders,
        attempt,
      });
      // 结果为 failed 时 run 也记为 failed，否则连续失败计数永远为 0，预算升级失效。
      this.finishRun(
        job,
        runId,
        output.status === "failed" ? "failed" : "succeeded",
        output.summary,
      );
      this.addUsage(job, output.usage);
      if (acceptance.length > 0) {
        // 裁决验收条件交给下一轮审查验证（审查提示词含 acceptance）。
      }
      if (output.status === "pushed") {
        applyPatrolTransition(job, "reviewing", { reason: "修复已推送，等待重新审查" });
        events.push(`${job.jobId} 修复推送完成，等待下一轮对账后重新审查`);
      } else if (output.status === "disputed") {
        this.disputes.set(job.jobId, output.disputeReason ?? "");
        applyPatrolTransition(job, "adjudicating", { reason: "执行 agent 提出异议" });
        events.push(`${job.jobId} 执行 agent 提出异议，升级裁决`);
      } else {
        this.retryOrFail(job, "fix", `修改失败：${output.summary}`, events);
      }
      job.lease = undefined;
      this.store.saveJob(job);
      await this.postStatusComment(job);
    } catch (error) {
      this.handleRunFailure(job, runId, "fix", error, events);
    }
    return events;
  }

  private async dispatchAdjudication(job: PatrolJob): Promise<string[]> {
    const events: string[] = [];
    const attempt = this.nextAttempt(job, "adjudicate");
    const contested =
      [...job.decisions].reverse().find((decision) => decision.kind === "review") ?? undefined;
    const runId = this.beginRun(job, "adjudicate", attempt);
    try {
      // 状态可能已是 adjudicating（fixing 异议转来）；自转换不是合法路径，跳过。
      if (job.status !== "adjudicating") {
        applyPatrolTransition(job, "adjudicating", { reason: "裁决中" });
      }
      this.store.saveJob(job);
      const output = await this.runners.adjudicate({
        job,
        contestedDecisionId: contested?.decisionId ?? "",
        findings: openBlockingFindings(job),
        disputeReason: this.disputes.get(job.jobId),
      });
      this.disputes.delete(job.jobId);
      this.finishRun(job, runId, "succeeded", output.summary);
      this.addUsage(job, output.usage);
      const decision: PatrolDecision = {
        decisionId: `dec-${randomUUID().slice(0, 8)}`,
        kind: "adjudication",
        verdict: output.verdict,
        version: { ...job.version },
        createdAt: new Date().toISOString(),
        byAgent: "adjudicate-runner",
        reasons: output.reasons,
        findings: job.findings.filter((finding) =>
          output.rejectedFindingIds.includes(finding.findingId),
        ),
        orders: output.orders,
        acceptance: output.acceptance,
        summary: output.summary,
        usage: output.usage,
      };
      job.decisions.push(decision);
      job.adjudicationRounds += 1;
      if (output.verdict === "terminate") {
        this.terminate(job, `裁决终止：${output.reasons.join("；") || output.summary}`);
        events.push(`${job.jobId} 裁决终止`);
      } else if (output.verdict === "overrule") {
        applyAdjudicationToFindings(job, decision);
        if (openBlockingFindings(job).length > 0) {
          // 驳回部分问题后仍有阻塞项：按 remediate 处理，指令为剩余问题。
          decision.verdict = "remediate";
          decision.orders = [
            ...(decision.orders ?? []),
            ...openBlockingFindings(job).map((finding) => finding.requiredFix || finding.summary),
          ];
          applyPatrolTransition(job, "enforcing", { reason: "驳回部分问题，其余仍需修复" });
          events.push(`${job.jobId} 裁决驳回部分问题，其余进入修复`);
        } else {
          applyAdjudicationToFindings(job, decision);
          applyPatrolTransition(job, "ready_to_merge");
          events.push(`${job.jobId} 裁决驳回全部阻塞问题，进入合并门禁`);
        }
      } else {
        applyPatrolTransition(job, "enforcing", { reason: `裁决指令：${output.verdict}` });
        events.push(`${job.jobId} 裁决指令 ${output.verdict}，进入执行`);
      }
      job.lease = undefined;
      this.store.saveJob(job);
      await this.postStatusComment(job);
    } catch (error) {
      this.handleRunFailure(job, runId, "adjudicate", error, events);
    }
    return events;
  }

  private async tryMerge(job: PatrolJob, events: string[]): Promise<string[]> {
    const pr = await this.adapter.getPullRequest(job.prNumber);
    if (!pr) return events;
    const checks = await this.adapter.listCheckRuns(job.version.headSha);
    const gate = evaluatePatrolMergeGate({
      job,
      pr: {
        state: pr.state,
        draft: pr.draft,
        headSha: pr.headSha,
        mergeable: pr.mergeable,
      },
      checks,
      requiredChecks: this.config.requiredChecks,
      trustedApps: this.config.trustedApps,
      budget: patrolBudgetStatus(job, this.config.limits),
      paused: this.store.isPaused(),
    });
    if (!gate.allowed) {
      if (job.source.mergeAuthorized === false && job.status === "ready_to_merge") {
        applyPatrolTransition(job, "terminated", {
          reason: "仅审查：PR 来源未授权自动合并（作者非本人且无授权 label）",
        });
        this.store.saveJob(job);
        await this.postStatusComment(job);
        events.push(`${job.jobId} 审查通过但来源未授权合并，收敛为仅审查`);
        return events;
      }
      if (gate.reasons.some((reason) => reason.includes("合并冲突"))) {
        job.findings.push({
          findingId: "f-merge-conflict",
          severity: "blocking",
          summary: "PR 与目标分支存在合并冲突",
          evidence: "GitHub mergeable=false",
          requiredFix: "基于最新目标分支解决冲突后重新推送",
          state: "open",
        });
        applyPatrolTransition(job, "awaiting_changes", { reason: "合并冲突退回修改" });
        this.store.saveJob(job);
        await this.postStatusComment(job);
        events.push(`${job.jobId} 合并冲突，退回修改`);
        return events;
      }
      events.push(`${job.jobId} 门禁未过（${gate.reasons[0] ?? "未知原因"}），等待下一轮`);
      return events;
    }
    // 同一目标分支一轮只合并一个：避免基于过期集成结果连续合入。
    const mergingSameTarget = this.store
      .listJobs()
      .some(
        (other) =>
          other.jobId !== job.jobId &&
          other.status === "merging" &&
          other.targetBranch === job.targetBranch,
      );
    if (mergingSameTarget) {
      events.push(`${job.jobId} 等待同目标分支的其他合并完成`);
      return events;
    }
    if (job.status === "ready_to_merge") {
      applyPatrolTransition(job, "merging");
      this.store.saveJob(job);
    }
    const actionId = `${job.jobId}:merge:${job.version.headSha}`;
    const begun = this.store.beginAction({ actionId, jobId: job.jobId, kind: "merge" });
    if (begun.skip) {
      // 上一次合并实际已成功（崩溃在确认之前）：直接收敛为已合并。
      this.markMerged(job, undefined);
      events.push(`${job.jobId} 合并动作此前已完成，收敛为已合并`);
      return events;
    }
    this.store.markActionExecuting(actionId);
    try {
      const result = await this.adapter.merge(job.prNumber, {
        headSha: job.version.headSha,
        method: this.config.mergeMethod,
      });
      this.store.markActionResult(actionId, {
        ok: result.merged,
        error: result.merged ? undefined : "合并未完成",
      });
      if (result.merged) {
        this.markMerged(job, result.sha);
        events.push(`${job.jobId} 已合并（${short(result.sha ?? job.version.headSha)}）`);
        await this.postStatusComment(job);
      } else {
        // merge=false 且未报错：回到门禁等待下一轮（如分支保护要求最新）。
        applyPatrolTransition(job, "ready_to_merge");
        this.store.saveJob(job);
        events.push(
          `${job.jobId} 合并未生效（${result.alreadyMerged ? "已被合并" : "平台拒绝"}），回退门禁`,
        );
      }
    } catch (error) {
      this.store.markActionResult(actionId, { ok: false, error: (error as Error).message });
      applyPatrolTransition(job, "ready_to_merge");
      this.store.saveJob(job);
      events.push(`${job.jobId} 合并失败：${(error as Error).message}`);
    }
    return events;
  }

  // ---- 辅助 -------------------------------------------------------------

  private createJobFromRegistration(
    pr: ForgePullRequest,
    registration: {
      taskId: string;
      agentId?: string;
      sessionId?: string;
      origin: "haji" | "external";
      taskBrief: string;
      acceptance: string[];
      scope: string[];
      mergeAuthorized?: boolean;
    },
  ): PatrolJob {
    const now = new Date().toISOString();
    return {
      jobId: patrolJobId(pr.repo, pr.number),
      repo: pr.repo,
      prNumber: pr.number,
      branch: pr.branch,
      targetBranch: pr.targetBranch,
      source: {
        taskId: registration.taskId,
        agentId: registration.agentId,
        sessionId: registration.sessionId,
        origin: registration.origin,
        verified: true,
        ...(registration.mergeAuthorized === undefined
          ? {}
          : { mergeAuthorized: registration.mergeAuthorized }),
      },
      taskBrief: registration.taskBrief,
      acceptance: registration.acceptance,
      scope: registration.scope,
      version: {
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        ruleVersion: this.config.ruleVersion,
      },
      status: "discovered",
      draft: pr.draft,
      fixRounds: 0,
      adjudicationRounds: 0,
      findings: [],
      decisions: [],
      runs: [],
      usage: { promptTokens: 0, completionTokens: 0, costCny: 0 },
      createdAt: now,
      updatedAt: now,
    };
  }

  private beginRun(job: PatrolJob, role: "review" | "fix" | "adjudicate", attempt: number): string {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    job.runs.push({
      runId,
      role,
      version: { ...job.version },
      startedAt: new Date().toISOString(),
      status: "running",
      attempt,
    });
    job.lease = {
      holder: runId,
      role,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.runTimeoutMs).toISOString(),
    };
    if (role === "fix" && attempt === 1 && job.status === "awaiting_changes") {
      job.fixRounds += 1;
    }
    this.store.saveJob(job);
    this.appendRunLog(
      job,
      runId,
      `start role=${role} attempt=${attempt} pr=#${job.prNumber} head=${short(job.version.headSha)}`,
    );
    return runId;
  }

  /** run 日志追加到 `.haji/patrol/runs/<jobId>/<runId>.log`；失败不影响巡检。 */
  private appendRunLog(job: PatrolJob, runId: string, line: string): void {
    try {
      const dir = path.join(this.runsDir, job.jobId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${runId}.log`), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // 日志落盘失败不能中断巡检本身。
    }
  }

  private finishRun(
    job: PatrolJob,
    runId: string,
    status: "succeeded" | "failed",
    summary?: string,
  ): void {
    const run = job.runs.find((item) => item.runId === runId);
    if (run) {
      run.status = status;
      run.finishedAt = new Date().toISOString();
      run.summary = summary;
    }
    const oneLine = summary ? ` summary=${summary.replace(/\s*\n\s*/g, " ⏎ ")}` : "";
    this.appendRunLog(job, runId, `finish status=${status}${oneLine}`);
  }

  private handleRunFailure(
    job: PatrolJob,
    runId: string,
    role: "review" | "fix" | "adjudicate",
    error: unknown,
    events: string[],
  ): void {
    this.finishRun(job, runId, "failed", (error as Error).message);
    job.lease = undefined;
    this.retryOrFail(job, role, (error as Error).message, events);
    this.store.saveJob(job);
  }

  private retryOrFail(
    job: PatrolJob,
    role: "review" | "fix" | "adjudicate",
    message: string,
    events: string[],
  ): void {
    const failedAttempts = this.consecutiveFailedAttempts(job, role);
    if (failedAttempts > this.config.limits.maxRunRetries) {
      if (
        role === "adjudicate" ||
        !patrolBudgetStatus(job, this.config.limits).adjudicationAllowed
      ) {
        this.terminate(job, `${role} 连续失败：${message}`);
        events.push(`${job.jobId} 终止：${role} 连续失败`);
        return;
      }
      if (role === "fix") {
        // 升级裁决时把执行 agent 最后的报告带给裁决者：连续失败常是「问题已解决但流程没走对」，
        // 裁决者必须能看到执行方的主张才能做出 overrule / remediate 的正确判断。
        const lastFix = [...job.runs].reverse().find((run) => run.role === "fix");
        if (lastFix?.summary) {
          this.disputes.set(
            job.jobId,
            `执行 agent 连续修改失败，其最后一次报告：${lastFix.summary}`,
          );
        }
      }
      applyPatrolTransition(job, "adjudicating", { reason: `${role} 连续失败，升级裁决` });
      events.push(`${job.jobId} ${role} 连续失败，升级裁决`);
      return;
    }
    events.push(`${job.jobId} ${role} 失败（第 ${failedAttempts} 次）：${message}，下一轮重试`);
  }

  private consecutiveFailedAttempts(job: PatrolJob, role: "review" | "fix" | "adjudicate"): number {
    let count = 0;
    for (let index = job.runs.length - 1; index >= 0; index -= 1) {
      const run = job.runs[index];
      if (run.role !== role) break;
      if (run.status === "failed") count += 1;
      else break;
    }
    return count;
  }

  private nextAttempt(job: PatrolJob, role: "review" | "fix" | "adjudicate"): number {
    const last = [...job.runs].reverse().find((run) => run.role === role);
    if (!last) return 1;
    if (last.status === "failed" && sameVersion(last.version, job.version)) return last.attempt + 1;
    return 1;
  }

  private terminate(job: PatrolJob, reason: string): void {
    // 外部事件（PR 关闭）或预算 / 连续失败终止：允许从任意非终态直接收敛。
    if (isTerminalPatrolStatus(job.status)) return;
    job.terminatedReason = reason;
    job.status = "terminated";
    job.updatedAt = new Date().toISOString();
    this.disputes.delete(job.jobId);
    this.store.saveJob(job);
  }

  private markMerged(job: PatrolJob, sha?: string): void {
    job.status = "merged";
    job.mergedAt = new Date().toISOString();
    job.mergedSha = sha;
    job.updatedAt = job.mergedAt;
    this.store.saveJob(job);
  }

  private addUsage(job: PatrolJob, usage?: PatrolUsage): void {
    if (!usage) return;
    job.usage.promptTokens += usage.promptTokens ?? 0;
    job.usage.completionTokens += usage.completionTokens ?? 0;
    job.usage.costCny += usage.costCny ?? 0;
  }

  private toFinding(
    job: PatrolJob,
    raw: {
      findingId?: string;
      severity?: "blocking" | "nonblocking";
      location?: string;
      summary: string;
      evidence?: string;
      requiredFix?: string;
    },
  ): PatrolFinding {
    return {
      findingId: stableFindingId(job.jobId, raw),
      severity: raw.severity === "nonblocking" ? "nonblocking" : "blocking",
      location: raw.location,
      summary: raw.summary,
      evidence: raw.evidence ?? "",
      requiredFix: raw.requiredFix,
      state: "open",
    };
  }

  // ---- 状态评论 ---------------------------------------------------------

  private statusCommentMarker(job: PatrolJob): string {
    return `<!-- haji-patrol:status:${job.jobId} -->`;
  }

  private async postStatusComment(job: PatrolJob): Promise<void> {
    const body = formatStatusComment(job, this.statusCommentMarker(job));
    const actionId = `${job.jobId}:comment:${hashBody(body)}`;
    const begun = this.store.beginAction({
      actionId,
      jobId: job.jobId,
      kind: "comment",
      payload: { prNumber: job.prNumber },
    });
    if (begun.skip) return;
    this.store.markActionExecuting(actionId);
    try {
      await this.adapter.postStatusComment(job.prNumber, this.statusCommentMarker(job), body);
      this.store.markActionResult(actionId, { ok: true });
    } catch (error) {
      this.store.markActionResult(actionId, { ok: false, error: (error as Error).message });
    }
  }

  private async postDraftWaitingComment(job: PatrolJob): Promise<void> {
    const body = `## 🛰️ PR Patrol\n\n状态：**草稿等待 ready**（head ${short(job.version.headSha)}）。转为 ready 后自动开始审查。`;
    const actionId = `${job.jobId}:comment:draft:${job.version.headSha}`;
    const begun = this.store.beginAction({ actionId, jobId: job.jobId, kind: "comment" });
    if (begun.skip) return;
    this.store.markActionExecuting(actionId);
    try {
      await this.adapter.postStatusComment(job.prNumber, this.statusCommentMarker(job), body);
      this.store.markActionResult(actionId, { ok: true });
    } catch (error) {
      this.store.markActionResult(actionId, { ok: false, error: (error as Error).message });
    }
  }
}

export function formatStatusComment(job: PatrolJob, marker: string): string {
  return [
    marker,
    "## 🛣️ PR Patrol 巡检状态",
    "",
    `- 阶段：**${job.status}**（head \`${short(job.version.headSha)}\`）`,
    `- 轮次：修改 ${job.fixRounds}，裁决 ${job.adjudicationRounds}`,
    `- 费用估算：¥${job.usage.costCny.toFixed(2)}`,
  ]
    .concat(openBlockingFindings(job).length > 0 ? ["", "### 未解决的阻塞问题"] : [])
    .concat(
      openBlockingFindings(job).map(
        (finding) =>
          `- \`${finding.findingId}\` ${finding.summary}${finding.location ? `（${finding.location}）` : ""}`,
      ),
    )
    .concat(job.terminatedReason ? ["", `> 终止原因：${job.terminatedReason}`] : [])
    .concat(
      job.mergedAt ? ["", `> ✅ 已合并（${short(job.mergedSha ?? job.version.headSha)}）`] : [],
    )
    .concat(["", `_更新于 ${new Date().toISOString()}_`])
    .join("\n");
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function hashBody(body: string): string {
  // 轻量内容指纹：同内容不重发。避免引入 crypto 依赖到评论路径（已在上层引入）。
  let hash = 0;
  for (let index = 0; index < body.length; index += 1) {
    hash = (hash * 31 + body.charCodeAt(index)) | 0;
  }
  return `h${(hash >>> 0).toString(16)}`;
}

function sameVersion(
  a: { headSha: string; ruleVersion: string },
  b: { headSha: string; ruleVersion: string },
): boolean {
  return a.headSha === b.headSha && a.ruleVersion === b.ruleVersion;
}

/** 指数退避：base * 2^attempt，封顶 64 分钟。 */
export function backoffMs(base: number, attempt: number): number {
  return Math.min(base * 2 ** attempt, IDLE_BACKOFF_MAX_MS);
}

function sleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
