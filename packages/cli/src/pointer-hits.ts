/**
 * 指针可点目标的登记与命中测试。
 *
 * 终端里的「可点」一律是上一帧算好的屏幕区域（1 基行列），点击时只做一次查表：
 * 队列 steer 行、首页入口、侧栏区域、「回到底部」浮标。这里把查表的语义集中起来，
 * 让 TerminalUI 侧只剩「拿到哪个目标 → 执行什么动作」。
 */
import { redactSensitiveCommand, sanitizeTerminalText } from "./terminal-sanitize.js";
import { truncateText } from "./terminal-text.js";

/** 一块矩形命中区（屏幕绝对行列，1 基，含端点）。 */
export interface ColumnRowSpan {
  columnStart: number;
  columnEnd: number;
  rowStart: number;
  rowEnd: number;
}

/** 一行内的横向命中段（屏幕绝对行，1 基，含端点）。 */
export interface RowSpan {
  row: number;
  left: number;
  right: number;
}

/** 队列里可点的一行 steer 按钮。 */
export interface QueueSteerHit extends RowSpan {
  /** 在 queuedInputs 里的下标。 */
  index: number;
  /** 按下时的文本快照：松开时文本已变（被编辑/清空）就不算同一次点击。 */
  text: string;
}

/** 该格是否落在这块矩形里。 */
export function spanContains(span: ColumnRowSpan, column: number, row: number): boolean {
  return (
    column >= span.columnStart &&
    column <= span.columnEnd &&
    row >= span.rowStart &&
    row <= span.rowEnd
  );
}

/** 该格命中的行内横向段；没有命中返回 undefined。 */
export function rowSpanAt<T extends RowSpan>(
  spans: readonly T[],
  column: number,
  row: number,
): T | undefined {
  return spans.find((span) => span.row === row && column >= span.left && column <= span.right);
}

/**
 * 解析鼠标位置命中的侧栏区域 id；不在任何区域上时返回 undefined。
 *
 * 命中区按 depth 升序登记（见 buildSidebarFrame 末尾的排序），所以从后往前找
 * 就等价于"深层优先"：定价 agent 行 > 配置单价行 > 整块费用。
 */
export function sidebarRegionAt(
  hits: ReadonlyMap<string, ColumnRowSpan>,
  column: number,
  row: number,
): string | undefined {
  let found: string | undefined;
  for (const [id, hit] of hits) {
    if (spanContains(hit, column, row)) found = id;
  }
  return found;
}

/**
 * 排队消息区的行：标题 + 每条待发送消息（可 steer 的带 [steer] 按钮）+ 溢出提示。
 * steer 按钮只给非斜杠命令，且总开关打开时才有。
 */
export function buildQueueSteerRows(input: {
  queued: readonly string[];
  width: number;
  maxItems: number;
  steerEnabled: boolean;
}): string[] {
  const { queued, width, maxItems, steerEnabled } = input;
  if (!queued.length || maxItems <= 0) return [];
  const rows = [truncateText(`待发送 (${queued.length} 条 · Alt+Q 管理 · 本轮结束后发送)`, width)];
  for (let index = 0; index < Math.min(maxItems, queued.length); index++) {
    const text = queued[index];
    const button = steerEnabled && !text.trimStart().startsWith("/") ? "[steer] " : "";
    rows.push(
      truncateText(
        ` ${button}${index + 1}. ${redactSensitiveCommand(sanitizeTerminalText(text)).replace(/\s*\n\s*/g, " ")}`,
        width,
      ),
    );
  }
  if (queued.length > maxItems) rows.push(truncateText("… Alt+Q 查看其余消息", width));
  return rows;
}

/**
 * 从已排好的行里反查出 [steer] 按钮的横向范围，登记成命中段。
 *
 * 行里带 ANSI（truncateText 可能插入截断序列），所以先剥色再定位；`screenTop` 是
 * 这批行首行对应的屏幕行号（1 基）。
 */
export function buildQueueSteerHits(input: {
  rows: readonly string[];
  queued: readonly string[];
  screenTop: number;
}): QueueSteerHit[] {
  const { rows, queued, screenTop } = input;
  const hits: QueueSteerHit[] = [];
  for (let offset = 0; offset < rows.length; offset++) {
    const plain = rows[offset].replace(/\x1b\[[0-9;]*m/g, "");
    const match = /^\s*›?\s*\[steer\] (\d+)\./u.exec(plain);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const text = queued[index];
    if (text === undefined) continue;
    const left = plain.indexOf("[steer]") + 1;
    hits.push({ row: screenTop + offset, left, right: left + 6, index, text });
  }
  return hits;
}
