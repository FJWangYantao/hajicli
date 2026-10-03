/**
 * 智谱 GLM 等"永远思考"模型的请求参数适配。
 *
 * 这类模型（如 z.ai 的 glm-5.3）对请求参数有两条硬约束：
 *   1. thinking 不可关闭：`thinking: { type: "disabled" }` 直接 400；
 *   2. reasoning_effort 只接受 low / high / max，medium、xhigh 等档位 400。
 * 两种违规返回同一条错误：
 *   "This model always engages in thinking and cannot be disabled; please use low, high, or max"
 *
 * 适配策略是参数层自动降级：去掉 disabled 的 thinking 字段（模型默认总是思考）、
 * 把不接受的档位向上钳制到最近的合法档（medium→high、xhigh→max）。
 */

/** 匹配"永远思考"模型拒绝参数时返回的 400 错误文案。 */
export function isAlwaysThinkingConflict(message: string): boolean {
  return /cannot be disabled/i.test(message);
}

/**
 * 钳制思考强度档位到"永远思考"模型接受的集合。
 * 向上取整以保持用户选择的思考强度语义：medium→high、xhigh→max；
 * low/high/max 本身合法，原样返回。
 */
export function clampEffortForAlwaysThinking(effort: string): string {
  if (effort === "medium") return "high";
  if (effort === "xhigh") return "max";
  return effort;
}

/**
 * 就地适配 chat/completions 请求 payload：删除会被拒绝的 thinking.type=disabled、
 * 钳制 reasoning_effort 档位。返回 payload 是否被修改。
 *
 * 参数类型放宽为 object 以兼容各 provider 的具名 payload 接口（无索引签名）。
 */
export function adaptPayloadForAlwaysThinking(payload: object): boolean {
  const record = payload as Record<string, unknown>;
  let changed = false;
  const thinking = record.thinking as { type?: unknown } | undefined;
  if (thinking && typeof thinking === "object" && thinking.type === "disabled") {
    delete record.thinking;
    changed = true;
  }
  if (typeof record.reasoning_effort === "string") {
    const clamped = clampEffortForAlwaysThinking(record.reasoning_effort);
    if (clamped !== record.reasoning_effort) {
      record.reasoning_effort = clamped;
      changed = true;
    }
  }
  return changed;
}

/**
 * 按模型记忆适配状态：首次撞上冲突 400 后记住该模型，后续请求在发送前
 * 直接构造合法参数，避免每次都先失败一次。三个 OpenAI 兼容 provider 共用。
 */
export class AlwaysThinkingAdapter {
  private readonly conflictedModels = new Set<string>();

  /** payload 构建完成后调用：已知冲突模型直接就地适配。 */
  applyKnown(model: string, payload: object): void {
    if (this.conflictedModels.has(model)) adaptPayloadForAlwaysThinking(payload);
  }

  /**
   * 请求失败后调用：若错误是"永远思考"冲突则记录该模型并适配 payload。
   * 返回 true 表示 payload 已修改、可以立即重试。
   */
  absorb(model: string, payload: object, status: number | undefined, message: string): boolean {
    if (this.conflictedModels.has(model)) return false;
    if (status !== 400 || !isAlwaysThinkingConflict(message)) return false;
    this.conflictedModels.add(model);
    return adaptPayloadForAlwaysThinking(payload);
  }
}
