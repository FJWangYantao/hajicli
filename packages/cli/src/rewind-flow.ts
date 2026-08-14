export const REWIND_CONFIRM_DEFAULT = 'yes';

/** 将 /rewind 回填后提交的文本放到队首，由主输入循环重新解析。 */
export function queueRewindRefill(pendingInputs: string[], input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  pendingInputs.unshift(trimmed);
  return true;
}
