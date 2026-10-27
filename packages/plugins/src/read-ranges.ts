/**
 * 读取区间记账：识别「叠读」——同一文件里再次读取与已读区间高度重叠的区块。
 *
 * 只读工具无法判断模型是不是「忘了刚读过」，但可以把重复劳动显式指出来，
 * 让模型改用 nextStartLine 继续，而不是回头补读（A/B: scope_discipline）。
 */

export interface LineRange {
  /** 1-based，含 */
  start: number;
  /** 1-based，含 */
  end: number;
}

/** 低于这个行数的小范围重读不提示（读 3 行确认一下是正常行为）。 */
const MIN_HINT_SPAN = 40;
/** 重叠比例达到这个阈值才提示。 */
const MIN_HINT_RATIO = 0.5;
const MAX_RANGES_IN_HINT = 3;

function normalize(range: LineRange): LineRange {
  return range.start <= range.end ? range : { start: range.end, end: range.start };
}

/** 已读区间与 [start,end] 的重叠行数占本次请求行数的比例（0-1）。 */
export function overlapRatio(covered: readonly LineRange[], start: number, end: number): number {
  const request = normalize({ start, end });
  const span = request.end - request.start + 1;
  if (span <= 0) return 0;
  let overlap = 0;
  for (const raw of covered) {
    const range = normalize(raw);
    const from = Math.max(range.start, request.start);
    const to = Math.min(range.end, request.end);
    if (to >= from) overlap += to - from + 1;
  }
  return Math.min(1, overlap / span);
}

/** 合并重叠/相邻区间，保持按起点排序。 */
export function mergeRanges(covered: readonly LineRange[], next: LineRange): LineRange[] {
  const merged: LineRange[] = [...covered, normalize(next)].sort((a, b) => a.start - b.start);
  const result: LineRange[] = [];
  for (const range of merged) {
    const last = result[result.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}

/** 生成叠读提示；不需要提示时返回 undefined。 */
export function buildOverlapHint(
  covered: readonly LineRange[],
  start: number,
  end: number,
): string | undefined {
  const request = normalize({ start, end });
  if (request.end - request.start + 1 < MIN_HINT_SPAN) return undefined;
  const ratio = overlapRatio(covered, request.start, request.end);
  if (ratio < MIN_HINT_RATIO) return undefined;
  const shown = covered
    .slice(-MAX_RANGES_IN_HINT)
    .map((range) => `${range.start}-${range.end}`)
    .join("、");
  return `提示：本次请求有 ${Math.round(ratio * 100)}% 与已读区间重叠（已读 ${shown}）；需要更多内容请从 nextStartLine 继续，不要重复读同一区块。`;
}

/** 按「代理 + 文件」记录已读区间。 */
export class ReadRangeTracker {
  private readonly ranges = new Map<string, LineRange[]>();

  public check(key: string, start: number, end: number): string | undefined {
    const covered = this.ranges.get(key);
    if (!covered || covered.length === 0) return undefined;
    return buildOverlapHint(covered, start, end);
  }

  public record(key: string, start: number, end: number): void {
    if (end < start) return;
    this.ranges.set(key, mergeRanges(this.ranges.get(key) ?? [], { start, end }));
  }
}
