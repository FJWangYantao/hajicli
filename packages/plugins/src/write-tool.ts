import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseTool, ToolDefinition } from '@hajicli/core';

/**
 * 文件写入/覆盖工具。
 */
export class WriteFileTool implements BaseTool {
  public readonly name = 'write';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'write',
      description: '向指定路径创建新文件，或完全覆盖写入整个文件。会自动创建不存在的父目录。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要写入的文件的相对或绝对路径。'
          },
          content: {
            type: 'string',
            description: '要写入的完整文件内容。'
          }
        },
        required: ['path', 'content']
      }
    }
  };

  /**
   * 执行文件写入。
   * @param args 包含路径及内容的参数。
   */
  public async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.path as string;
    const content = args.content as string;
    
    if (!filePath) {
      return '错误: 缺少 path 参数。';
    }
    if (content === undefined || content === null) {
      return '错误: 缺少 content 参数。';
    }

    try {
      const resolvedPath = path.resolve(process.cwd(), filePath);
      const parentDir = path.dirname(resolvedPath);
      
      // 递归创建不存在的父目录
      await fs.mkdir(parentDir, { recursive: true });
      
      // 写入文件
      await fs.writeFile(resolvedPath, content, 'utf-8');
      
      const stats = await fs.stat(resolvedPath);
      return `[文件写入成功]\n路径: ${filePath}\n大小: ${stats.size} 字节`;
    } catch (error) {
      return `写入文件失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
