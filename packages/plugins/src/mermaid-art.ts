import { diagramKind, type MermaidArt, render, sourceBox } from "lovely-mermaid";

/**
 * Mermaid 的终端字符画渲染（移植自 ThinkRail `pi-extensions/visualize` 的 probe/tui 两半）。
 *
 * 这里只做「能不能画、画出来是什么」，不掺 ANSI 上色：语义角色（边框 / 文字 / 连线 /
 * 连线标签 / 标题）原样交给上层，由 cli 的 theme 决定颜色。这样同一份渲染结果既能给
 * 工具块预览用，也能给 Markdown 围栏用，而配色始终跟当前主题走。
 */

/** 开头的空行与 `%%` 注释：既不参与「首行是什么」的判断，也不影响渲染。 */
const LEADING_COMMENTS = /^(?:[ \t]*(?:%%[^\n]*)?\r?\n)+/;
/** frontmatter（`---` 包裹的元信息）同样跳过。 */
const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/;
const FLOWCHART_DIRECTION = /^(?:flowchart|graph)\s+([^\s;]+)/i;
const DIRECTIONS = /^(?:TB|TD|BT|RL|LR|[<>^])$/i;
/** 超出引擎规模上限时的截断警告：图是完整的、只是画了一部分，不算「读不懂」。 */
const TRUNCATED = /^diagram truncated\b/;

/** 渲染结果缓存上限：流式参数每帧都会问同一份源码，重复解析的代价肉眼可见。 */
const CACHE_LIMIT = 32;
const artCache = new Map<string, MermaidArt | null>();

export type { MermaidArt, Span } from "lovely-mermaid";

function stripLeading(source: string): string {
  return source.replace(LEADING_COMMENTS, "");
}

/** 去掉注释与 frontmatter 后的首行，用于判断 flowchart 方向这类头部语法。 */
function headerLine(source: string): string {
  const body = source
    .replace(LEADING_COMMENTS, "")
    .replace(FRONTMATTER, "")
    .replace(LEADING_COMMENTS, "");
  return body.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/**
 * 渲染成字符画。`null` 表示画不出来：空源码、引擎不认识的图族（gantt、xychart 等）、
 * 或者一句都解析不出来的源码。图比终端宽不在这里判断——那是调用方按宽度决定的事。
 */
export function renderMermaidArt(source: string): MermaidArt | null {
  const key = stripLeading(source);
  const cached = artCache.get(key);
  if (cached !== undefined) {
    // Map 保持插入顺序：删除后重插即为 LRU 触碰。
    artCache.delete(key);
    artCache.set(key, cached);
    return cached;
  }
  let art: MermaidArt | null = null;
  try {
    art = render(key);
  } catch {
    // 引擎内部异常一律当作「画不出来」，绝不让它冒到渲染路径上。
    art = null;
  }
  if (artCache.size >= CACHE_LIMIT) {
    const oldest = artCache.keys().next().value;
    if (oldest !== undefined) artCache.delete(oldest);
  }
  artCache.set(key, art);
  return art;
}

/** 画不出来时的兜底：把源码装进带标题的框里，按宽度硬折行，永远读得完。 */
export function mermaidSourceBox(source: string, maxWidth: number): MermaidArt {
  return sourceBox(stripLeading(source), Math.max(12, maxWidth));
}

export function clearMermaidArtCache(): void {
  artCache.clear();
}

/**
 * 校验 mermaid 源码：能在终端画出来的图族里，方向写错、一句都读不懂、或有语句被丢掉
 * 都算错——它们画出来是残缺的图，不如让模型改对再来。
 *
 * 引擎不认识的图族（gantt、xychart……）放行：它们退回源码显示，信息不丢。
 */
export function probeMermaid(source: string): void {
  const kind = diagramKind(source);
  if (kind === null) return;
  const direction = FLOWCHART_DIRECTION.exec(headerLine(source))?.[1];
  if (kind === "flowchart" && direction !== undefined && !DIRECTIONS.test(direction)) {
    throw new Error(`未知的 flowchart 方向 "${direction}" —— 请使用 TB、TD、BT、RL 或 LR。`);
  }
  const art = renderMermaidArt(source);
  if (art === null) {
    throw new Error(`这张 ${kind} 图里没有一句能读懂的语句。`);
  }
  const dropped = art.warnings.filter((warning) => !TRUNCATED.test(warning));
  if (dropped.length > 0) {
    throw new Error(`图里有部分内容读不懂 —— ${dropped.join("；")}。`);
  }
}
