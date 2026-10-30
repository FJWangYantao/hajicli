/**
 * PR Patrol 巡检协议类型。
 *
 * 巡检（patrol）服务自动发现已登记来源的 agent PR，派发独立审查、退回原任务
 * 修改、争议升级最终裁决，并在满足确定性门禁后合并。所有结论都绑定
 * 「仓库 + PR + head/base SHA + 规则版本」的版本快照；新提交到来即失效。
 */

/** 巡检任务（对应一个 PR）的生命周期状态。 */
export type PatrolJobStatus =
  | "discovered" // 已登记来源，等待首次审查
  | "reviewing" // 独立审查进行中（含修复后的复查）
  | "awaiting_changes" // 已把阻塞问题退回执行方，等待取得写入租约
  | "fixing" // 执行 worker 正在修改并推送
  | "adjudicating" // 最终裁决 agent 取证中
  | "enforcing" // 按裁决指令修改 / 重做中
  | "ready_to_merge" // 当前版本已获通过结论，等待合并门禁
  | "merging" // 合并执行中（含基线更新后的重验）
  | "merged" // 终态：已合并
  | "terminated"; // 终态：终止（预算耗尽 / 裁决终止 / PR 关闭等）

/** 巡检结论适用的版本快照。 */
export interface PatrolVersion {
  /** PR head 提交。 */
  headSha: string;
  /** PR base 提交（审查时看到的基线）。 */
  baseSha: string;
  /** 巡检规则/配置版本；规则变更后旧结论同样失效。 */
  ruleVersion: string;
}

/**
 * 版本一致性判定：只锚定 head + 规则版本。
 *
 * baseSha 仅作审查时的基线记录——目标分支推进不触发重审（合并门禁会重新
 * 校验当前 checks 与 mergeable，真正的「必须最新」由平台分支规则兜底）。
 */
export function samePatrolVersion(a: PatrolVersion, b: PatrolVersion): boolean {
  return a.headSha === b.headSha && a.ruleVersion === b.ruleVersion;
}

/** 巡检问题。findingId 在同一 PR 内跨轮次保持稳定，用于追踪修复与裁决。 */
export interface PatrolFinding {
  findingId: string;
  severity: "blocking" | "nonblocking";
  /** 位置（文件路径、符号或 PR 描述里的章节）。 */
  location?: string;
  /** 一句话问题描述。 */
  summary: string;
  /** 判断依据 / 证据引用。 */
  evidence: string;
  /** 修复该问题必须满足的验收条件。 */
  requiredFix?: string;
  state: "open" | "resolved" | "rejected";
  /** 问题被认定解决（或被裁决驳回）时的 head。 */
  settledAtHead?: string;
}

/** 审查与裁决产出的结构化结论。 */
export interface PatrolDecision {
  decisionId: string;
  /** 结论类型：review = 审查产出；adjudication = 最终裁决产出。 */
  kind: "review" | "adjudication";
  /** review: pass | changes_required | inconclusive；adjudication: 裁决指令。 */
  verdict:
    | "pass"
    | "changes_required"
    | "inconclusive"
    | "overrule"
    | "remediate"
    | "redo"
    | "descope"
    | "terminate";
  version: PatrolVersion;
  createdAt: string;
  /** 产出该结论的 runner 标识（角色 / 模型），审计用。 */
  byAgent: string;
  reasons: string[];
  /** review 结论附带的问题清单（仅本次新发现 / 维持的问题）。 */
  findings?: PatrolFinding[];
  /** adjudication 指定的修复指令。 */
  orders?: string[];
  /** adjudication 给出的验收条件；后续审查按此验证。 */
  acceptance?: string[];
  summary?: string;
  usage?: PatrolUsage;
}

export interface PatrolUsage {
  promptTokens: number;
  completionTokens: number;
  /** 估算费用（元）；无法估价时为 0，仅作记录。 */
  costCny: number;
}

/** 一次 runner 执行的记录（审查 / 修改 / 裁决）。 */
export interface PatrolRunRecord {
  runId: string;
  role: "review" | "fix" | "adjudicate";
  /** 触发本运行的版本快照。 */
  version: PatrolVersion;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "aborted";
  /** 同一阶段内的重试序号（从 1 起）。 */
  attempt: number;
  summary?: string;
  usage?: PatrolUsage;
}

/** PR 写入租约：同一时间只允许一个执行者改动一个 PR。 */
export interface PatrolLease {
  holder: string;
  role: "fix" | "review" | "adjudicate" | "merge";
  acquiredAt: string;
  expiresAt: string;
}

/** 远端操作的幂等记录：先存意图、再执行、再确认结果。 */
export interface PatrolActionRecord {
  /** 幂等键：jobId:kind:target[:contentHash]。 */
  actionId: string;
  jobId: string;
  kind: "comment" | "merge" | "close" | "label" | "push";
  status: "intended" | "executing" | "done" | "failed";
  attempt: number;
  payload?: Record<string, unknown>;
  lastError?: string;
  createdAt: string;
  finishedAt?: string;
}

/** PR 来源登记：核验「这个 PR 属于哪个任务」，不依赖 PR 描述自述。 */
export interface PatrolSourceRegistration {
  jobId: string;
  repo: string;
  prNumber: number;
  taskId: string;
  agentId?: string;
  sessionId?: string;
  origin: "haji" | "external";
  registeredAt: string;
  taskBrief: string;
  acceptance: string[];
  /** 允许修改的范围（路径前缀 / 模块说明）。 */
  scope: string[];
  /**
   * 是否允许自动合并；缺省视为允许（手动 `/patrol register` 是显式授权）。
   * 自动登记时由接管策略给出：仅分支前缀命中、作者又不是本人时为 false（只审查）。
   */
  mergeAuthorized?: boolean;
}

/** 巡检任务主体。 */
export interface PatrolJob {
  jobId: string; // `${repo}#${prNumber}`，repo 形如 owner/name
  repo: string;
  prNumber: number;
  branch: string;
  targetBranch: string;
  source: {
    taskId: string;
    agentId?: string;
    sessionId?: string;
    origin: "haji" | "external";
    verified: boolean;
    /**
     * 是否允许自动合并。`false` 表示只审查 / 只评论，绝不合并（如「分支前缀命中但作者不是本人」）。
     * 缺省视为允许（兼容旧状态文件与手动 `/patrol register`）。
     */
    mergeAuthorized?: boolean;
  };
  taskBrief: string;
  acceptance: string[];
  scope: string[];
  /** 当前处理版本；远端 head 变化后由调度器重置并作废旧结论。 */
  version: PatrolVersion;
  status: PatrolJobStatus;
  draft: boolean;
  /** 轮次：普通修改已达上限时 changes_required 升级为裁决。 */
  fixRounds: number;
  adjudicationRounds: number;
  findings: PatrolFinding[];
  decisions: PatrolDecision[];
  runs: PatrolRunRecord[];
  lease?: PatrolLease;
  usage: PatrolUsage;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergedSha?: string;
  terminatedReason?: string;
}

/** 巡检运行限制。 */
export interface PatrolLimits {
  /** 普通修改最多轮次（默认 3，达到后升级裁决）。 */
  maxFixRounds: number;
  /** 裁决后修改最多轮次（默认 2，达到后终止）。 */
  maxAdjudicationRounds: number;
  /** 单 PR 估算费用上限（元）。 */
  maxCostCny: number;
  /** 为最终裁决预留的费用额度：普通阶段花费超过 (max - reserve) 后不再派普通修改。 */
  reserveAdjudicationCny: number;
  /** 单 PR 最长处理时长（毫秒）。 */
  maxAgeMs: number;
  /** 同一 run 的最大重试次数（网络 / 模型临时故障）。 */
  maxRunRetries: number;
}

export const DEFAULT_PATROL_LIMITS: PatrolLimits = {
  maxFixRounds: 3,
  maxAdjudicationRounds: 2,
  maxCostCny: 20,
  reserveAdjudicationCny: 5,
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxRunRetries: 3,
};

export function normalizePatrolLimits(input?: Partial<PatrolLimits>): PatrolLimits {
  const merged = { ...DEFAULT_PATROL_LIMITS, ...input };
  const clampInt = (value: number, min: number, max: number): number => {
    const candidate = Number.isFinite(value) ? Math.trunc(value) : min;
    return Math.max(min, Math.min(max, candidate));
  };
  return {
    maxFixRounds: clampInt(merged.maxFixRounds, 1, 10),
    maxAdjudicationRounds: clampInt(merged.maxAdjudicationRounds, 0, 10),
    maxCostCny: Math.max(0.01, Number(merged.maxCostCny) || DEFAULT_PATROL_LIMITS.maxCostCny),
    reserveAdjudicationCny: Math.max(
      0,
      Math.min(Number(merged.reserveAdjudicationCny) || 0, merged.maxCostCny),
    ),
    maxAgeMs: Math.max(60_000, Number(merged.maxAgeMs) || DEFAULT_PATROL_LIMITS.maxAgeMs),
    maxRunRetries: clampInt(merged.maxRunRetries, 0, 10),
  };
}

export function patrolJobId(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

export function isTerminalPatrolStatus(status: PatrolJobStatus): boolean {
  return status === "merged" || status === "terminated";
}
