import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseTool, ToolDefinition, ToolExecutionContext } from '@hajicli/core';
import { runRipgrep } from './ripgrep.js';

/**
 * 全局文本检索工具（类似 grep）。
 */
export class GrepSearchTool implements BaseTool {
  public readonly name = 'grep';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'grep',
      description: '在指定目录的所有文本文件中搜索匹配指定关键字的行，返回文件名、行号和行内容。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要在文件中搜索的关键字（区分大小写）。'
          },
          path: {
            type: 'string',
            description: '搜索的起始目录（可选，相对路径，默认当前工作目录）。'
          }
        },
        required: ['query']
      }
    }
  };

  /**
   * 执行文本检索。
   */
  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const query = args.query as string;
    if (!query) {
      return '错误: 缺少 query 参数。';
    }

    const relativePath = (args.path as string) || '';
    const rootDir = process.cwd();
    const startDir = path.resolve(rootDir, relativePath);

    const excludeDirs = new Set(['.git', '.haji', 'node_modules', 'dist', 'build', 'out', '.gemini']);
    const excludeExtensions = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz',
      '.mp3', '.mp4', '.wav', '.mov', '.exe', '.dll', '.bin', '.woff', '.woff2', '.ttf', '.eot'
    ]);
    const throwIfAborted = () => {
      if (!context?.abortSignal?.aborted) return;
      const error = new Error('Grep 搜索已中止');
      error.name = 'AbortError';
      throw error;
    };

    try {
      throwIfAborted();
      const matches: { file: string; line: number; content: string }[] = [];
      const maxMatches = 100; // 限制最多匹配 100 条

      const fastResult = await runRipgrep([
        '--line-number', '--no-heading', '--color', 'never', '--fixed-strings',
        '--glob', '!node_modules/**', '--glob', '!.git/**', '--glob', '!dist/**',
        '--glob', '!build/**', '--glob', '!out/**', '--glob', '!.gemini/**', '--glob', '!.haji/**',
        query, '.'
      ], startDir, context?.abortSignal);
      if (fastResult) {
        for (const line of fastResult.stdout.split(/\r?\n/)) {
          throwIfAborted();
          if (!line || matches.length >= maxMatches) break;
          const match = line.match(/^(.*?):(\d+):(.*)$/);
          if (!match) continue;
          matches.push({
            file: path.relative(rootDir, path.resolve(startDir, match[1])).replace(/\\/g, '/'),
            line: Number(match[2]),
            content: match[3].trim()
          });
        }
      }

      const searchFile = async (filePath: string, relPath: string) => {
        try {
          throwIfAborted();
          const buffer = await fs.readFile(filePath, { signal: context?.abortSignal });
          throwIfAborted();
          
          // 简易判断是否是二进制文件 (含有 null 字节)
          for (let i = 0; i < Math.min(buffer.length, 1024); i++) {
            throwIfAborted();
            if (buffer[i] === 0) {
              return; // 判定为二进制，跳过
            }
          }

          const content = buffer.toString('utf-8');
          const lines = content.split(/\r?\n/);
          
          for (let i = 0; i < lines.length; i++) {
            throwIfAborted();
            if (lines[i].includes(query)) {
              matches.push({
                file: relPath.replace(/\\/g, '/'),
                line: i + 1,
                content: lines[i].trim()
              });
              if (matches.length >= maxMatches) {
                return;
              }
            }
          }
        } catch (error) {
          if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            throw error;
          }
          // 忽略单个文件读取出错
        }
      };

      const walk = async (currentDir: string) => {
        throwIfAborted();
        if (matches.length >= maxMatches) return;

        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        throwIfAborted();
        for (const entry of entries) {
          throwIfAborted();
          if (matches.length >= maxMatches) return;

          const entryPath = path.join(currentDir, entry.name);
          const relPath = path.relative(rootDir, entryPath);
          const ext = path.extname(entry.name).toLowerCase();

          if (entry.isDirectory()) {
            if (excludeDirs.has(entry.name)) {
              continue;
            }
            await walk(entryPath);
          } else if (entry.isFile()) {
            if (excludeExtensions.has(ext)) {
              continue;
            }
            await searchFile(entryPath, relPath);
          }
        }
      };

      if (!fastResult) await walk(startDir);

      let result = `[Grep 搜索结果 - 检索关键字 "${query}"]\n`;
      if (matches.length === 0) {
        result += `(未在任何文本文件中找到包含 "${query}" 的行)\n`;
      } else {
        for (const m of matches) {
          result += `${m.file}:${m.line}: ${m.content}\n`;
        }
        if (matches.length >= maxMatches) {
          result += `\n[已达到最大匹配上限 ${maxMatches} 条，搜索提前结束]\n`;
        }
      }

      // 截断超长结果以防止上下文溢出（限制 8000 字符）
      const maxOutputLength = 8000;
      if (result.length > maxOutputLength) {
        result = result.substring(0, maxOutputLength) + '\n\n[输出已被截断，因为内容超过了 8000 字符限制]';
      }

      return result;
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[Grep 搜索已中止]';
      }
      return `Grep 搜索失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
