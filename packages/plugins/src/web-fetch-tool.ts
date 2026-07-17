import { BaseTool, ToolDefinition } from '@hajicli/core';

/**
 * 网页抓取工具（类似 webfetch）。
 */
export class WebFetchTool implements BaseTool {
  public readonly name = 'webfetch';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'webfetch',
      description: '抓取并获取指定 URL 网页的纯文本内容，去除了 HTML 标签及无关脚本样式。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要抓取内容的网页 URL（例如 "https://news.ycombinator.com"）。'
          }
        },
        required: ['url']
      }
    }
  };

  /**
   * 执行网页内容抓取。
   */
  public async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url) {
      return '错误: 缺少 url 参数。';
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!response.ok) {
        return `网页抓取失败: 状态码 ${response.status}`;
      }

      const html = await response.text();

      // 清洗 HTML 标签，仅保留正文纯文本
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // 移除 script 标签
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // 移除 style 标签
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')   // 移除 head 标签
        .replace(/<[^>]+>/g, ' ')                        // 替换所有 HTML 标签为单个空格
        .replace(/\s+/g, ' ')                            // 合并多个空白字符
        .trim();

      let result = `[网页抓取成功 - 目标地址: ${url}]\n\n`;
      result += text;

      // 截断超长结果以防止上下文溢出（限制 8000 字符）
      const maxOutputLength = 8000;
      if (result.length > maxOutputLength) {
        result = result.substring(0, maxOutputLength) + '\n\n[输出已被截断，因为内容超过了 8000 字符限制]';
      }

      return result;
    } catch (error) {
      return `网页抓取失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
