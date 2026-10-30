/**
 * PR Patrol 的 runner 接口。
 *
 * 远端仓库（forge）适配契约已上移到 `@hajicli/core`（`patrol/forge.ts`），
 * 实现位于独立包 `@hajicli/patrol-github`；这里只做再导出，保持既有引用路径不变。
 */
import type { PatrolFinding, PatrolJob, PatrolUsage } from "@hajicli/core";

export type { ForgePullRequest, PatrolForgeAdapter } from "@hajicli/core";

export interface RawFinding {
  /** runner 给出的稳定 ID；缺省时由 service 按 location+summary 哈希生成。 */
  findingId?: string;
  severity?: "blocking" | "nonblocking";
  location?: string;
  summary: string;
  evidence?: string;
  requiredFix?: string;
}

export interface ReviewRunnerInput {
  job: PatrolJob;
  prTitle: string;
  diff: string;
  /** 历史问题（含状态），供复核未解决的旧问题。 */
  priorFindings: PatrolFinding[];
}

export interface ReviewRunnerOutput {
  verdict: "pass" | "changes_required" | "inconclusive";
  findings: RawFinding[];
  summary: string;
  usage?: PatrolUsage;
}

export interface FixRunnerInput {
  job: PatrolJob;
  /** 待修复的阻塞问题（含验收条件）。 */
  findings: PatrolFinding[];
  /** 裁决指定的修复指令（enforcing 阶段非空）。 */
  orders: string[];
  attempt: number;
}

export interface FixRunnerOutput {
  status: "pushed" | "disputed" | "failed";
  summary: string;
  /** 推送成功后的新 head（用于校验，权威值以下一轮轮询为准）。 */
  pushedHeadSha?: string;
  /** disputed 时的异议理由。 */
  disputeReason?: string;
  usage?: PatrolUsage;
}

export interface AdjudicationRunnerInput {
  job: PatrolJob;
  /** 引发争议的审查结论。 */
  contestedDecisionId: string;
  findings: PatrolFinding[];
  disputeReason?: string;
}

export interface AdjudicationRunnerOutput {
  verdict: "overrule" | "remediate" | "redo" | "descope" | "terminate";
  reasons: string[];
  /** 裁决驳回（问题不成立）的 findingId 列表。 */
  rejectedFindingIds: string[];
  orders: string[];
  acceptance: string[];
  summary: string;
  usage?: PatrolUsage;
}

export interface PatrolRunners {
  review(input: ReviewRunnerInput): Promise<ReviewRunnerOutput>;
  fix(input: FixRunnerInput): Promise<FixRunnerOutput>;
  adjudicate(input: AdjudicationRunnerInput): Promise<AdjudicationRunnerOutput>;
}
