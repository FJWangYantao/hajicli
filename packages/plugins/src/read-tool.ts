import * as fs from 'node:fs/promises';
import { BaseTool, ToolDefinition, ToolExecutionContext } from '@hajicli/core';
import { resolveWorkspacePath } from './workspace-path.js';

/**
 * 文件读取工具。
 */
export class ReadFileTool implements BaseTool {
  public readonly name = 'read';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'read',
      description: '读取指定路径文件的内容。可选择读取指定行号范围。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要读取的文件的相对或绝对路径。'
          },
          startLine: {
            type: 'number',
            description: '开始行号（从 1 开始计算，可选）。'
          },
          endLine: {
            type: 'number',
            description: '结束行号（从 1 开始计算，包含在内，可选）。'
          }
        },
        required: ['path']
      }
    }
  };

  /**
   * 执行文件读取。
   * @param args 包含路径及可选行范围的参数。
   */
  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const filePath = args.path as string;
    if (!filePath) {
      return '错误: 缺少 path 参数。';
    }

    const startLine = args.startLine ? Number(args.startLine) : undefined;
    const endLine = args.endLine ? Number(args.endLine) : undefined;

    if (context?.abortSignal?.aborted) return '[文件读取已中止]';

    try {
      const resolvedPath = await resolveWorkspacePath(filePath);
      const content = await fs.readFile(resolvedPath, {
        encoding: 'utf-8',
        signal: context?.abortSignal
      });
      if (context?.abortSignal?.aborted) return '[文件读取已中止]';
      
      const lines = content.split(/\r?\n/);
      let outputLines = lines;
      let lineRangeInfo = '';

      if (startLine !== undefined || endLine !== undefined) {
        const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0;
        const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
        
        if (start > end) {
          return `错误: 起始行号 ${startLine} 大于结束行号 ${endLine}。`;
        }
        
        outputLines = lines.slice(start, end);
        lineRangeInfo = ` (第 ${start + 1} 行至第 ${end} 行，总计 ${lines.length} 行)`;
      }

      let result = `[文件读取结果 - ${filePath}${lineRangeInfo}]\n`;
      result += outputLines.join('\n');

      // 截断超长结果以防止上下文溢出（限制 8000 字符）
      const maxOutputLength = 8000;
      if (result.length > maxOutputLength) {
        result = result.substring(0, maxOutputLength) + '\n\n[输出已被截断，因为内容超过了 8000 字符限制]';
      }

      return result;
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[文件读取已中止]';
      }
      return `读取文件失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
