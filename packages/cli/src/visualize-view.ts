import {
  type MermaidArt,
  mermaidSourceBox,
  parseVisualizeParams,
  renderMermaidArt,
  type Span,
} from "@hajicli/plugins";
import { colors } from "./theme.js";

/**
 * `visualize` 工具在终端里的展示：把字符画的语义角色映射到当前主题配色，
 * 并决定「画图」还是「退回源码」。
 *
 * 两条硬规则：
 * - **放不下就退回源码**，绝不折行——字符画一折行就散了，宁可不画；
 * - 引擎不认识的图族、或有语句被丢掉（画出来是残缺的图）同样退回源码。
 *
 * 配色只上语义角色（边框/文字/连线/连线标签/标题），跟 `formatToolCell` 的口径一致：
 * 颜色留给结构与状态，正文保持中性。
 */
const ROLE_PAINT: Record<Span["role"], (text: string) => string> = {
  border: colors.gray,
  text: colors.text,
  edge: colors.accent,
  edgeLabel: colors.faint,
  title: colors.boldAccent,
  none: (text) => text,
};

function paintArt(art: MermaidArt): string[] {
  return art.styled.map((row) => row.map((span) => ROLE_PAINT[span.role](span.text)).join(""));
}

/** mermaid 源码的首行（`flowchart LR`、`sequenceDiagram`…），用作标题与结果说明。 */
function sourceKind(source: string | undefined): string {
  const first = (source ?? "").trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first || "图表";
}

/** 工具块头行的主语：标题优先，其次按 type 归纳。 */
export function visualizeTitle(args: Record<string, unknown>): string {
  const params = parseVisualizeParams(args);
  if (params.title) return params.title;
  if (params.type === "comparison") return `对比 ${params.options.length} 个选项`;
  if (params.type === "file") {
    if (!params.path) return "文件";
    return params.before ? `${params.before} → ${params.path}` : params.path;
  }
  return sourceKind(params.mermaid);
}

export interface VisualizePreview {
  /** `└` 后面的结果说明。 */
  text: string;
  /** 结果说明下面的预览行（已着色，按可用宽度决定是图还是源码）。 */
  preview?: string[];
}

/**
 * 构造工具块的结果展示。`width` 是预览行实际可用的列宽（已扣掉缩进与边框）。
 *
 * 参数可能来自流式残缺的调用：拿不到必要字段时返回 `undefined`，由调用方走通用兜底。
 */
export function visualizePreview(
  args: Record<string, unknown>,
  width: number,
): VisualizePreview | undefined {
  const params = parseVisualizeParams(args);
  const budget = Math.max(8, width);

  if (params.type === "diagram") {
    const source = params.mermaid ?? "";
    if (source.trim() === "") return undefined;
    const kind = sourceKind(source);
    const art = renderMermaidArt(source);
    if (art && art.warnings.length === 0 && art.width <= budget) {
      return { text: `${kind} · ${art.width} 列`, preview: paintArt(art) };
    }
    // 太窄时连源码框都塞不下（框会被截成碎片），只留一行说明，源码在展开的输出里。
    if (budget < 24) return { text: `${kind} · 显示源码` };
    return { text: `${kind} · 显示源码`, preview: paintArt(mermaidSourceBox(source, budget)) };
  }

  if (params.type === "comparison") {
    if (params.options.length === 0) return undefined;
    const preview = params.options.map(
      (option, index) => `${index + 1}. ${option.name}${option.recommended ? " ✅ 推荐" : ""}`,
    );
    return { text: `对比 ${params.options.length} 个选项`, preview };
  }

  if (!params.path) return undefined;
  return { text: params.before ? "前后对比" : "已展示" };
}
