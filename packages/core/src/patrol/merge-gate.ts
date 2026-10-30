/**
 * 合并门禁：程序侧的确定性检查，语义判断（通过 / 裁决）只是必要条件之一。
 *
 * 门禁全部满足才允许执行合并动作；任何缺失、取消、超时的必需检查都视为不通过。
 * head 与结论版本不一致时拒绝合并——防止用旧结论合并新提交。
 */

import type { PatrolBudgetStatus } from "./budget.js";
import { latestApplicableDecision, openBlockingFindings } from "./state-machine.js";
import { type PatrolDecision, type PatrolJob, samePatrolVersion } from "./types.js";

export type PatrolCheckStatus =
  | "success"
  | "failure"
  | "pending"
  | "cancelled"
  | "skipped"
  | "missing";

export interface PatrolCheckInfo {
  name: string;
  status: PatrolCheckStatus;
  /** 提交检查的 GitHub App slug（如 github-actions）；用于来源可信判定。 */
  appSlug?: string;
}

export interface PatrolMergePrSnapshot {
  state: "open" | "closed";
  draft: boolean;
  headSha: string;
  /** GitHub 尚未算完时为 null；明确冲突为 false。 */
  mergeable: boolean | null;
}

export interface PatrolMergeGateInput {
  job: PatrolJob;
  pr: PatrolMergePrSnapshot;
  checks: PatrolCheckInfo[];
  /** 必须成功的检查名列表。 */
  requiredChecks: string[];
  /** 认可的检查来源（App slug / workflow 标识）；空列表表示不校验来源。 */
  trustedApps: string[];
  budget: PatrolBudgetStatus;
  paused: boolean;
}

export type PatrolMergeGateResult =
  | { allowed: true; decision: PatrolDecision }
  | { allowed: false; reasons: string[] };

export function evaluatePatrolMergeGate(input: PatrolMergeGateInput): PatrolMergeGateResult {
  const reasons: string[] = [];
  const { job, pr } = input;

  if (input.paused) reasons.push("巡检已暂停（pause）");
  if (job.source.mergeAuthorized === false) {
    reasons.push("PR 来源未授权自动合并（作者非本人且无授权 label），仅审查不合并");
  }
  if (pr.state !== "open") reasons.push(`PR 状态为 ${pr.state}`);
  if (pr.draft) reasons.push("PR 仍是草稿");
  if (pr.mergeable === false) reasons.push("PR 存在合并冲突");
  if (pr.headSha !== job.version.headSha) {
    reasons.push(
      `head 已变化（门禁见到 ${short(pr.headSha)}，结论绑定 ${short(job.version.headSha)}）`,
    );
  }

  const decision = latestApplicableDecision(job);
  if (!decision) {
    reasons.push("当前版本没有审查 / 裁决结论");
  } else if (!samePatrolVersion(decision.version, job.version)) {
    reasons.push("结论版本与当前版本不一致");
  } else if (!["pass", "overrule"].includes(decision.verdict)) {
    reasons.push(`当前版本结论为 ${decision.verdict}，不是通过性结论`);
  }

  const blocking = openBlockingFindings(job);
  if (blocking.length > 0) {
    reasons.push(`存在未解决的阻塞问题: ${blocking.map((f) => f.findingId).join(", ")}`);
  }

  if (job.lease && job.lease.role !== "merge") {
    reasons.push(`存在未释放的写入租约（${job.lease.role} / ${job.lease.holder}）`);
  }
  if (job.runs.some((run) => run.status === "running")) {
    reasons.push("仍有 runner 在运行");
  }

  for (const run of job.runs) {
    if (run.status === "running" && run.version.headSha === job.version.headSha) {
      reasons.push(`当前版本仍有运行中的 ${run.role} run`);
      break;
    }
  }

  if (input.budget.exhausted) reasons.push(...input.budget.reasons);

  const checksByName = new Map<string, PatrolCheckInfo[]>();
  for (const check of input.checks) {
    const list = checksByName.get(check.name) ?? [];
    list.push(check);
    checksByName.set(check.name, list);
  }
  for (const required of input.requiredChecks) {
    const candidates = checksByName.get(required);
    if (!candidates || candidates.length === 0) {
      reasons.push(`必需检查缺失: ${required}`);
      continue;
    }
    const trusted = candidates.filter(
      (check) =>
        input.trustedApps.length === 0 ||
        (check.appSlug && input.trustedApps.includes(check.appSlug)),
    );
    if (trusted.length === 0) {
      reasons.push(
        `检查 ${required} 的来源不受信（${candidates.map((c) => c.appSlug ?? "unknown").join(", ")}）`,
      );
      continue;
    }
    if (trusted.some((check) => check.status === "success")) continue;
    const worst = trusted.find((check) => check.status !== "success");
    if (worst) reasons.push(`必需检查未通过: ${required}（${worst.status}）`);
  }

  if (reasons.length > 0 || !decision) return { allowed: false, reasons };
  return { allowed: true, decision };
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
