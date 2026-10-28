import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";
import { fetchWithNetworkPolicy } from "./network.js";

/** 官方 DeepSeek Search 端点根（含 /v1），与 chat 同一套 Bearer 鉴权。 */
const DEEPSEEK_SEARCH_BASE = "https://api.deepseek.com/v1";
const DEEPSEEK_SEARCH_TIMEOUT_MS = 12_000;
/** 单条摘要上限：官方 summary 实测 600～3800 字符，远超文档描述的 600～800，必须逐条封顶。 */
const DEEPSEEK_SUMMARY_LIMIT = 1_200;
/** 官方 count 参数：按请求计费，条数不影响单价，但会成倍放大上下文。 */
const DEEPSEEK_COUNT = 5;
const MAX_RESULTS = 8;
const MAX_OUTPUT_CHARS = 8_000;

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (whole, entity: string) => {
      const key = entity.toLowerCase();
      if (key.startsWith("#")) {
        const code = key.startsWith("#x")
          ? Number.parseInt(key.slice(2), 16)
          : Number(key.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return (
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[
          key
        ] ?? whole
      );
    },
  );
}

function cleanText(text: string): string {
  return decodeEntities(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string): string {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "";
}

function searchUrl(raw: string): string | undefined {
  try {
    let url = new URL(decodeEntities(raw), "https://lite.duckduckgo.com");
    if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
      const target = url.searchParams.get("uddg");
      if (!target) return undefined;
      url = new URL(target);
    }
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

interface SearchItem {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchResults(body: string, rss: boolean): SearchItem[] {
  const results: SearchItem[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string, title: string, snippet: string) => {
    const url = searchUrl(rawUrl);
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    results.push({ title, url, snippet });
  };
  if (rss) {
    for (const match of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
      const field = (name: string) =>
        match[1].match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? "";
      add(
        field("link")
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
          .trim(),
        cleanText(field("title")),
        cleanText(field("description")),
      );
    }
  } else {
    const anchors = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter((match) =>
      /(?:^|\s)result-link(?:\s|$)/.test(attribute(match[1], "class")),
    );
    for (let i = 0; i < anchors.length; i += 1) {
      const match = anchors[i];
      const section = body.slice(
        (match.index ?? 0) + match[0].length,
        anchors[i + 1]?.index ?? body.length,
      );
      const snippet =
        section.match(
          /<td\b[^>]*class\s*=\s*["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
        )?.[1] ?? "";
      add(attribute(match[1], "href"), cleanText(match[2]), cleanText(snippet));
    }
  }
  return results;
}

/** 三个来源共用同一份输出模板，`tool-output.ts` 按首行信封剥壳。 */
function formatSearchOutput(query: string, source: string, items: SearchItem[]): string {
  return (
    `[网络搜索结果 - 检索关键字 "${query}" - 来源 ${source}]\n\n` +
    items
      .slice(0, MAX_RESULTS)
      .map(
        (item, i) =>
          `### ${i + 1}. ${item.title}\n- **链接**: ${item.url}\n- **摘要**: ${item.snippet || "（无摘要，请抓取链接）"}`,
      )
      .join("\n\n")
  ).slice(0, MAX_OUTPUT_CHARS);
}

/** 仅展示错误码，底层 message 可能含带凭据的代理 URL。 */
function safeSearchError(error: unknown): string {
  const codes = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,60}$/.test(record.code))
      codes.add(record.code);
    visit(record.cause, depth + 1);
    if (Array.isArray(record.errors)) for (const child of record.errors) visit(child, depth + 1);
  };
  visit(error, 0);
  return codes.size ? `连接失败（${[...codes].join(", ")}）` : "连接或响应读取失败";
}

/** 服务端报错里回显 key 的防御性兜底：任何外泄路径都要抹掉。 */
function redactKey(text: string, key: string): string {
  return key ? text.split(key).join("<redacted>") : text;
}

export interface WebSearchSourceOptions {
  /** 官方 DeepSeek Search 的 key 解析器；返回空值时该来源整体跳过（零 key 行为不变）。 */
  deepseekApiKey?: () => string | undefined;
  /** 官方端点根地址（含 /v1），缺省 `https://api.deepseek.com/v1`。 */
  deepseekBaseUrl?: () => string | undefined;
}

/**
 * 网页搜索工具（类似 websearch）。
 *
 * 来源顺序：官方 DeepSeek Search（仅在解析到 key 时） → DuckDuckGo Lite → Bing RSS → Bing CN RSS。
 * 官方源任何一步失败（网络、非 2xx、空结果）都直接落回免费公开源，不重试、不阻塞其余来源。
 */
export class WebSearchTool implements BaseTool {
  public readonly name = "websearch";

  constructor(
    private readonly fetchPage: typeof fetchWithNetworkPolicy = fetchWithNetworkPolicy,
    private readonly options: WebSearchSourceOptions = {},
  ) {}

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "websearch",
      description: "在互联网上搜索指定关键字，并返回前 5-8 条搜索结果的标题、链接和正文摘要。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要在网络上搜索的关键字。",
          },
        },
        required: ["query"],
      },
    },
  };

  /**
   * 执行网络检索。
   */
  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return "错误: 缺少 query 参数。";

    const failures: string[] = [];
    const deepseekKey = this.options.deepseekApiKey?.()?.trim();
    if (deepseekKey) {
      const official = await this.searchDeepSeek(query, deepseekKey, context);
      if (official.text) return official.text;
      if (context?.abortSignal?.aborted) return "[网络搜索已中止]";
      failures.push(official.error ?? "DeepSeek Search: 无可用结果");
    }

    const encoded = encodeURIComponent(query);
    const engines = [
      {
        name: "DuckDuckGo Lite",
        url: `https://lite.duckduckgo.com/lite/?q=${encoded}`,
        rss: false,
      },
      { name: "Bing RSS", url: `https://www.bing.com/search?format=rss&q=${encoded}`, rss: true },
      { name: "Bing CN RSS", url: `https://cn.bing.com/search?format=rss&q=${encoded}`, rss: true },
    ];
    for (const engine of engines) {
      if (context?.abortSignal?.aborted) return "[网络搜索已中止]";
      const controller = new AbortController();
      const abort = () => controller.abort(context?.abortSignal?.reason);
      context?.abortSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await this.fetchPage(
          engine.url,
          {
            signal: controller.signal,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
              Accept: "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
            },
          },
          { timeoutMs: 12_000 },
        );
        if (!response.ok) {
          failures.push(`${engine.name}: HTTP ${response.status}`);
          await response.body?.cancel();
          continue;
        }
        const body = await response.text();
        if (context?.abortSignal?.aborted) return "[网络搜索已中止]";
        const results = parseSearchResults(body, engine.rss);
        if (!results.length) {
          failures.push(`${engine.name}: 无可用结果（可能受限或验证页）`);
          continue;
        }
        return formatSearchOutput(query, engine.name, results);
      } catch (error) {
        if (context?.abortSignal?.aborted) return "[网络搜索已中止]";
        failures.push(
          `${engine.name}: ${controller.signal.aborted ? "请求超时" : safeSearchError(error)}`,
        );
      } finally {
        clearTimeout(timer);
        context?.abortSignal?.removeEventListener("abort", abort);
      }
    }
    return `网络搜索失败: ${failures.join("；")}。请检查网络或 HAJI_PROXY 配置，也可直接 webfetch 官方页面。`;
  }

  /**
   * 官方 DeepSeek `/v1/tools/search`。
   *
   * 只取 `summary`（官方声明「适用于给模型阅读」），不取 `need_content` 的正文——
   * 正文交给 webfetch，避免一次搜索就把上下文塞满。
   */
  private async searchDeepSeek(
    query: string,
    apiKey: string,
    context?: ToolExecutionContext,
  ): Promise<{ text?: string; error?: string }> {
    const root = (this.options.deepseekBaseUrl?.() || DEEPSEEK_SEARCH_BASE).replace(/\/+$/, "");
    const url = `${root}/tools/search`;
    const controller = new AbortController();
    const abort = () => controller.abort(context?.abortSignal?.reason);
    context?.abortSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), DEEPSEEK_SEARCH_TIMEOUT_MS);
    try {
      const response = await this.fetchPage(
        url,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ query, count: DEEPSEEK_COUNT, need_content: false }),
        },
        { timeoutMs: DEEPSEEK_SEARCH_TIMEOUT_MS },
      );
      if (!response.ok) {
        const detail = await response
          .text()
          .catch(() => "")
          .then((body) => redactKey(body, apiKey).replace(/\s+/g, " ").slice(0, 120));
        return {
          error: `DeepSeek Search: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
        };
      }
      const payload = (await response.json()) as {
        results?: Array<{
          title?: unknown;
          url?: unknown;
          snippet?: unknown;
          summary?: unknown;
        }>;
      };
      const items: SearchItem[] = [];
      const seen = new Set<string>();
      for (const raw of payload.results ?? []) {
        const link = typeof raw.url === "string" ? searchUrl(raw.url) : undefined;
        const title = typeof raw.title === "string" ? raw.title.trim() : "";
        if (!link || !title || seen.has(link)) continue;
        seen.add(link);
        // 官方 summary 实测可达 3800 字符，逐条封顶后再交给 formatSearchOutput 做总长裁剪。
        const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
        const snippet = typeof raw.snippet === "string" ? raw.snippet.trim() : "";
        items.push({
          title,
          url: link,
          snippet: (summary || snippet).slice(0, DEEPSEEK_SUMMARY_LIMIT),
        });
      }
      if (!items.length) return { error: "DeepSeek Search: 无可用结果" };
      return { text: formatSearchOutput(query, "DeepSeek Search", items) };
    } catch (error) {
      if (context?.abortSignal?.aborted) return { error: "DeepSeek Search: 已中止" };
      return {
        error: `DeepSeek Search: ${
          controller.signal.aborted ? "请求超时" : safeSearchError(error)
        }`,
      };
    } finally {
      clearTimeout(timer);
      context?.abortSignal?.removeEventListener("abort", abort);
    }
  }
}
