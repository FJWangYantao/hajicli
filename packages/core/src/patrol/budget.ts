/**
 * 巡检预算：轮次 / 费用 / 时长三类上限，并为最终裁决预留额度。
 *
 * 判定规则：
 * - `exhausted` 为 true 时任何新的 runner 派发都不允许（只能终止或等待）；
 * - 普通修改在花费超过（上限 - 裁决预留）后不再派发，把剩余额度留给裁决；
 * - 裁决本身只受总上限约束。
 */
import type { PatrolJob, PatrolLimits } from "./types.js";

export interface PatrolBudgetStatus {
  /** 总预算耗尽：不允许任何新的派发。 */
  exhausted: boolean;
  /** 普通阶段（审查 / 修改）额度耗尽，只能升级裁决或终止。 */
  normalPhaseExhausted: boolean;
  /** 还能为最终裁决派发（未触总上限）。 */
  adjudicationAllowed: boolean;
  reasons: string[];
}

export function patrolBudgetStatus(job: PatrolJob, limits: PatrolLimits): PatrolBudgetStatus {
  const reasons: string[] = [];
  const spent = job.usage.costCny;
  const ageMs = Date.now() - Date.parse(job.createdAt);
  const costExhausted = spent >= limits.maxCostCny;
  const roundsExhausted =
    job.fixRounds >= limits.maxFixRounds && job.adjudicationRounds >= limits.maxAdjudicationRounds;
  const adjudicationRoundsExhausted = job.adjudicationRounds >= limits.maxAdjudicationRounds;
  const ageExhausted = Number.isFinite(ageMs) && ageMs >= limits.maxAgeMs;

  if (costExhausted) reasons.push(`费用已达上限（¥${spent.toFixed(2)} / ¥${limits.maxCostCny}）`);
  if (roundsExhausted)
    reasons.push(`轮次已达上限（修改 ${job.fixRounds} + 裁决 ${job.adjudicationRounds}）`);
  if (ageExhausted) reasons.push(`处理时长已达上限（${Math.round(ageMs / 3600_000)}h）`);
  if (adjudicationRoundsExhausted) reasons.push(`裁决轮次已达上限（${job.adjudicationRounds}）`);

  const exhausted = costExhausted || roundsExhausted || ageExhausted;
  const normalPhaseExhausted =
    exhausted ||
    adjudicationRoundsExhausted ||
    spent >= Math.max(0, limits.maxCostCny - limits.reserveAdjudicationCny);

  return {
    exhausted,
    normalPhaseExhausted,
    adjudicationAllowed: !exhausted && !adjudicationRoundsExhausted,
    reasons,
  };
}
