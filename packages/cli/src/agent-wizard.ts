/**
 * 交互式配置向导的输入校验与辅助（纯函数，可单测）。
 *
 * 向导（/subagent、/preset add、/preset edit 的交互式流程）要求：
 *   - 输入非法时原地重问，而不是抛错终止整个流程；
 *   - 数值字段留空表示“跳过/保持”，输入 b 或 back 返回上一步。
 * 本模块只做纯校验，UI 循环在 index.ts 中驱动。
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

const DECIMAL_INTEGER = /^[+-]?\d+$/;

/** 解析可选整数输入：空串 → undefined（跳过/保持）；合法十进制整数 → 值；否则返回错误信息。 */
export function parseOptionalInteger(raw: string, min: number, max: number): ParseResult<number | undefined> {
  const input = raw.trim();
  if (!input) return { ok: true, value: undefined };
  if (!DECIMAL_INTEGER.test(input)) {
    return { ok: false, message: `必须是 ${min} 到 ${max} 之间的整数` };
  }
  const value = Number(input);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, message: `必须是 ${min} 到 ${max} 之间的整数` };
  }
  return { ok: true, value };
}

/** 任务描述校验：非空才合法。 */
export function validateDescription(raw: string): string | null {
  return raw.trim() ? null : '任务描述不能为空';
}

/** instructions 校验：空串允许（跳过），非空时受长度上限约束。 */
export function validateInstructionsInput(raw: string, maxLength: number): string | null {
  const input = raw.trim();
  if (!input) return null;
  if (input.length > maxLength) return `最多 ${maxLength} 个字符`;
  return null;
}

/** 数值字段的向导提示模板（带当前值和跳过说明）。 */
export function budgetPrompt(label: string, current: number | undefined, min: number, max: number): string {
  const currentText = current !== undefined ? String(current) : '默认';
  return `${label}（当前：${currentText}，范围 ${min}-${max}，回车跳过，b 返回上一步）› `;
}

/** 文本字段的向导提示模板。 */
export function textPrompt(label: string, hint: string): string {
  return `${label}（${hint}，b 返回上一步）› `;
}
