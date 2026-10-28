import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";
import { fetchWithNetworkPolicy } from "./network.js";

/** 整体输出预算（含首行信封），与其余工具一致。 */
const MAX_OUTPUT_CHARS = 8_000;
/** 短于此长度的页面不做 focus 裁剪，避免把上下文切碎。 */
const FOCUS_MIN_CHARS = 7_000;
/** focus 命中的章节最多保留几段（再多就交给长度预算裁剪）。 */
const MAX_FOCUS_SECTIONS = 4;
/** 占位符：pre / table 先抽出来，正文流里只留标记，避免内部空白被折叠。 */
const BLOCK_PLACEHOLDER = /\u0000BLOCK(\d+)\u0000/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  bull: "•",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  check: "✓",
  cross: "✗",
  star: "★",
};

/** HTML 实体解码（数值 + 常见命名实体；未知实体原样保留）。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, entity: string) => {
      const key = entity.toLowerCase();
      if (key.startsWith("#")) {
        const code = key.startsWith("#x")
          ? Number.parseInt(key.slice(2), 16)
          : Number.parseInt(key.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[key] ?? whole;
    })
    .replace(/\u00a0/g, " ");
}

/** 读取标签属性（单/双引号与无引号三种写法）。 */
function attribute(raw: string, name: string): string {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(raw);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

/** 相对链接按页面地址补全；javascript: / 空锚点直接丢弃。 */
function resolveHref(href: string, baseUrl?: string): string {
  const value = href.trim();
  if (!value || value === "#" || /^javascript:/i.test(value)) return "";
  if (!baseUrl) return value;
  try {
    const resolved = new URL(value, baseUrl);
    return /^https?:$/.test(resolved.protocol) ? resolved.href : value;
  } catch {
    return value;
  }
}

/** 去掉脚本、样式、导航、页脚等噪声容器；这些块对正文没有信息量。 */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|head|noscript|template|svg|canvas|iframe|nav|footer|aside|form|button|select|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(/<(?:link|meta|base|input)\b[^>]*>/gi, "");
}

/** 正文容器的可见文本量，用于在 article / main 之间取舍。 */
function visibleWeight(html: string): number {
  return html.replace(/<[^>]*>/g, "").length;
}

/**
 * 选择正文容器：优先 `main`，但单篇文章占据主体时改用 `article`（卡片流页面仍用 main）。
 * 两者都没有就返回 undefined，由调用方回退整页。
 */
function pickContentRoot(html: string): string | undefined {
  const articles = [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article\s*>/gi)].map(
    (match) => match[0],
  );
  const main = /<main\b[^>]*>[\s\S]*?<\/main\s*>/i.exec(html)?.[0];
  const article = articles.sort((a, b) => visibleWeight(b) - visibleWeight(a))[0];
  if (main) {
    if (!article) return main;
    return visibleWeight(article) >= visibleWeight(main) * 0.5 ? article : main;
  }
  if (article && visibleWeight(article) >= 400) return article;
  return undefined;
}

/** `<pre>` → 围栏代码块，内部空白与缩进必须原样保留。 */
function extractPreBlocks(html: string, blocks: string[]): string {
  return html.replace(
    /<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi,
    (whole: string, _attrs: string, body: string) => {
      const language =
        /(?:language-|lang-|highlight-source-)([\w+#.-]+)/i.exec(whole)?.[1]?.toLowerCase() ?? "";
      const code = decodeEntities(body.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .replace(/^\n+/, "")
        .replace(/\n+$/, "");
      if (!code.trim()) return "\n\n";
      blocks.push(`\`\`\`${language}\n${code}\n\`\`\``);
      return `\n\n\u0000BLOCK${blocks.length - 1}\u0000\n\n`;
    },
  );
}

/** 单元格取纯文本；`|` 必须转义，否则整行表格会被拆坏。 */
function tableCell(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

function tableToMarkdown(table: string): string {
  const rows: string[][] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
      cells.push(tableCell(cell[2]));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [
    line(rows[0]),
    line(Array.from({ length: width }, () => "---")),
    ...rows.slice(1).map(line),
  ].join("\n");
}

/** `<table>` → 管道表；没有 thead 时把第一行当表头（Markdown 表格必须有分隔行）。 */
function extractTables(html: string, blocks: string[]): string {
  return html.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (table: string) => {
    const markdown = tableToMarkdown(table);
    if (!markdown) return "";
    blocks.push(markdown);
    return `\n\n\u0000BLOCK${blocks.length - 1}\u0000\n\n`;
  });
}

type HtmlToken =
  | { kind: "text"; text: string }
  | { kind: "tag"; name: string; closing: boolean; raw: string };

/** 逐标签扫描：比一次性正则替换更能处理嵌套（列表、引用）。 */
function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt < 0) {
      tokens.push({ kind: "text", text: html.slice(index) });
      break;
    }
    if (lt > index) tokens.push({ kind: "text", text: html.slice(index, lt) });
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      tokens.push({ kind: "text", text: html.slice(lt + 9, end < 0 ? html.length : end) });
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt + 2);
      index = end < 0 ? html.length : end + 1;
      continue;
    }
    if (!/[a-zA-Z/]/.test(next)) {
      // 裸 `<`（例如 "a < b"）按文本处理
      tokens.push({ kind: "text", text: "<" });
      index = lt + 1;
      continue;
    }
    let cursor = lt + 1;
    let quote = "";
    while (cursor < html.length) {
      const char = html[cursor];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      cursor += 1;
    }
    const raw = html.slice(lt, Math.min(cursor + 1, html.length));
    index = cursor + 1;
    const match = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)/.exec(raw);
    if (!match) continue;
    tokens.push({ kind: "tag", name: match[2].toLowerCase(), closing: match[1] === "/", raw });
  }
  return tokens;
}

/** 判断行内缓冲里是否有真正的文字（只有 Markdown 记号/零宽字符不算）。 */
function hasVisibleText(text: string): boolean {
  return text.replace(/[*`~>#|[\]()\s\u200b-\u200d\ufeff]/g, "").length > 0;
}

/** 根据 role / id / class 识别导航、侧栏、目录这类噪声容器。 */
const NOISE_CONTAINER_ROLE =
  /role\s*=\s*["']?(?:navigation|banner|contentinfo|search|complementary)["'\s>]/i;
const NOISE_CONTAINER_ID_LOOSE =
  /(?:^|[-_])(?:nav|navigation|sidebar|toc|breadcrumb|menu)(?:[-_]|$)/i;
const NOISE_CONTAINER_TOKENS = new Set([
  "nav",
  "navbar",
  "navigation",
  "sidebar",
  "toc",
  "table-of-contents",
  "breadcrumb",
  "breadcrumbs",
  "menu",
  // 可访问性工具类：屏幕阅读器专用文案与「跳到正文」链接，正文里只会是噪声
  "skip-to-content",
  "skip-link",
  "sr-only",
  "visually-hidden",
  "screen-reader-text",
]);

/** 判断一个开始标签是不是「整块都该跳过」的导航容器。 */
function isNoiseContainer(raw: string): boolean {
  if (NOISE_CONTAINER_ROLE.test(raw)) return true;
  const id = attribute(raw, "id").trim();
  if (id && (NOISE_CONTAINER_TOKENS.has(id.toLowerCase()) || NOISE_CONTAINER_ID_LOOSE.test(id)))
    return true;
  const classes = attribute(raw, "class").toLowerCase().split(/\s+/);
  return classes.some((token) => NOISE_CONTAINER_TOKENS.has(token));
}

interface OpenList {
  ordered: boolean;
  start: number;
  items: string[];
  current: string;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** 自成段落的块级标签：开关都必须断开当前行内缓冲。 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "header",
  "hgroup",
  "main",
  "p",
  "section",
  "summary",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
]);

/** 生成 Markdown 的流式渲染器：维护行内缓冲 + 块缓冲 + 列表栈。 */
class MarkdownStream {
  private readonly parts: string[] = [];
  private inline = "";
  private readonly lists: OpenList[] = [];
  private readonly quoteStarts: number[] = [];
  private readonly marks: Array<{ kind: string; start: number }> = [];
  private readonly links: Array<{ href: string; start: number }> = [];
  /** 正在跳过的噪声容器（导航/侧栏），按同名标签配平。 */
  private skip?: { name: string; depth: number };

  constructor(
    private readonly blocks: string[],
    private readonly baseUrl?: string,
  ) {}

  public render(html: string): void {
    for (const token of tokenizeHtml(html)) {
      if (token.kind === "text") {
        if (!this.skip) this.appendText(token.text);
        continue;
      }
      if (this.skip) {
        this.trackSkip(token.name, token.closing);
        continue;
      }
      if (!token.closing && !VOID_TAGS.has(token.name) && isNoiseContainer(token.raw)) {
        this.skip = { name: token.name, depth: 1 };
        continue;
      }
      if (!token.closing && VOID_TAGS.has(token.name)) {
        this.voidTag(token.name, token.raw);
        continue;
      }
      this.tag(token.name, token.closing, token.raw);
    }
    this.flushInline();
  }

  private trackSkip(name: string, closing: boolean): void {
    if (!this.skip || this.skip.name !== name) return;
    if (closing) this.skip.depth -= 1;
    else this.skip.depth += 1;
    if (this.skip.depth <= 0) this.skip = undefined;
  }

  public finish(): string {
    return this.parts.join("\n\n");
  }

  private voidTag(name: string, raw: string): void {
    if (name === "br") {
      this.inline += "\n";
      return;
    }
    if (name === "hr") {
      this.block("---");
      return;
    }
    if (name === "img") this.image(raw);
  }

  private tag(name: string, closing: boolean, raw: string): void {
    switch (name) {
      case "br":
      case "hr":
      case "img":
        if (!closing) this.voidTag(name, raw);
        return;
      case "a":
        this.anchor(closing, raw);
        return;
      case "strong":
      case "b":
        this.mark("strong", closing, "**");
        return;
      case "em":
      case "i":
        this.mark("em", closing, "*");
        return;
      case "del":
      case "s":
        this.mark("del", closing, "~~");
        return;
      case "code":
        this.mark("code", closing, "`");
        return;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        this.heading(Number(name[1]), closing);
        return;
      case "li":
        this.listItem(closing);
        return;
      case "ul":
        this.listOpen(false, raw, closing);
        return;
      case "ol":
        this.listOpen(true, raw, closing);
        return;
      case "blockquote":
        this.blockquote(closing);
        return;
      default:
        if (BLOCK_TAGS.has(name)) this.blockBoundary();
    }
  }

  private appendText(raw: string): void {
    const text = decodeEntities(raw);
    if (!text) return;
    let last = 0;
    for (const match of text.matchAll(BLOCK_PLACEHOLDER)) {
      const index = match.index ?? 0;
      this.appendInline(text.slice(last, index));
      const block = this.blocks[Number(match[1])];
      if (block) this.block(block);
      last = index + match[0].length;
    }
    this.appendInline(text.slice(last));
  }

  private appendInline(raw: string): void {
    if (!raw) return;
    // 零宽字符（VitePress/Docusaurus 的标题锚点常用）会让链接文字看起来非空
    let text = raw.replace(/\s+/g, " ").replace(/[\u200b-\u200d\ufeff\u00ad]/g, "");
    if (!text) return;
    if (this.inline === "" || this.inline.endsWith("\n") || this.inline.endsWith(" ")) {
      text = text.replace(/^ /, "");
    }
    if (text) this.inline += text;
  }

  private blockBoundary(): void {
    this.flushInline();
  }

  private flushInline(): void {
    const text = this.inline;
    this.inline = "";
    if (hasVisibleText(text)) this.sink(text);
  }

  /** 追加一个完整块（不触发 flushInline，避免递归）。 */
  private sink(text: string): void {
    const value = text.trim();
    if (!value) return;
    const list = this.lists[this.lists.length - 1];
    if (list) {
      list.current = list.current.trim() ? `${list.current.trim()}\n\n${value}` : value;
      return;
    }
    this.parts.push(value);
  }

  private block(text: string): void {
    this.flushInline();
    this.sink(text);
  }

  private heading(level: number, closing: boolean): void {
    if (!closing) {
      this.flushInline();
      return;
    }
    const text = this.inline.replace(/\s+/g, " ").trim();
    this.inline = "";
    if (!hasVisibleText(text)) return;
    this.sink(`${"#".repeat(level)} ${text}`);
  }

  private mark(kind: string, closing: boolean, marker: string): void {
    if (!closing) {
      this.marks.push({ kind, start: this.inline.length });
      this.inline += marker;
      return;
    }
    for (let index = this.marks.length - 1; index >= 0; index -= 1) {
      if (this.marks[index].kind !== kind) continue;
      const [opened] = this.marks.splice(index, 1);
      // 畸形的未闭合标记一并丢弃，文本保留
      this.marks.length = Math.min(this.marks.length, index);
      const content = this.inline.slice(opened.start + marker.length);
      const empty = kind === "code" ? !content.trim() : !hasVisibleText(content);
      if (empty) {
        this.inline = this.inline.slice(0, opened.start);
        return;
      }
      this.inline += marker;
      return;
    }
  }

  private anchor(closing: boolean, raw: string): void {
    if (closing) {
      const link = this.links.pop();
      if (!link) return;
      const label = this.inline.slice(link.start);
      if (!hasVisibleText(label)) {
        // 纯锚点文字（标题后的 “#” 链接、零宽占位）直接丢掉，不留残渣
        this.inline = this.inline.slice(0, link.start);
        return;
      }
      if (!link.href) {
        this.inline = this.inline.slice(0, link.start) + label;
        return;
      }
      this.inline = `${this.inline.slice(0, link.start)}[${label.trim()}](${link.href})`;
      return;
    }
    this.links.push({
      href: resolveHref(attribute(raw, "href"), this.baseUrl),
      start: this.inline.length,
    });
  }

  private image(raw: string): void {
    const alt = attribute(raw, "alt").replace(/[[\]]/g, " ").trim();
    if (!alt) return;
    const src = attribute(raw, "src");
    // 徽章、图标、超长 camo 代理地址对模型没有信息量，只保留正文配图
    if (!src || src.length > 200 || /^data:/i.test(src)) return;
    if (/\.(?:svg|ico)(?:[?#]|$)/i.test(src)) return;
    if (/(?:badge|shields\.io|logo|icon)/i.test(src)) return;
    const href = resolveHref(src, this.baseUrl);
    if (href) this.inline += `![${alt}](${href})`;
  }

  private listOpen(ordered: boolean, raw: string, closing: boolean): void {
    if (!closing) {
      this.flushInline();
      const parsed = Number.parseInt(/(?:^|\s)start\s*=\s*["']?(\d+)/i.exec(raw)?.[1] ?? "1", 10);
      this.lists.push({
        ordered,
        start: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
        items: [],
        current: "",
      });
      return;
    }
    this.flushInline();
    const list = this.lists.pop();
    if (!list) return;
    if (list.current.trim()) list.items.push(list.current);
    list.current = "";
    const items = list.items.map((item) => item.trim()).filter(Boolean);
    // 40 条以上、几乎全是「单个链接」的列表是站点索引/巨型菜单（例如 nodejs.org 的
    // 文档目录），不是正文；页面内目录通常只有几条，不受影响。
    const bareLinks = items.filter((item) => /^\[[^\]]+\]\([^)]+\)$/.test(item)).length;
    if (items.length >= 40 && bareLinks >= items.length * 0.8) return;
    const lines: string[] = [];
    let index = list.start;
    for (const item of items) {
      const marker = list.ordered ? `${index}. ` : "- ";
      index += 1;
      const [first, ...rest] = item.split("\n");
      lines.push(`${marker}${first.trim()}`);
      const pad = " ".repeat(marker.length);
      for (const line of rest) lines.push(line.trim() ? `${pad}${line}` : "");
    }
    if (lines.length) this.sink(lines.join("\n"));
  }

  private listItem(closing: boolean): void {
    const list = this.lists[this.lists.length - 1];
    if (!list) {
      if (closing) this.flushInline();
      return;
    }
    if (closing) {
      this.flushInline();
      return;
    }
    if (list.current.trim()) list.items.push(list.current);
    list.current = "";
  }

  private blockquote(closing: boolean): void {
    if (!closing) {
      this.flushInline();
      this.quoteStarts.push(this.parts.length);
      return;
    }
    this.flushInline();
    const start = this.quoteStarts.pop();
    if (start === undefined || start > this.parts.length) return;
    const content = this.parts.splice(start).join("\n\n");
    if (!content.trim()) return;
    this.parts.push(
      content
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n"),
    );
  }
}

/** 语法高亮角标（围栏前单独一行 `js`）与代码块语言重复，去掉这一行。 */
function dropFenceLabels(lines: string[]): string[] {
  const output: string[] = [];
  for (const line of lines) {
    const fence = /^```([\w+#.-]*)\s*$/.exec(line);
    if (fence?.[1]) {
      const previous = output[output.length - 1]?.trim().toLowerCase();
      if (previous === fence[1].toLowerCase()) output.pop();
    }
    output.push(line);
  }
  return output;
}

/** 归一化空白：代码块内部原样保留，其余折叠多余空格与空行。 */
function normalizeMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let inFence = false;
  let blank = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      output.push(line.trimEnd());
      blank = 0;
      continue;
    }
    if (inFence) {
      output.push(line);
      continue;
    }
    // 缩进（嵌套列表）必须保留，只折叠缩进之后的连续空白
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const body = line
      .slice(indent.length)
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]+$/, "");
    if (!body) {
      blank += 1;
      if (blank > 1) continue;
      output.push("");
      continue;
    }
    blank = 0;
    output.push(indent + body);
  }
  return dropFenceLabels(output).join("\n").trim();
}

/**
 * HTML → Markdown（零依赖）。
 *
 * 块级映射：h1-h6 → `#`、ul/ol → 列表（保留嵌套缩进）、pre → 围栏代码块（内部空白不清洗）、
 * table → 管道表、blockquote → `>`；行内映射：a → 链接、strong/em/del/code、img。
 * `baseUrl` 用于把相对链接补全成绝对地址。
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  if (!html.trim()) return "";
  const blocks: string[] = [];
  let source = stripNoise(html);
  source = extractPreBlocks(source, blocks);
  source = extractTables(source, blocks);
  const root = pickContentRoot(source);
  if (root) source = root;
  const stream = new MarkdownStream(blocks, baseUrl);
  stream.render(source);
  return normalizeMarkdown(stream.finish());
}

/** 把 Markdown 拆成「标题 + 正文」小节，用于 focus 定位。 */
interface MarkdownSection {
  heading: string;
  raw: string;
}

function splitSections(markdown: string): MarkdownSection[] {
  const blocks = markdown.split(/\n{2,}/);
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | undefined;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed.split("\n")[0]);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[2].trim(), raw: trimmed };
      continue;
    }
    if (current) current.raw += `\n\n${trimmed}`;
  }
  if (current) sections.push(current);
  return sections;
}

/** 关键词归一化：大小写、连字符与行内标记都不参与比较。 */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[*`#>|]/g, " ")
    .replace(/\s+/g, " ");
}

/** 按字符窗口提取（无结构文本的兜底，保持原有语义）。 */
function selectFocusedWindows(text: string, focus: string): string {
  const needle = focus.trim().toLowerCase().replace(/-/g, " ");
  if (!needle) return text;
  const lower = text.toLowerCase().replace(/-/g, " ");
  const ranges: Array<[number, number]> = [[0, 600]];
  let offset = 0;
  for (let count = 0; count < 4; count += 1) {
    const index = lower.indexOf(needle, offset);
    if (index < 0) break;
    const start = Math.max(0, index - 500);
    const end = Math.min(text.length, index + needle.length + 1000);
    const previous = ranges[ranges.length - 1];
    if (start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
    offset = end;
  }
  if (offset === 0) return text;
  return `[已按关键词提取相关片段，省略处以 … 标记]\n${ranges
    .map(([start, end]) => text.slice(start, end))
    .join("\n…\n")}`;
}

/**
 * 长文按 `focus` 挑章节：优先「命中关键词的小节（标题 + 其正文）」，
 * 没有结构（无标题、无空行）或命中收益不足时退回字符窗口，保证短页面不受影响。
 */
export function selectFocusedWebText(text: string, focus?: string): string {
  const needle = focus?.trim();
  if (!needle || text.length <= FOCUS_MIN_CHARS) return text;
  const normalized = normalizeForMatch(needle);
  const sections = splitSections(text);
  const hits = normalized
    ? sections.filter((section) => normalizeForMatch(section.raw).includes(normalized))
    : [];
  if (!hits.length) return selectFocusedWindows(text, needle);
  // 页首 600 字符保留（定价页的型号清单常在这里），除非命中章节本来就在开头。
  const head = text.slice(0, 600).trim();
  const picked: string[] = text.indexOf(hits[0].raw) < 600 ? [] : [head];
  for (const section of hits.slice(0, MAX_FOCUS_SECTIONS)) picked.push(section.raw);
  const joined = picked.join("\n\n…\n\n");
  // 命中章节几乎等于全文时，窗口提取反而更省；但绝不能比原文更长。
  if (joined.length >= text.length) return selectFocusedWindows(text, needle);
  return `[已按关键词提取相关片段，省略处以 … 标记]\n${joined}`;
}

/** 标题名太长时截断，只用于「后续还有哪些小节」的提示。 */
function shortHeading(heading: string): string {
  const text = heading.replace(/[*`]/g, "").trim();
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/**
 * 按块裁剪到预算：不在句子/表格/代码块中间切，末尾提示还有哪些小节没输出。
 */
export function truncateWebMarkdown(markdown: string, limit: number): string {
  if (markdown.length <= limit) return markdown;
  const blocks = markdown.split(/\n{2,}/);
  let output = "";
  let index = 0;
  for (; index < blocks.length; index += 1) {
    const candidate = output ? `${output}\n\n${blocks[index]}` : blocks[index];
    if (candidate.length > limit) break;
    output = candidate;
  }
  if (!output) {
    // 单个块就超预算（例如整页只有一个巨型表格）：按行裁剪，至少留下完整行。
    const sliced = markdown.slice(0, limit);
    const cut = sliced.lastIndexOf("\n");
    output = cut > limit / 2 ? sliced.slice(0, cut) : sliced;
  }
  // 末尾只剩一个孤零零的标题（正文放不下）：把标题一起退回，避免输出空标题。
  while (index > 0 && /^#{1,6}\s+/.test(blocks[index - 1].trim().split("\n")[0])) {
    index -= 1;
  }
  if (index > 0) output = blocks.slice(0, index).join("\n\n");
  const rest = blocks.slice(index);
  const headings = rest
    .map((block) => /^#{1,6}\s+(.+)$/.exec(block.trim().split("\n")[0])?.[1])
    .filter((heading): heading is string => Boolean(heading));
  const summary = headings.length
    ? `后面还有${headings
        .slice(0, 3)
        .map((heading) => `《${shortHeading(heading)}》`)
        .join("")}等 ${headings.length} 个小节`
    : `后面还有 ${rest.length} 段内容`;
  return `${output}\n\n[输出已截断：${summary}，可用 focus 参数定位]`;
}

/** 只有真正的 HTML 页面才走转换器；JSON / Markdown / 纯文本原样透传。 */
function shouldConvertToMarkdown(contentType: string | null, body: string): boolean {
  const type = (contentType ?? "").toLowerCase();
  if (type) return /html/.test(type);
  // 没有 content-type 时按内容判断，避免把原始 .md 当成正文清洗
  return (
    /^\s*(?:<!doctype html|<html|<head|<body)/i.test(body) || /<\/(?:p|div|li|table)>/i.test(body)
  );
}

/**
 * 网页抓取工具（类似 webfetch）。
 *
 * 抓取后把 HTML 转成 Markdown（标题/列表/代码块/表格都保留），而不是拍平成一行纯文本；
 * 超长内容按块裁剪并提示剩余小节。非 HTML 响应（.json/.md/.txt 等）原样返回。
 */
export class WebFetchTool implements BaseTool {
  public readonly name = "webfetch";

  constructor(private readonly fetchPage: typeof fetchWithNetworkPolicy = fetchWithNetworkPolicy) {}

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "webfetch",
      description:
        "抓取网页并转换为结构化 Markdown（保留标题、列表、代码块与表格；非 HTML 内容原样返回），适合阅读文档、README 与定价页。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: '要抓取内容的网页 URL（例如 "https://news.ycombinator.com"）。',
          },
          focus: {
            type: "string",
            description:
              "可选：优先保留包含该关键词的章节（按标题与段落挑选），适合长文档中的准确型号或条目。",
          },
        },
        required: ["url"],
      },
    },
  };

  /**
   * 执行网页内容抓取。
   */
  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) {
      return "错误: 缺少 url 参数。";
    }

    try {
      const response = await this.fetchPage(url, {
        signal: context?.abortSignal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        return `网页抓取失败: 状态码 ${response.status}`;
      }

      const contentType = response.headers.get("content-type");
      const body = await response.text();
      const envelope = `[网页抓取成功 - 目标地址: ${url}]\n\n`;
      let text = shouldConvertToMarkdown(contentType, body)
        ? htmlToMarkdown(body, url)
        : body.trim();
      if (!text) text = "（页面没有可提取的正文）";

      const focus = typeof args.focus === "string" ? args.focus : undefined;
      const focused = selectFocusedWebText(text, focus);
      // 信封占掉的字符也要算进预算，否则总长会超出其他工具同一口径。
      const limit = Math.max(2_000, MAX_OUTPUT_CHARS - envelope.length);
      return envelope + truncateWebMarkdown(focused, limit);
    } catch (error) {
      if (context?.abortSignal?.aborted) return "[网页抓取已中止]";
      return `网页抓取失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
