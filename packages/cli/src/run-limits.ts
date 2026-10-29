/**
 * 无人值守运行的硬上限（`haji -p` 与 `haji mcp-serve` 的 `--max-cost` / `--max-turns`）。
 *
 * 交互会话的 `budget` 偏好只在回合小结里提醒；CI 与外部 agent 驱动需要的是会真正停下的闸：
 * - `--max-cost <元>`：本进程启动以来（`-c` 续写时不含历史花费）的估算费用，含子代理、压缩等旁路调用；
 * - `--max-turns <n>`：单个回合内向模型发请求的次数（一次请求 = 一轮「思考 → 工具调用」）。
 *
 * 检查点在每次请求之前：已经在跑的请求与工具批不会被打断，超出部分最多是一次请求的费用。
 */

export interface RunLimits {
  maxCostCny?: number;
  maxTurns?: number;
}

export type RunLimitKind = "max_cost" | "max_turns";

export interface RunLimitHit {
  kind: RunLimitKind;
  message: string;
}

export const MAX_TURNS_CEILING = 10_000;

/** 解析 `--max-cost` / `--max-turns` 的取值；合法返回数值，否则返回给用户看的错误。 */
export function parseRunLimitValue(
  flag: "--max-cost" | "--max-turns",
  raw: string | undefined,
): { value: number } | { error: string } {
  const value = Number(raw);
  if (flag === "--max-cost") {
    if (raw === undefined || raw.startsWith("--") || !Number.isFinite(value) || value <= 0) {
      return { error: "--max-cost 需要一个大于 0 的金额（元），例如：--max-cost 2" };
    }
    return { value };
  }
  if (
    raw === undefined ||
    raw.startsWith("--") ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TURNS_CEILING
  ) {
    return {
      error: `--max-turns 需要一个 1–${MAX_TURNS_CEILING} 之间的整数，例如：--max-turns 20`,
    };
  }
  return { value };
}

export function hasRunLimits(limits: RunLimits | undefined): limits is RunLimits {
  return Boolean(limits && (limits.maxCostCny !== undefined || limits.maxTurns !== undefined));
}

const formatCny = (value: number): string => `¥${value.toFixed(value < 1 ? 4 : 2)}`;

/**
 * 发下一次请求前的判定：费用先于轮数（费用超了再多一轮也不该发）。
 * requestsThisTurn 是本回合已经发出的请求数。
 */
export function evaluateRunLimits(
  limits: RunLimits,
  state: { requestsThisTurn: number; costCny: number },
): RunLimitHit | undefined {
  if (limits.maxCostCny !== undefined && state.costCny >= limits.maxCostCny) {
    return {
      kind: "max_cost",
      message: `已达费用上限 ${formatCny(limits.maxCostCny)}（本次运行已花 ${formatCny(state.costCny)}），停止后续请求。`,
    };
  }
  if (limits.maxTurns !== undefined && state.requestsThisTurn >= limits.maxTurns) {
    return {
      kind: "max_turns",
      message: `已达请求轮数上限 ${limits.maxTurns}，停止后续请求。`,
    };
  }
  return undefined;
}
