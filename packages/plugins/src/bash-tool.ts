import { exec } from 'node:child_process';
import { BaseTool, ToolDefinition } from '@hajicli/core';

/**
 * 终端命令执行工具。
 */
export class BashTool implements BaseTool {
  public readonly name = 'bash';
  
  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'bash',
      description: '在本地终端中运行一条 Shell 命令 (Bash/PowerShell) 并返回控制台输出。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要在终端运行的完整命令行指令。'
          }
        },
        required: ['command']
      }
    }
  };

  /**
   * 执行 Bash 命令。
   * @param args 包含命令参数的对象。
   */
  public async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command as string;
    if (!command) {
      return '错误: 缺少 command 参数。';
    }

    return new Promise<string>((resolve) => {
      // 允许使用 10MB 的缓冲区，防止长输出崩掉
      exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        const exitCode = error ? error.code ?? 1 : 0;
        
        let result = `[命令执行结果 - 退出码 ${exitCode}]\n`;
        
        if (stdout) {
          result += `--- 标准输出 (stdout) ---\n${stdout}\n`;
        }
        if (stderr) {
          result += `--- 标准错误 (stderr) ---\n${stderr}\n`;
        }
        if (!stdout && !stderr) {
          result += `(命令执行完成，无控制台输出)\n`;
        }

        // 截断超长结果以防止上下文溢出（限制 8000 字符）
        const maxOutputLength = 8000;
        if (result.length > maxOutputLength) {
          result = result.substring(0, maxOutputLength) + '\n\n[输出已被截断，因为内容超过了 8000 字符限制]';
        }

        resolve(result);
      });
    });
  }
}
