import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseTool, ToolDefinition, ToolExecutionContext } from '@hajicli/core';
import { runRipgrep } from './ripgrep.js';

/**
 * 全局文件查找工具（类似 global）。
 */
export class GlobalFindFilesTool implements BaseTool {
  public readonly name = 'global';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'global',
      description: '递归查找并列出当前工作目录下的文件列表，排除了 node_modules、.git 等无关文件夹。支持根据名称进行模糊匹配。',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: '过滤文件名的关键字（不区分大小写，可选，例如 "ts" 或 "index"）。'
          }
        }
      }
    }
  };

  /**
   * 执行全局文件检索。
   */
  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const pattern = args.pattern ? (args.pattern as string).toLowerCase() : undefined;
    const rootDir = process.cwd();
    const excludeDirs = new Set(['.git', '.haji', 'node_modules', 'dist', 'build', 'out', '.gemini']);
    const throwIfAborted = () => {
      if (!context?.abortSignal?.aborted) return;
      const error = new Error('文件查找已中止');
      error.name = 'AbortError';
      throw error;
    };

    try {
      throwIfAborted();
      const files: string[] = [];

      const fastResult = await runRipgrep([
        '--files', '--hidden',
        '--glob', '!node_modules/**', '--glob', '!.git/**', '--glob', '!dist/**',
        '--glob', '!build/**', '--glob', '!out/**', '--glob', '!.gemini/**', '--glob', '!.haji/**'
      ], rootDir, context?.abortSignal);
      if (fastResult) {
        for (const file of fastResult.stdout.split(/\r?\n/)) {
          throwIfAborted();
          if (!file) continue;
          const normalized = file.replace(/\\/g, '/');
          if (!pattern || normalized.toLowerCase().includes(pattern)) files.push(normalized);
        }
      }

      const walk = async (currentDir: string) => {
        throwIfAborted();
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        throwIfAborted();
        for (const entry of entries) {
          throwIfAborted();
          const entryPath = path.join(currentDir, entry.name);
          const relativePath = path.relative(rootDir, entryPath);

          if (entry.isDirectory()) {
            if (excludeDirs.has(entry.name)) {
              continue;
            }
            await walk(entryPath);
          } else if (entry.isFile()) {
            if (!pattern || entry.name.toLowerCase().includes(pattern) || relativePath.toLowerCase().includes(pattern)) {
              // 统一使用正斜杠以保持跨平台输出一致性
              files.push(relativePath.replace(/\\/g, '/'));
            }
          }
        }
      };

      if (!fastResult) await walk(rootDir);

      let result = `[全局文件查找结果 - 共找到 ${files.length} 个文件]\n`;
      if (files.length === 0) {
        result += `(没有找到${pattern ? ` 匹配 "${pattern}" 的` : ''}文件)\n`;
      } else {
        result += files.join('\n');
      }

      // 截断超长结果以防止上下文溢出（限制 8000 字符）
      const maxOutputLength = 8000;
      if (result.length > maxOutputLength) {
        result = result.substring(0, maxOutputLength) + '\n\n[输出已被截断，因为文件列表超过了 8000 字符限制]';
      }

      return result;
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[文件查找已中止]';
      }
      return `文件检索失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
