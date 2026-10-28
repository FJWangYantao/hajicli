import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";
import { fetchWithNetworkPolicy } from "./network.js";

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

function parseSearchResults(
  body: string,
  rss: boolean,
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
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

/**
 * 网页搜索工具（类似 websearch）。
 */
export class WebSearchTool implements BaseTool {
  public readonly name = "websearch";

  constructor(private readonly fetchPage: typeof fetchWithNetworkPolicy = fetchWithNetworkPolicy) {}

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
    const failures: string[] = [];
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
        const text =
          `[网络搜索结果 - 检索关键字 "${query}" - 来源 ${engine.name}]\n\n` +
          results
            .slice(0, 8)
            .map(
              (item, i) =>
                `### ${i + 1}. ${item.title}\n- **链接**: ${item.url}\n- **摘要**: ${item.snippet || "（无摘要，请抓取链接）"}`,
            )
            .join("\n\n");
        return text.slice(0, 8000);
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
}
