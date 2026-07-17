import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseTool, ToolDefinition } from '@hajicli/core';

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
  public async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern ? (args.pattern as string).toLowerCase() : undefined;
    const rootDir = process.cwd();
    const excludeDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.gemini']);

    try {
      const files: string[] = [];

      const walk = async (currentDir: string) => {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
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

      await walk(rootDir);

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
      return `文件检索失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
