import * as fs from 'node:fs/promises';
import { BaseTool, ToolDefinition, ToolExecutionContext } from '@hajicli/core';
import { resolveWorkspacePath } from './workspace-path.js';

/**
 * 文件精准编辑工具（Search and Replace）。
 */
export class EditFileTool implements BaseTool {
  public readonly name = 'edit';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'edit',
      description: '在指定文件中以精准匹配的方式搜索 oldText 并替换为 newText。该操作仅当 oldText 在文件中唯一匹配时才会执行。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目标文件的相对或绝对路径。'
          },
          oldText: {
            type: 'string',
            description: '待替换的原始文本段落（必须在文件中唯一匹配，建议包含前后几行上下文以确保唯一性）。'
          },
          newText: {
            type: 'string',
            description: '替换后的新文本段落。'
          }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  };

  /**
   * 执行精准编辑。
   * @param args - 包含 path, oldText 和 newText 参数的对象。
   */
  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const filePath = args.path as string;
    const oldText = args.oldText as string;
    const newText = args.newText as string;

    if (!filePath) {
      return '错误: 缺少 path 参数。';
    }
    if (oldText === undefined || oldText === null) {
      return '错误: 缺少 oldText 参数。';
    }
    if (newText === undefined || newText === null) {
      return '错误: 缺少 newText 参数。';
    }

    if (context?.abortSignal?.aborted) return '[文件编辑已中止]';

    try {
      const resolvedPath = await resolveWorkspacePath(filePath);
      const content = await fs.readFile(resolvedPath, {
        encoding: 'utf-8',
        signal: context?.abortSignal
      });
      if (context?.abortSignal?.aborted) return '[文件编辑已中止]';

      // 统计匹配次数
      const firstIndex = content.indexOf(oldText);
      if (firstIndex === -1) {
        return `编辑失败: 在文件中找不到指定的 oldText 原文，请核对空格/换行符或提供准确的旧文本段落。`;
      }

      const secondIndex = content.indexOf(oldText, firstIndex + oldText.length);
      if (secondIndex !== -1) {
        return `编辑失败: 在文件中匹配到多处相同的 oldText，为了安全已拒绝修改。请在 oldText 中包含前后几行更独特的代码上下文，以确保其唯一性。`;
      }

      // 执行替换并写回
      const newContent = content.substring(0, firstIndex) + newText + content.substring(firstIndex + oldText.length);
      if (context?.abortSignal?.aborted) return '[文件编辑已中止]';
      await fs.writeFile(resolvedPath, newContent, {
        encoding: 'utf-8',
        signal: context?.abortSignal
      });

      return `[文件精准编辑成功]\n路径: ${filePath}\n替换成功。`;
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[文件编辑已中止]';
      }
      return `精准编辑文件失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
