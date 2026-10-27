/**
 * 单次请求详情页的纯渲染层：把「这一次模型调用的钱是怎么算出来的」摊开。
 *
 * 三层结构的最内层：费用列表 →（Enter）回合详情 →（Enter）本页。
 * 与另外两页同构：只读快照、输出 ANSI 行、返回命中矩形，不做 I/O，可直接按宽度单测。
 *
 * 版式自上而下：身份行 / 费用构成（输入·缓存命中·未命中·输出，逐项 token×单价=金额）/
 * 计价档位 / 在会话里的位置（占本轮、占会话、当前排序名次）/ 数据口径。
 * 高度不够时从下往上先砍「数据口径」与「位置」，费用构成永远保留——它是本页存在的理由。
 */

import {
  backHit,
  bottomBorder,
  type CostLogSort,
  formatDurationMs,
  formatTokenCount,
  frameRow,
  hLine,
  padToWidth,
  sortRequestDetails,
  topBorder,
} from "./cost-log-page.js";
import { formatCostCny, type RequestCostDetail, type RequestPricingTier } from "./cost-tracker.js";
import { SEQ, terminalWidth, truncateText } from "./terminal-text.js";
import { collectTurnDetails } from "./turn-detail-page.js";

/** 页面本身要求的最小宽度/高度；再小由调用方拦下并提示。 */
export const REQUEST_DETAIL_MIN_COLUMNS = 44;
export const REQUEST_DETAIL_MIN_ROWS = 8;
/** 低于该宽度时身份行拆成两行，避免模型名被裁掉。 */
const COMPACT_MIN_WIDTH = 76;

/** 页面状态：回合内选中的那一次调用 + 列表排序视角（只用来算名次）。 */
export interface RequestDetailState {
  details: readonly RequestCostDetail[];
  turn: number;
  /** 本轮调用列表里的选中下标（与回合详情页共用同一套下标）。 */
  selectedIndex: number;
  /** 费用列表当时的排序口径，用来算「当前排序第 N」。 */
  sort: CostLogSort;
}

/** 一帧的产物：只有返回按钮是可点区域，翻页靠 ←→。 */
export interface RequestDetailFrame {
  rows: string[];
  selectedIndex: number;
  count: number;
  back: { row: number; left: number; width: number };
}

/** 本地日期 + 时刻：`2025-01-02 11:04:05`（历史记录里跨天很常见，只给时分秒会看错）。 */
function formatStamp(atMs: number): string {
  const date = new Date(Number.isFinite(atMs) ? atMs : Date.now());
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 单价文案：元 / 百万 token。 */
function priceText(value: number): string {
  return `¥${value.toFixed(2)}/M`;
}

/** 左文右数的一行（inner 宽度内左右对齐）。 */
function splitRow(inner: number, left: string, right: string): string {
  return padToWidth(
    `${left}${" ".repeat(Math.max(1, inner - terminalWidth(left) - terminalWidth(right)))}${right}`,
    inner,
  );
}

/** 元金额：小额保留 4 位，避免被四舍五入成 0.0000。 */
function money(value: number): string {
  return formatCostCny(value);
}

/** 顶栏按钮文案：回的是回合页，不是列表也不是对话区。 */
function backLabelFor(width: number): string {
  return width >= 68 ? "[Esc 返回回合]" : "[返回]";
}

/** 费用构成各行：无单价时整块给「—」，并说明补单价会重算。 */
function costLines(detail: RequestCostDetail, inner: number, label: string): string[] {
  const pricing: RequestPricingTier | undefined = detail.pricing;
  const cached = Math.min(detail.promptTokens, Math.max(0, detail.cachedPromptTokens));
  const uncached = Math.max(0, detail.promptTokens - cached);
  if (!pricing) {
    return [
      splitRow(
        inner,
        `${label}${formatTokenCount(detail.promptTokens)} tokens · ${formatTokenCount(detail.completionTokens)} 输出`,
        "—",
      ),
    ];
  }
  const cachedPrice = pricing.cachedInputPerMTokens ?? pricing.inputPerMTokens;
  const cachedCost = (cached / 1_000_000) * cachedPrice;
  const uncachedCost = (uncached / 1_000_000) * pricing.inputPerMTokens;
  const outputCost = (detail.completionTokens / 1_000_000) * pricing.outputPerMTokens;
  const lines: string[] = [];
  if (cached > 0) {
    // 有缓存命中时，先给输入小计，再拆成「命中 / 未命中」两笔——
    // 三段相加要正好等于输入小计，否则这一页就白做了。
    const saved = (cached / 1_000_000) * (pricing.inputPerMTokens - cachedPrice);
    lines.push(
      splitRow(
        inner,
        `输入  ${formatTokenCount(detail.promptTokens)} tokens（缓存 ${formatTokenCount(cached)} / 未命中 ${formatTokenCount(uncached)}）`,
        money(cachedCost + uncachedCost),
      ),
    );
    lines.push(
      splitRow(
        inner,
        `  ├ 缓存命中  ${formatTokenCount(cached)} × ${priceText(cachedPrice)}${saved > 0 ? `（省 ${money(saved)}）` : ""}`,
        money(cachedCost),
      ),
    );
    lines.push(
      splitRow(
        inner,
        `  └ 未命中  ${formatTokenCount(uncached)} × ${priceText(pricing.inputPerMTokens)}`,
        money(uncachedCost),
      ),
    );
  } else {
    lines.push(
      splitRow(
        inner,
        `输入  ${formatTokenCount(detail.promptTokens)} × ${priceText(pricing.inputPerMTokens)}`,
        money(uncachedCost),
      ),
    );
  }
  lines.push(
    splitRow(
      inner,
      `输出  ${formatTokenCount(detail.completionTokens)} × ${priceText(pricing.outputPerMTokens)}`,
      money(outputCost),
    ),
  );
  return lines;
}

/**
 * 排出整屏请求详情页。
 *
 * 分块按优先级依次尝试放入：身份 → 费用构成 → 在会话里的位置 → 数据口径。
 * 放不下的块整块跳过（不做半截渲染），最后用空行补齐到给定高度。
 */
export function buildRequestDetailFrame(
  state: RequestDetailState,
  width: number,
  height: number,
): RequestDetailFrame {
  const safeWidth = Math.max(REQUEST_DETAIL_MIN_COLUMNS, Math.floor(width));
  const safeHeight = Math.max(REQUEST_DETAIL_MIN_ROWS, Math.floor(height));
  const inner = safeWidth - 2;
  const compact = safeWidth < COMPACT_MIN_WIDTH;

  const items = collectTurnDetails(state.details, state.turn);
  const count = items.length;
  const selectedIndex = Math.min(Math.max(0, state.selectedIndex), Math.max(0, count - 1));
  const detail = items[selectedIndex];

  const rows: string[] = [];
  rows.push(topBorder(safeWidth, "请求详情", backLabelFor(safeWidth)));

  // 可用正文行数：顶框 + 底框各占 1 行。
  const budget = safeHeight - 2;
  const blank = (): string => frameRow(safeWidth, "");

  if (!detail) {
    rows.push(frameRow(safeWidth, `${SEQ.muted}这条记录已不在快照里${SEQ.reset}`));
  } else {
    /** 分块渲染：required 的块（费用构成）必须完整呈现，其余按剩余空间取舍。 */
    const sections: Array<{ rows: string[]; required?: boolean }> = [];
    // 1) 身份行
    const turnText = detail.turn > 0 ? `第 ${detail.turn} 轮` : "未分轮";
    const identity = compact
      ? [
          frameRow(
            safeWidth,
            `${SEQ.boldAccent}#${detail.seq}${SEQ.reset} ${SEQ.muted}${formatStamp(detail.at)}${SEQ.reset}`,
          ),
          frameRow(
            safeWidth,
            `${SEQ.muted}${turnText} · ${detail.purpose} · ${truncateText(detail.model, Math.max(1, inner - terminalWidth(turnText) - terminalWidth(detail.purpose) - 6))}${SEQ.reset}`,
          ),
        ]
      : [
          frameRow(
            safeWidth,
            `${SEQ.boldAccent}#${detail.seq}${SEQ.reset} ${SEQ.muted}· ${formatStamp(detail.at)} · ${turnText} · ${detail.purpose} · ${detail.model}${SEQ.reset}`,
          ),
        ];
    sections.push({ rows: [...identity, blank()] });

    // 2) 费用构成：本页的主角，永远保留。
    const totalText = detail.costCny === null ? "未定价" : money(detail.costCny);
    const costHeader = `${SEQ.boldAccent}${padToWidth("费用构成", Math.max(1, inner - terminalWidth(totalText) - 1))}${SEQ.reset}${SEQ.accent}${totalText}${SEQ.reset}`;
    const tierText = detail.pricing
      ? `${detail.offPeak ? "谷时价" : "峰时价"}（按调用时刻判定）`
      : "无单价信息，补上后自动重算";
    sections.push({
      required: true,
      rows: [
        frameRow(safeWidth, costHeader),
        hLine(safeWidth),
        ...costLines(detail, inner, "").map((line) => frameRow(safeWidth, line)),
      ],
    });
    // 计价档位与耗时/推理是补充说明：挤得下才画，但绝不让费用构成被裁。
    sections.push({
      rows: [
        frameRow(
          safeWidth,
          `${SEQ.muted}${truncateText(`计价档位  ${tierText}`, inner)}${SEQ.reset}`,
        ),
        // 耗时/推理来自扩展记账字段：老会话没有就显 —，不写成 0。
        frameRow(
          safeWidth,
          `${SEQ.muted}${truncateText(
            `本次耗时  ${formatDurationMs(detail.durationMs)}   ·   推理  ${
              detail.reasoningTokens === undefined
                ? "—"
                : `${formatTokenCount(detail.reasoningTokens)} tokens`
            }`,
            inner,
          )}${SEQ.reset}`,
        ),
        blank(),
      ],
    });

    // 3) 在会话里的位置：回答「这笔钱冤不冤」。
    const turnTotal = items.reduce((sum, item) => sum + (item.costCny ?? 0), 0);
    const sessionTotal = state.details.reduce((sum, item) => sum + (item.costCny ?? 0), 0);
    const turnTotalText = turnTotal > 0 ? money(turnTotal) : "—";
    const sessionTotalText = sessionTotal > 0 ? money(sessionTotal) : "—";
    const turnShare =
      detail.costCny !== null && turnTotal > 0
        ? `${Math.round((detail.costCny / turnTotal) * 100)}%`
        : "—";
    const sessionShare =
      detail.costCny !== null && sessionTotal > 0
        ? `${Math.round((detail.costCny / sessionTotal) * 100)}%`
        : "—";
    const ranked = sortRequestDetails(state.details, state.sort);
    const rank = detail === undefined ? 0 : ranked.findIndex((item) => item.seq === detail.seq) + 1;
    sections.push({
      rows: [
        frameRow(safeWidth, `${SEQ.boldAccent}在会话里的位置${SEQ.reset}`),
        hLine(safeWidth),
        frameRow(
          safeWidth,
          `${SEQ.muted}${truncateText(
            `占本轮 ${turnShare}（${totalText} / ${turnTotalText}）· 占会话 ${sessionShare}（${totalText} / ${sessionTotalText}）`,
            inner,
          )}${SEQ.reset}`,
        ),
        frameRow(
          safeWidth,
          `${SEQ.muted}${truncateText(`「${state.sort === "requests" ? "请求" : "花费"}」排序 第 ${rank} / 共 ${state.details.length} 次`, inner)}${SEQ.reset}`,
        ),
        blank(),
      ],
    });

    // 4) 数据口径：说明数字的边界，可有可无。
    const notes: string[] = [];
    if (detail.cachedPromptTokens > 0) {
      notes.push("provider 已上报缓存命中");
    } else if (detail.cacheReported === false) {
      notes.push("provider 未上报缓存命中（按全价计）");
    }
    notes.push("金额按调用时刻单价现算");
    if (detail.costCny === null) notes.push("未定价，补上单价后自动重算");
    sections.push({
      rows: [
        frameRow(safeWidth, `${SEQ.boldAccent}数据口径${SEQ.reset}`),
        hLine(safeWidth),
        frameRow(safeWidth, `${SEQ.muted}${truncateText(notes.join(" · "), inner)}${SEQ.reset}`),
      ],
    });

    // 按优先级落版：必需块（费用构成）永远在，可选块放得下才放。
    const requiredRows = sections
      .filter((section) => section.required)
      .reduce((sum, section) => sum + section.rows.length, 0);
    let room = Math.max(0, budget - requiredRows);
    for (const section of sections) {
      if (section.required) {
        rows.push(...section.rows);
        continue;
      }
      if (section.rows.length <= room) {
        rows.push(...section.rows);
        room -= section.rows.length;
      }
    }
  }

  // 行数兜底：窗口比最小高度还矮时补齐，避免调用方切片越界。
  while (rows.length < safeHeight - 1) rows.push(blank());
  rows.push(
    bottomBorder(
      safeWidth,
      compact ? "←→ 换 · Esc 或点右上返回回合" : "←→ 换相邻调用 · Esc 或点右上返回回合",
    ),
  );

  const backText = ` ${backLabelFor(safeWidth)} `;
  return {
    rows: rows.slice(0, safeHeight),
    selectedIndex,
    count,
    back: backHit(terminalWidth(backText), safeWidth),
  };
}
