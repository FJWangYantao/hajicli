import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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

export class WriteFileTool implements BaseTool {
  public readonly name = 'write';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'write',
      description: '原子创建或完整覆写文件。覆写已读取文件时应传入 expectedHash，文件已变化则拒绝覆盖。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要创建或覆写的文件路径。' },
          content: { type: 'string', description: '完整文件内容。' },
          expectedHash: { type: 'string', description: '可选，read 返回的16位内容 hash。' }
        },
        required: ['path', 'content']
      }
    }
  };

  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    if (typeof args.path !== 'string' || !args.path) return '错误: 缺少 path 参数。';
    if (typeof args.content !== 'string') return '错误: content 必须是字符串。';
    let expectedHash: string | undefined;
    try {
      expectedHash = parseExpectedHash(args.expectedHash);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (context?.abortSignal?.aborted) return '[文件写入已中止]';

    const filePath = args.path;
    try {
      const resolvedPath = await resolveWorkspacePath(filePath, { mustExist: false });
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      if (context?.abortSignal?.aborted) return '[文件写入已中止]';
      await writeUtf8Atomically(resolvedPath, args.content, context?.abortSignal, expectedHash);
      const hash = contentHash(args.content);
      const stats = await fs.stat(resolvedPath);
      return `[文件写入成功]\n路径: ${filePath}\n大小: ${stats.size} 字节\nhash=${hash}`;
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[文件写入已中止]';
      }
      if (error instanceof FileConflictError) {
        return `写入失败: ${error.message}。请重新读取后再写入。`;
      }
      return `写入文件失败: ${formatWorkspaceError(error, filePath)}`;
    }
  }
}
