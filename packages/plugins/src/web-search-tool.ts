import { BaseTool, ToolDefinition, ToolExecutionContext } from '@hajicli/core';

/**
 * 网页搜索工具（类似 websearch）。
 */
export class WebSearchTool implements BaseTool {
  public readonly name = 'websearch';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'websearch',
      description: '在互联网上搜索指定关键字，并返回前 5-8 条搜索结果的标题、链接和正文摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要在网络上搜索的关键字。'
          }
        },
        required: ['query']
      }
    }
  };

  /**
   * 执行网络检索。
   */
  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const query = args.query as string;
    if (!query) {
      return '错误: 缺少 query 参数。';
    }

    try {
      // 使用 GET 请求 DuckDuckGo Lite 版本
      const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        signal: context?.abortSignal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2'
        }
      });

      if (!response.ok) {
        return `网络搜索请求失败: 状态码 ${response.status}`;
      }

      const html = await response.text();

      // 提取标题和 URL 链接
      // DuckDuckGo Lite 结构：<a class="result-link" href="URL">Title</a>
      const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      // 提取摘要描述
      // DuckDuckGo Lite 结构：<td class="result-snippet">Description</td>
      const snippetRegex = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

      const links: { url: string; title: string }[] = [];
      const snippets: string[] = [];

      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        let rawUrl = match[1];
        // 如果是 DuckDuckGo 的跳转链接，可以提取真正的 URL
        if (rawUrl.startsWith('//duckduckgo.com/l/?uddg=')) {
          const matchUrl = rawUrl.match(/uddg=([^&]+)/);
          if (matchUrl) {
            rawUrl = decodeURIComponent(matchUrl[1]);
          }
        }
        if (rawUrl.startsWith('/')) {
          rawUrl = 'https://lite.duckduckgo.com' + rawUrl;
        }

        // 清洗标题中的 HTML 标签
        const cleanTitle = match[2].replace(/<[^>]+>/g, '').trim();
        links.push({ url: rawUrl, title: cleanTitle });
      }

      while ((match = snippetRegex.exec(html)) !== null) {
        // 清洗摘要中的 HTML 标签和多余空白字符
        const cleanSnippet = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        snippets.push(cleanSnippet);
      }

      let result = `[网络搜索结果 - 检索关键字 "${query}"]\n\n`;
      const count = Math.min(links.length, snippets.length, 8); // 最多展示 8 条结果

      if (count === 0) {
        result += `(未找到相关搜索结果，可能是由于请求被限制，或者没有匹配的搜索结果)\n`;
      } else {
        for (let i = 0; i < count; i++) {
          result += `### ${i + 1}. ${links[i].title}\n`;
          result += `- **链接**: ${links[i].url}\n`;
          result += `- **摘要**: ${snippets[i]}\n\n`;
        }
      }

      // 截断超长结果以防止上下文溢出（限制 8000 字符）
      const maxOutputLength = 8000;
      if (result.length > maxOutputLength) {
        result = result.substring(0, maxOutputLength) + '\n\n[输出已被截断，因为内容超过了 8000 字符限制]';
      }

      return result;
    } catch (error) {
      if (context?.abortSignal?.aborted) return '[网络搜索已中止]';
      return `网络搜索失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
