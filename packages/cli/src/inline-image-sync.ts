import {
  clipInlinePlacement,
  diffInlinePlacements,
  encodeKittyImageDispose,
  encodeKittyPlacement,
  encodeKittyPlacementDelete,
  encodeKittyUpload,
  type ImageProtocol,
  type InlineImageDescription,
  type InlinePlacementSpec,
} from "./terminal-image.js";
import { SEQ, truncateAnsiText } from "./terminal-text.js";
import { themeEnter } from "./theme.js";

/**
 * 全屏查看图片时的视图：序列已由 terminal-image.ts 编码好，
 * 这里只描述摆放尺寸与说明文字。
 */
export interface ImageOverlayView {
  protocol: ImageProtocol;
  sequence: string;
  cols: number;
  rows: number;
  caption: string;
  tmux: boolean;
}

/**
 * 内联图段的运行态：数据只上传一次，placement 随帧同步。
 * uploaded/placed 挂在段上而不是全局表——段被丢弃（预算回收 / 清屏）时一起消失。
 */
export interface InlineImageSegmentState {
  desc: InlineImageDescription;
  /** kitty image id（终端侧数据键）；placementId 固定 1，每图一个 placement。 */
  kittyId: number;
  uploaded: boolean;
  /** 当前已在屏幕上的 placement（1 基屏幕坐标）；undefined = 未放置。 */
  placed?: InlinePlacementSpec;
  /** 当前宽度下的折算结果（缓存，宽度变化时由 cacheKey 失效重算）。 */
  fitted?: { cols: number; rows: number };
}

/** 同步层只需要段的 id 与内联图状态，不关心段内容。 */
export interface InlineImageSegmentRef {
  id: number;
  image?: InlineImageSegmentState;
}

/** 本帧对话区的可见范围（行号均为该帧内的逻辑行）。 */
export interface InlineImageFrame {
  visibleStart: number;
  visibleEnd: number;
  chatRegionStart: number;
  chatPadding: number;
  suppressed: boolean;
}

/** 已封口段在对话文档里的行区间（render 时重建）。 */
export interface InlineImageRowEntry {
  id: number;
  start: number;
}

/**
 * 内联图段：placementId 固定为 1
 * （每张图只维护一个 placement，移动靠同 (image id, placement id) 重放替换）。
 */
const INLINE_PLACEMENT_ID = 1;
/**
 * 滚动微调节流间隔：滚过图片时每行都会产生新的行位/裁剪，逐帧重放 a=p 会让
 * 终端反复重缩放位图（快速滚动时明显卡顿）。限频后滚动期间终端自行让图跟随
 * 文本滚动，收尾帧把最终位置精确对齐；上传 / 删除 / 首次放置不受节流影响。
 */
const INLINE_IMAGE_SCROLL_NUDGE_MS = 80;

/** 宿主提供的两个副作用：安排下一帧、向终端写入。 */
export interface InlineImageSyncHost {
  scheduleRender: (interactive?: boolean) => void;
  write: (text: string) => void;
}

/**
 * 内联图 placement 同步层：把「终端上已有的 placement」对齐到「本帧应有的位置」。
 *
 * 状态只有三项（上次放置时刻、是否有被节流的微调未落地、收尾定时器），
 * 全部从 TerminalUI 搬到这里，避免渲染主类同时持有帧缓存与图片节流状态。
 */
export class InlineImageSync {
  /** 上次对已放置的内联图发出 a=p 的时刻（滚动微调节流用）。 */
  private lastPlaceAt = 0;
  /** 有被节流抑制的滚动微调还没落地：帧渲染的提前返回要给它让路。 */
  private nudgePending = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: InlineImageSyncHost) {}

  /** 是否有被节流抑制的 placement 微调还没落地。 */
  get pendingNudge(): boolean {
    return this.nudgePending;
  }

  /** 屏幕重置后：所有内联图回到「未放置、未上传」，下一次渲染强制重传重贴。 */
  resetScreen(segments: readonly InlineImageSegmentRef[]): void {
    for (const segment of segments) {
      if (!segment.image) continue;
      segment.image.placed = undefined;
      segment.image.uploaded = false;
    }
  }

  /** 段列表即将整体丢弃：释放其中内联图占用的终端图形配额。 */
  dispose(segments: readonly InlineImageSegmentRef[]): void {
    for (const segment of segments) {
      const state = segment.image;
      if (state?.desc.protocol !== "kitty" || !state?.desc.png) continue;
      this.host.write(encodeKittyImageDispose(state.kittyId, state.desc.tmux));
    }
  }

  /**
   * 帧渲染末尾把每张可见内联图的 kitty placement 对齐到「本帧应有的屏幕位置」。
   * 位置未变 → 零输出；移动/改尺寸 → 同 (image id, placement id) 重放，协议保证
   * 原地替换、无闪烁；部分可见 → 用源矩形（x/y/w/h）只贴可见的那段，滚动时图片
   * 随文本渐进出入视口；完全滚出 → 只删 placement 保留数据，滚回来时一条 a=p 即恢复。
   */
  sync(
    frame: InlineImageFrame,
    segments: readonly InlineImageSegmentRef[],
    rowIndex: readonly InlineImageRowEntry[],
  ): string {
    if (segments.length === 0) return "";
    let output = "";
    let throttled = false;
    const now = Date.now();
    for (const segment of segments) {
      const state = segment.image;
      if (state?.desc.protocol !== "kitty" || !state?.desc.png) continue;
      const imageRows = state.fitted?.rows ?? 0;
      let desired: InlinePlacementSpec | undefined;
      if (!frame.suppressed && imageRows > 0 && state.fitted) {
        const entry = rowIndex.find((item) => item.id === segment.id);
        if (entry) {
          const clipped = clipInlinePlacement(
            {
              start: entry.start,
              rows: imageRows,
              widthPx: state.desc.widthPx,
              heightPx: state.desc.heightPx,
            },
            frame,
          );
          if (clipped) {
            // 裁掉顶部若干行后，首个可见行就是图片矩形的新顶行。
            desired = {
              row:
                frame.chatRegionStart +
                1 +
                (entry.start + clipped.clippedRows - frame.visibleStart),
              col: frame.chatPadding + 1,
              cols: state.fitted.cols,
              rows: clipped.visibleRows,
              src: clipped.src,
            };
          }
        }
      }
      const verdict = diffInlinePlacements(state.placed, desired, state.uploaded);
      if (verdict.action === "none") continue;
      if (verdict.action === "delete") {
        output += encodeKittyPlacementDelete({
          id: state.kittyId,
          placementId: INLINE_PLACEMENT_ID,
          tmux: state.desc.tmux,
        });
        state.placed = undefined;
        continue;
      }
      if (verdict.plan.upload) {
        output += encodeKittyUpload(state.desc.png, { id: state.kittyId, tmux: state.desc.tmux });
        state.uploaded = true;
      }
      // 已在屏上的图滚动引发的行移/裁剪微调：节流限频。抑制时不更新状态，
      // 收尾定时器保证滚动停下后必有一帧把 placement 对齐到精确位置。
      if (
        !verdict.plan.upload &&
        state.placed !== undefined &&
        now - this.lastPlaceAt < INLINE_IMAGE_SCROLL_NUDGE_MS
      ) {
        throttled = true;
        this.scheduleSettle(INLINE_IMAGE_SCROLL_NUDGE_MS - (now - this.lastPlaceAt));
        continue;
      }
      // a=p 放在光标处：先定位到图片矩形顶行左列再放置；帧尾的 cursorState 会再定位光标。
      output += `\x1b[${verdict.plan.place.row};${verdict.plan.place.col}H`;
      output += encodeKittyPlacement({
        id: state.kittyId,
        placementId: INLINE_PLACEMENT_ID,
        cols: verdict.plan.place.cols,
        rows: verdict.plan.place.rows,
        src: verdict.plan.place.src,
        tmux: state.desc.tmux,
      });
      state.placed = verdict.plan.place;
      this.lastPlaceAt = now;
    }
    this.nudgePending = throttled;
    return output;
  }

  /** 滚动停下后补一帧，把被节流的图片微调落到精确位置。 */
  private scheduleSettle(delayMs: number): void {
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(
      () => {
        this.settleTimer = null;
        this.host.scheduleRender(true);
      },
      Math.max(0, delayMs),
    );
  }
}

/**
 * 图片查看整屏一次性绘制，绕开逐行 diff：清屏 → 贴图 → 图下一行说明。
 * 贴完图后调用方要把旧帧标记失效，返回对话区时走 fullRefresh 整体重画，
 * 避免残留图片或半截文字。
 */
export function renderImageOverlayFrame(
  overlay: ImageOverlayView,
  columns: number,
  rows: number,
): string {
  const width = Math.max(1, columns || 80);
  const height = Math.max(1, rows || 24);
  const captionRow = Math.min(height, overlay.rows + 1);
  const caption = truncateAnsiText(`${overlay.caption}  ·  任意键返回`, width);
  return (
    "\x1b[?2026h\x1b[?25l" +
    themeEnter() +
    "\x1b[2J\x1b[H" +
    overlay.sequence +
    `\x1b[${captionRow};1H${SEQ.muted}${caption}${SEQ.reset}` +
    "\x1b[?2026l"
  );
}
