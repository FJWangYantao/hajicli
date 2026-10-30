/**
 * PR Patrol 的远端仓库适配接口与 runner 接口。
 *
 * 生产实现走 GitHub REST（github.ts）；测试注入假实现。
 * 接口刻意保持窄面：巡检服务只依赖这组方法，不感知具体平台。
 */
import type { PatrolCheckInfo, PatrolFinding, PatrolJob, PatrolUsage } from "@hajicli/core";

export interface ForgePullRequest {
  repo: string;
  number: number;
  state: "open" | "closed";
  draft: boolean;
  /** 关闭且已合并。 */
  merged: boolean;
  branch: string;
  targetBranch: string;
  headSha: string;
  baseSha: string;
  title: string;
  mergeable: boolean | null;
  updatedAt: string;
}

export interface PatrolForgeAdapter {
  readonly repo: string;
  listOpenPullRequests(): Promise<ForgePullRequest[]>;
  getPullRequest(number: number): Promise<ForgePullRequest | null>;
  /** head 提交上的检查（check runs）。 */
  listCheckRuns(headSha: string): Promise<PatrolCheckInfo[]>;
  /** PR 的完整 diff（文本）。 */
  getDiff(number: number): Promise<string>;
  /** upsert 一条带标记的状态评论（同标记只保留一条，反复刷新）。 */
  postStatusComment(number: number, marker: string, body: string): Promise<void>;
  /**
   * 合并 PR。headSha 用于防止竞态：远端 head 不匹配时必须拒绝。
   * 已被合并的 PR 返回 `{ merged: true, alreadyMerged: true }` 而不是报错。
   */
  merge(
    number: number,
    options: { headSha: string; method?: "merge" | "squash" | "rebase" },
  ): Promise<{ merged: boolean; sha?: string; alreadyMerged?: boolean }>;
  close(number: number): Promise<void>;
}

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
