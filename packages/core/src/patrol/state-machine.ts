/**
 * 巡检状态机：声明合法转换与守卫条件。
 *
 * 调度器只允许通过 `applyPatrolTransition` 改状态，保证：
 * - 终态（merged / terminated）不可再变；
 * - 进入 ready_to_merge 前必须存在绑定当前版本的通过性结论；
 * - 退回修改前必须存在未解决的阻塞问题；
 * - 新提交到来走 `resetPatrolJobForNewCommit`，作废旧结论并回到 discovered。
 */
import {
  isTerminalPatrolStatus,
  type PatrolDecision,
  type PatrolFinding,
  type PatrolJob,
  type PatrolJobStatus,
  samePatrolVersion,
} from "./types.js";

const TRANSITIONS: Record<PatrolJobStatus, readonly PatrolJobStatus[]> = {
  discovered: ["reviewing", "terminated"],
  reviewing: ["awaiting_changes", "adjudicating", "ready_to_merge", "discovered", "terminated"],
  awaiting_changes: ["fixing", "adjudicating", "discovered", "terminated"],
  fixing: ["reviewing", "adjudicating", "discovered", "terminated"],
  adjudicating: ["ready_to_merge", "enforcing", "terminated"],
  enforcing: ["reviewing", "adjudicating", "discovered", "terminated"],
  ready_to_merge: ["merging", "reviewing", "awaiting_changes", "terminated"],
  merging: ["merged", "ready_to_merge", "awaiting_changes", "terminated"],
  merged: [],
  terminated: [],
};

export function canTransitionPatrolStatus(from: PatrolJobStatus, to: PatrolJobStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** 当前版本下最新且未作废的结论。 */
export function latestApplicableDecision(job: PatrolJob): PatrolDecision | undefined {
  for (let index = job.decisions.length - 1; index >= 0; index -= 1) {
    const decision = job.decisions[index];
    if (samePatrolVersion(decision.version, job.version)) return decision;
  }
  return undefined;
}

export function openBlockingFindings(job: PatrolJob): PatrolFinding[] {
  return job.findings.filter(
    (finding) => finding.severity === "blocking" && finding.state === "open",
  );
}

/**
 * 校验并应用一次状态转换。非法转换抛错（调度器 bug 不应被静默吞掉）；
 * 需要守卫条件的状态在此集中检查。
 */
export function applyPatrolTransition(
  job: PatrolJob,
  to: PatrolJobStatus,
  options: { now?: Date; reason?: string } = {},
): PatrolJob {
  if (isTerminalPatrolStatus(job.status)) {
    throw new Error(`巡检任务 ${job.jobId} 已处于终态 ${job.status}，不能再转换到 ${to}`);
  }
  if (!canTransitionPatrolStatus(job.status, to)) {
    throw new Error(`巡检任务 ${job.jobId} 不允许从 ${job.status} 转换到 ${to}`);
  }
  const now = (options.now ?? new Date()).toISOString();
  if (to === "ready_to_merge") {
    const decision = latestApplicableDecision(job);
    if (!decision) {
      throw new Error("进入 ready_to_merge 需要当前版本的通过性结论（pass / overrule）");
    }
    if (!["pass", "overrule"].includes(decision.verdict)) {
      throw new Error(`当前版本结论为 ${decision.verdict}，不能进入 ready_to_merge`);
    }
    const blocking = openBlockingFindings(job);
    if (blocking.length > 0) {
      throw new Error(`仍存在未解决的阻塞问题: ${blocking.map((f) => f.findingId).join(", ")}`);
    }
  }
  if (to === "awaiting_changes" || to === "fixing") {
    if (openBlockingFindings(job).length === 0) {
      throw new Error("退回修改前必须存在未解决的阻塞问题");
    }
  }
  if (to === "enforcing") {
    const decision = latestApplicableDecision(job);
    if (decision?.kind !== "adjudication") {
      throw new Error("进入 enforcing 需要当前版本的裁决指令");
    }
  }
  if (to === "merged") {
    // merged 只能从 merging 进入，且由门禁放行；这里只做结构性校验。
    if (job.status !== "merging") throw new Error("merged 只能从 merging 进入");
  }
  if (to === "terminated") {
    job.terminatedReason = options.reason || job.terminatedReason || "未说明原因";
  }
  if (to === "merged") job.mergedAt = now;
  job.status = to;
  job.updatedAt = now;
  return job;
}

/**
 * 新提交（或规则版本变更）到来：作废旧结论、回到 discovered 重新走审查。
 * 已合并 / 已终止的任务不再重置。
 */
export function resetPatrolJobForNewCommit(
  job: PatrolJob,
  version: { headSha: string; baseSha: string; ruleVersion: string },
  options: { now?: Date } = {},
): boolean {
  if (isTerminalPatrolStatus(job.status)) return false;
  if (samePatrolVersion(job.version, version)) return false;
  const now = (options.now ?? new Date()).toISOString();
  job.version = { ...version };
  job.status = "discovered";
  job.lease = undefined;
  job.updatedAt = now;
  // 运行中的 run 标记中止：旧版本的结论不再可信。
  for (const run of job.runs) {
    if (run.status === "running") {
      run.status = "aborted";
      run.finishedAt = now;
    }
  }
  return true;
}

/**
 * 审查结论落地：合并问题清单（稳定 findingId 对齐），并决定下一步状态。
 *
 * - pass → ready_to_merge（由调用方走门禁）；
 * - changes_required：普通轮次未满 → awaiting_changes；已满 → adjudicating；
 * - inconclusive → adjudicating（由裁决 agent 独立取证）。
 */
export function planNextStatusAfterReview(
  job: PatrolJob,
  decision: PatrolDecision,
  limits: { maxFixRounds: number },
): PatrolJobStatus {
  if (decision.verdict === "pass") return "ready_to_merge";
  if (decision.verdict === "inconclusive") return "adjudicating";
  // changes_required：达到普通修改上限后不再退回，直接升级裁决。
  if (job.fixRounds >= limits.maxFixRounds) return "adjudicating";
  return "awaiting_changes";
}

/**
 * 把审查结论的问题清单并入任务：
 * - 本次未再被报告的历史 open 问题视为已解决（审查被要求复核全部旧问题）；
 * - 同 findingId 的问题保持原状态语义，仅更新描述字段。
 */
export function mergeReviewFindings(
  job: PatrolJob,
  decision: PatrolDecision,
  options: { now?: Date } = {},
): void {
  const now = (options.now ?? new Date()).toISOString();
  const reported = new Map(
    (decision.findings ?? []).map((finding) => [finding.findingId, finding]),
  );
  for (const finding of job.findings) {
    if (finding.state !== "open") continue;
    if (!reported.has(finding.findingId)) {
      finding.state = "resolved";
      finding.settledAtHead = decision.version.headSha;
    }
  }
  for (const [findingId, incoming] of reported) {
    const existing = job.findings.find((item) => item.findingId === findingId);
    if (existing) {
      existing.severity = incoming.severity;
      existing.location = incoming.location;
      existing.summary = incoming.summary;
      existing.evidence = incoming.evidence;
      existing.requiredFix = incoming.requiredFix;
      if (existing.state === "resolved" || existing.state === "rejected") {
        // 已解决的问题在新版本再次出现：重新打开。
        existing.state = "open";
        existing.settledAtHead = undefined;
      }
    } else {
      job.findings.push({ ...incoming, state: "open", settledAtHead: undefined });
    }
  }
  job.updatedAt = now;
}

/** 裁决落地：驳回的阻塞问题标记 rejected；裁决指令写入 decisions 由调用方完成。 */
export function applyAdjudicationToFindings(
  job: PatrolJob,
  decision: PatrolDecision,
  options: { now?: Date } = {},
): void {
  const now = (options.now ?? new Date()).toISOString();
  const rejected = new Set((decision.findings ?? []).map((finding) => finding.findingId));
  for (const finding of job.findings) {
    if (finding.state === "open" && rejected.has(finding.findingId)) {
      finding.state = "rejected";
      finding.settledAtHead = decision.version.headSha;
    }
  }
  job.updatedAt = now;
}
