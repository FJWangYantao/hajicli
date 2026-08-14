export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const AUTO_COMPACTION_TRIGGER_RATIO = 0.7;
export const AUTO_COMPACTION_REARM_RATIO = 0.5;
export const AUTO_COMPACTION_EMERGENCY_RATIO = 0.9;

export const DEFAULT_COMPACTION_TOKEN_THRESHOLD = Math.round(
  DEFAULT_CONTEXT_WINDOW_TOKENS * AUTO_COMPACTION_TRIGGER_RATIO
);

export interface ContextCompactionThresholds {
  contextWindowTokens: number;
  triggerTokens: number;
  rearmTokens: number;
  emergencyTokens: number;
}

/**
 * 计算自动压缩的高低水位。
 *
 * 达到 trigger 时触发常规压缩；压缩后只有降到 rearm 以下才重新布防，
 * 避免在阈值附近反复压缩。即使尚未重新布防，达到 emergency 也会强制压缩。
 */
export function getContextCompactionThresholds(contextWindowTokens: number): ContextCompactionThresholds {
  const normalized = Math.max(1_000, Math.round(contextWindowTokens));
  return {
    contextWindowTokens: normalized,
    triggerTokens: Math.round(normalized * AUTO_COMPACTION_TRIGGER_RATIO),
    rearmTokens: Math.round(normalized * AUTO_COMPACTION_REARM_RATIO),
    emergencyTokens: Math.round(normalized * AUTO_COMPACTION_EMERGENCY_RATIO)
  };
}

/** 应用滞回策略：布防时越过常规线触发，未布防时仅紧急线可强制触发。 */
export function shouldTriggerAutoCompaction(
  usedTokens: number,
  thresholds: ContextCompactionThresholds,
  armed: boolean
): boolean {
  return usedTokens >= thresholds.emergencyTokens
    || (armed && usedTokens >= thresholds.triggerTokens);
}
