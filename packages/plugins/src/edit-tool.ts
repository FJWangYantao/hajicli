import * as fs from 'node:fs/promises';
import { BaseTool, ToolDefinition, ToolExecutionContext } from '@hajicli/core';
import { contentHash, FileConflictError, writeUtf8Atomically } from './file-content.js';
import { formatWorkspaceError, resolveWorkspacePath } from './workspace-path.js';

function parseExpectedHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/i.test(value)) {
    throw new Error('expectedHash 必须是 read 返回的16位十六进制 hash。');
  }
  return value.toLowerCase();
}

export class EditFileTool implements BaseTool {
  public readonly name = 'edit';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'edit',
      description: '在文件中唯一匹配 oldText 并原子替换为 newText。可传入 read 返回的 expectedHash 防止覆盖外部修改。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标文件路径。' },
          oldText: { type: 'string', description: '必须在文件中唯一匹配的原文。' },
          newText: { type: 'string', description: '替换后的文本。' },
          expectedHash: { type: 'string', description: '可选，read 返回的16位内容 hash。文件已变化时拒绝编辑。' }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  };

  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    if (typeof args.path !== 'string' || !args.path) return '错误: 缺少 path 参数。';
    if (typeof args.oldText !== 'string') return '错误: oldText 必须是字符串。';
    if (typeof args.newText !== 'string') return '错误: newText 必须是字符串。';
    let expectedHash: string | undefined;
    try {
      expectedHash = parseExpectedHash(args.expectedHash);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (context?.abortSignal?.aborted) return '[文件编辑已中止]';

    const filePath = args.path;
    try {
      const resolvedPath = await resolveWorkspacePath(filePath);
      const content = await fs.readFile(resolvedPath, { encoding: 'utf8', signal: context?.abortSignal });
      if (context?.abortSignal?.aborted) return '[文件编辑已中止]';
      const originalHash = contentHash(content);
      if (expectedHash !== undefined && expectedHash !== originalHash) {
        return `编辑失败: 文件已被修改，期望 hash=${expectedHash}，当前 hash=${originalHash}。请重新读取后再编辑。`;
      }

      const firstIndex = content.indexOf(args.oldText);
      if (firstIndex === -1) {
        return '编辑失败: 在文件中找不到指定的 oldText 原文，请重新读取并提供准确上下文。';
      }
      const secondIndex = content.indexOf(args.oldText, firstIndex + args.oldText.length);
      if (secondIndex !== -1) {
        return '编辑失败: oldText 匹配到多处，为安全起见已拒绝修改。请增加上下文确保唯一。';
      }

      const newContent = content.slice(0, firstIndex) + args.newText + content.slice(firstIndex + args.oldText.length);
      const newHash = contentHash(newContent);
      await writeUtf8Atomically(resolvedPath, newContent, context?.abortSignal, originalHash);
      return `[文件精准编辑成功]\n路径: ${filePath}\noldHash=${originalHash}\nnewHash=${newHash}\n替换次数=1`;
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[文件编辑已中止]';
      }
      if (error instanceof FileConflictError) {
        return `编辑失败: ${error.message}。请重新读取后再编辑。`;
      }
      return `精准编辑文件失败: ${formatWorkspaceError(error, filePath)}`;
    }
  }
}
