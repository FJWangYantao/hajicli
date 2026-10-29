/**
 * 覆盖对话区的只读整页视图（上下文详情 / 费用日志三层）的渲染决策。
 *
 * 从 TerminalUI 抽出的纯逻辑：给定页面状态与终端尺寸，决定本帧该画哪一层、
 * 判断终端放不放得下、并把帧内几何换算成屏幕坐标（1 基）的命中区域。
 * TerminalUI 只负责把结果写回自己的字段、夹紧状态并调度重绘。
 */
import {
  buildContextInspectorFrame,
  CONTEXT_INSPECTOR_MIN_COLUMNS,
  CONTEXT_INSPECTOR_MIN_ROWS,
  type ContextInspectorFrame,
} from "./context-inspector.js";
import {
  buildCostLogFrame,
  COST_LOG_MIN_COLUMNS,
  COST_LOG_MIN_ROWS,
  type CostLogFrame,
} from "./cost-log-page.js";
import type { ContextInspectorState, CostLogPageState, OverlayHit } from "./overlay-navigation.js";
import {
  buildRequestDetailFrame,
  REQUEST_DETAIL_MIN_COLUMNS,
  REQUEST_DETAIL_MIN_ROWS,
  type RequestDetailFrame,
} from "./request-detail-page.js";
import {
  buildTurnDetailFrame,
  TURN_DETAIL_MIN_COLUMNS,
  TURN_DETAIL_MIN_ROWS,
  type TurnDetailFrame,
} from "./turn-detail-page.js";

/** 本帧排出的各层页面帧；只有当前打开的那几层有值。 */
export interface OverlayPageFrames {
  inspector?: ContextInspectorFrame;
  request?: RequestDetailFrame;
  turn?: TurnDetailFrame;
  costLog?: CostLogFrame;
}

export interface OverlayPageResolution extends OverlayPageFrames {
  /** 终端比页面最小尺寸还小：只画一行说明，也不登记命中区域。 */
  tooSmall: boolean;
  /** 页面名称，用于「终端太小」的说明行。 */
  pageName: string;
  /** 本帧要替换对话区的行；没有打开的页面时为 undefined。 */
  rows?: string[];
}

/** 列表类页面共有的几何字段：帧内行号/列号都是 0 基。 */
type ListFrameGeometry = Pick<
  CostLogFrame,
  "listTop" | "listHeight" | "listLeft" | "listWidth" | "listOffset" | "itemHeight" | "back"
>;

/**
 * 排出整页视图。费用页有两个层次：列表，以及按 Enter 进去的回合详情 / 请求详情，
 * 详情页盖在列表之上，同一时刻只排一帧。没有打开的页面时返回空结果。
 */
export function resolveOverlayPage(
  inspector: ContextInspectorState | undefined,
  costLog: CostLogPageState | undefined,
  width: number,
  height: number,
): OverlayPageResolution {
  const inspectorFrame = inspector
    ? buildContextInspectorFrame(
        {
          groups: inspector.groups,
          categoryIndex: inspector.categoryIndex,
          selectedIndex: inspector.selectedIndex,
          scroll: inspector.scroll,
        },
        width,
        height,
      )
    : undefined;
  const turnDetailView = costLog?.turnDetail;
  const requestFrame =
    costLog && turnDetailView?.openDetail
      ? buildRequestDetailFrame(
          {
            details: costLog.details,
            turn: turnDetailView.turn,
            selectedIndex: turnDetailView.selectedIndex,
            sort: costLog.sort,
          },
          width,
          height,
        )
      : undefined;
  const turnFrame =
    costLog && turnDetailView && !requestFrame
      ? buildTurnDetailFrame(
          {
            details: costLog.details,
            turn: turnDetailView.turn,
            selectedIndex: turnDetailView.selectedIndex,
          },
          width,
          height,
        )
      : undefined;
  const costLogFrame =
    costLog && !turnFrame
      ? buildCostLogFrame(
          {
            details: costLog.details,
            sort: costLog.sort,
            selectedIndex: costLog.selectedIndex,
          },
          width,
          height,
        )
      : undefined;

  const pageMinColumns = requestFrame
    ? REQUEST_DETAIL_MIN_COLUMNS
    : turnFrame
      ? TURN_DETAIL_MIN_COLUMNS
      : costLogFrame
        ? COST_LOG_MIN_COLUMNS
        : CONTEXT_INSPECTOR_MIN_COLUMNS;
  const pageMinRows = requestFrame
    ? REQUEST_DETAIL_MIN_ROWS
    : turnFrame
      ? TURN_DETAIL_MIN_ROWS
      : costLogFrame
        ? COST_LOG_MIN_ROWS
        : CONTEXT_INSPECTOR_MIN_ROWS;
  const pageName = requestFrame
    ? "请求详情页"
    : turnFrame
      ? "回合详情页"
      : costLogFrame
        ? "费用日志页"
        : "上下文详情页";
  // 页面比终端还小的时候不渲染页面内容：一行说明足够，也避免行宽溢出打乱整帧。
  const tooSmall = Boolean(
    (inspectorFrame || costLogFrame || turnFrame || requestFrame) &&
      (width < pageMinColumns || height < pageMinRows),
  );

  return {
    inspector: inspectorFrame,
    request: requestFrame,
    turn: turnFrame,
    costLog: costLogFrame,
    tooSmall,
    pageName,
    rows: inspectorFrame?.rows ?? requestFrame?.rows ?? turnFrame?.rows ?? costLogFrame?.rows,
  };
}

/** 上下文详情页的命中区域：列表 + 顶栏「Esc 返回」。 */
export function inspectorHit(frame: ContextInspectorFrame, screenTop: number): OverlayHit {
  return {
    listTop: screenTop + frame.listTop,
    listHeight: frame.listHeight,
    listLeft: frame.listLeft + 1,
    listWidth: frame.listWidth,
    listOffset: frame.listOffset,
    backRow: screenTop + frame.back.row,
    backLeft: frame.back.left + 1,
    backWidth: frame.back.width,
  };
}

/** 费用日志列表页与回合详情页共用一张命中表结构：谁在画就用谁的几何。 */
export function costLogHit(frame: ListFrameGeometry, screenTop: number): OverlayHit {
  return {
    listTop: screenTop + frame.listTop,
    listHeight: frame.listHeight,
    listLeft: frame.listLeft + 1,
    listWidth: frame.listWidth,
    listOffset: frame.listOffset,
    itemHeight: frame.itemHeight,
    backRow: screenTop + frame.back.row,
    backLeft: frame.back.left + 1,
    backWidth: frame.back.width,
  };
}

/** 请求详情页没有列表：只登记返回按钮，列表区域留空（点击一律落到空）。 */
export function requestDetailHit(frame: RequestDetailFrame, screenTop: number): OverlayHit {
  return {
    listTop: 0,
    listHeight: 0,
    listLeft: 0,
    listWidth: 0,
    listOffset: 0,
    itemHeight: 1,
    backRow: screenTop + frame.back.row,
    backLeft: frame.back.left + 1,
    backWidth: frame.back.width,
  };
}
