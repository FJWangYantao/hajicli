import { exec, execFile, type ChildProcess } from 'node:child_process';
import { BaseTool, ToolDefinition, ToolExecutionContext, ToolMutationScope } from '@hajicli/core';

class HeadTailBuffer {
  private head = '';
  private tail = '';
  private totalLength = 0;

  constructor(private readonly headLimit = 1_000, private readonly tailLimit = 2_500) {}

  append(value: string): void {
    if (!value) return;
    this.totalLength += value.length;
    let remaining = value;
    if (this.head.length < this.headLimit) {
      const accepted = remaining.slice(0, this.headLimit - this.head.length);
      this.head += accepted;
      remaining = remaining.slice(accepted.length);
    }
    if (remaining) this.tail = `${this.tail}${remaining}`.slice(-this.tailLimit);
  }

  render(): string {
    const omitted = Math.max(0, this.totalLength - this.head.length - this.tail.length);
    if (omitted === 0) return `${this.head}${this.tail}`;
    return `${this.head}\n[中间省略 ${omitted} 个字符]\n${this.tail}`;
  }
}

/**
 * 只对无法组合其他命令、且没有输出重定向的白名单查询命令跳过工作区快照。
 * 任何不确定命令都按 workspace 处理，宁可多做一次快照也不漏记修改。
 */
export function classifyBashMutationScope(command: string): ToolMutationScope {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized || /[;&|><`\r\n]/.test(command) || /\$\(/.test(command)) return 'workspace';
  if (/\s--output(?:=|\s|$)/.test(normalized)) return 'workspace';

  if (/^git (?:status|diff|log|show|rev-parse|ls-files)(?:\s|$)/.test(normalized)) return 'none';
  if (/^(?:rg|ripgrep)(?:\s|$)/.test(normalized) && !/\s--pre(?:=|\s|$)/.test(normalized)) return 'none';
  if (/^(?:dir|type|where(?:\.exe)?|findstr)(?:\s|$)/.test(normalized)) return 'none';
  if (/^(?:get-childitem|get-item|get-content|select-string|test-path|resolve-path)(?:\s|$)/.test(normalized)) return 'none';
  return 'workspace';
}

/**
 * 终端命令执行工具。
 */
export class BashTool implements BaseTool {
  public readonly name = 'bash';

  /** 可注入执行器，便于验证 Windows 进程清理失败的兜底路径。 */
  constructor(
    private readonly commandExecutor: typeof exec = exec,
    private readonly fileExecutor: typeof execFile = execFile,
    private readonly processKiller: (pid: number, signal: NodeJS.Signals) => boolean = (pid, signal) => process.kill(pid, signal)
  ) {}
  
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
          },
          timeoutMs: {
            type: 'number',
            description: '可选超时，1000-600000 毫秒；超时后清理命令进程树。'
          }
        },
        required: ['command']
      }
    }
  };

  public getMutationScope(args: Record<string, unknown>): ToolMutationScope {
    return classifyBashMutationScope(typeof args.command === 'string' ? args.command : '');
  }

  /**
   * 执行 Bash 命令。
   * @param args 包含命令参数的对象。
   */
  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const command = args.command as string;
    if (!command) {
      return '错误: 缺少 command 参数。';
    }
    const timeoutMs = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)) {
      return '错误: timeoutMs 必须是 1000 到 600000 之间的整数。';
    }

    if (context?.abortSignal?.aborted) return '[命令已中止]';

    return new Promise<string>((resolve) => {
      let settled = false;
      let aborting = false;
      let terminationReason: 'abort' | 'timeout' = 'abort';
      let child: ChildProcess | undefined;
      let abort = () => {};
      let timeout: NodeJS.Timeout | undefined;
      const startedAt = Date.now();
      const stdoutBuffer = new HeadTailBuffer();
      const stderrBuffer = new HeadTailBuffer();
      let sawStdoutChunk = false;
      let sawStderrChunk = false;
      const terminationLabel = () => terminationReason === 'timeout'
        ? `[命令执行超时 - ${timeoutMs}ms]`
        : '[命令已中止]';
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        context?.abortSignal?.removeEventListener('abort', abort);
        child = undefined;
        resolve(value);
      };
      const finishAfterProcessClose = (value: string) => {
        const runningChild = child;
        if (!runningChild || runningChild.exitCode !== null || typeof runningChild.once !== 'function') {
          finish(value);
          return;
        }
        let closeTimeout: NodeJS.Timeout | undefined;
        const closed = () => {
          if (closeTimeout) clearTimeout(closeTimeout);
          finish(value);
        };
        runningChild.once('close', closed);
        closeTimeout = setTimeout(() => {
          runningChild.removeListener?.('close', closed);
          finish(value);
        }, 750);
        closeTimeout.unref?.();
      };
      // 允许使用 10MB 的缓冲区，防止长输出崩掉
      child = this.commandExecutor(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        if (context?.abortSignal?.aborted) {
          if (!aborting) abort();
          return;
        }
        if (aborting) return;
        const exitCode = error ? error.code ?? 1 : 0;
        if (!sawStdoutChunk && stdout) stdoutBuffer.append(String(stdout));
        if (!sawStderrChunk && stderr) stderrBuffer.append(String(stderr));
        const boundedStdout = stdoutBuffer.render();
        const boundedStderr = stderrBuffer.render();
        const durationMs = Date.now() - startedAt;

        let result = `[命令执行结果 - 退出码 ${exitCode}；耗时 ${durationMs}ms]\n`;
        if (boundedStdout) {
          result += `--- 标准输出 (stdout，保留头尾) ---\n${boundedStdout}\n`;
        }
        if (boundedStderr) {
          result += `--- 标准错误 (stderr，保留头尾) ---\n${boundedStderr}\n`;
        }
        if (!boundedStdout && !boundedStderr) {
          result += `(命令执行完成，无控制台输出)\n`;
        }
        finish(result);
      });
      child.stdout?.on('data', chunk => {
        if (!settled) {
          sawStdoutChunk = true;
          stdoutBuffer.append(String(chunk));
          context?.onProgress?.({ type: 'stdout', chunk: String(chunk) });
        }
      });
      child.stderr?.on('data', chunk => {
        if (!settled) {
          sawStderrChunk = true;
          stderrBuffer.append(String(chunk));
          context?.onProgress?.({ type: 'stderr', chunk: String(chunk) });
        }
      });

      abort = () => {
        if (settled || aborting) return;
        aborting = true;
        const runningChild = child;
        if (!runningChild) {
          finish(terminationLabel());
          return;
        }

        if (runningChild.pid && process.platform === 'win32') {
          const rootPid = runningChild.pid;
          const processTreeType = [
            'using System;',
            'using System.Collections.Generic;',
            'using System.Runtime.InteropServices;',
            'public static class HajiProcessTree {',
            '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
            '  private struct PROCESSENTRY32 {',
            '    public uint dwSize; public uint cntUsage; public uint th32ProcessID;',
            '    public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads;',
            '    public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;',
            '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;',
            '  }',
            '  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);',
            '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);',
            '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);',
            '  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);',
            '  public static int[] Descendants(int rootPid) {',
            '    var relations = new List<Tuple<int, int>>();',
            '    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);',
            '    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
            '    try {',
            '      var entry = new PROCESSENTRY32(); entry.dwSize = (uint)Marshal.SizeOf(entry);',
            '      if (Process32FirstW(snapshot, ref entry)) {',
            '        do { relations.Add(Tuple.Create((int)entry.th32ProcessID, (int)entry.th32ParentProcessID)); }',
            '        while (Process32NextW(snapshot, ref entry));',
            '      }',
            '    } finally { CloseHandle(snapshot); }',
            '    var result = new List<int>(); var frontier = new List<int> { rootPid };',
            '    while (frontier.Count > 0) {',
            '      var next = new List<int>();',
            '      foreach (var relation in relations) if (frontier.Contains(relation.Item2)) { next.Add(relation.Item1); result.Add(relation.Item1); }',
            '      frontier = next;',
            '    }',
            '    result.Reverse(); return result.ToArray();',
            '  }',
            '}'
          ].join(' ');
          const cleanupScript = [
            "$ErrorActionPreference = 'Stop'",
            `$rootProcessId = ${rootPid}`,
            `$typeDefinition = '${processTreeType}'`,
            'Add-Type -TypeDefinition $typeDefinition',
            "Write-Output ([HajiProcessTree]::Descendants($rootProcessId) -join ',')"
          ].join('; ');

          // 优先调用系统原生 taskkill。只有失败时才启动较慢的进程树枚举，避免 ESC 被 PowerShell 编译阻塞。
          this.fileExecutor(
            'taskkill.exe',
            ['/PID', String(rootPid), '/T', '/F'],
            { windowsHide: true, timeout: 3000 },
            (taskkillError) => {
              if (settled) return;
              if (!taskkillError) {
                finishAfterProcessClose(terminationLabel());
                return;
              }

              const taskkillCode = (taskkillError as NodeJS.ErrnoException & { code?: string | number }).code ?? 'unknown';
              this.fileExecutor(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cleanupScript],
                { windowsHide: true, timeout: 5000 },
                (enumerationError, stdout) => {
                  if (settled) return;
                  const descendantIds = enumerationError
                    ? []
                    : String(stdout || '')
                        .trim()
                        .split(',')
                        .map(value => Number(value.trim()))
                        .filter(value => Number.isInteger(value) && value > 0);
                  const failedIds: number[] = [];
                  for (const descendantId of descendantIds) {
                    try {
                      this.processKiller(descendantId, 'SIGTERM');
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                        failedIds.push(descendantId);
                      }
                    }
                  }
                  const parentSignalSent = runningChild.kill('SIGTERM');
                  if (!enumerationError && descendantIds.length > 0 && failedIds.length === 0 && parentSignalSent) {
                    finishAfterProcessClose(`${terminationLabel()}\n提示: taskkill 失败 (code=${taskkillCode})，已通过进程枚举兜底清理。`);
                    return;
                  }

                  const enumerationCode = enumerationError
                    ? (enumerationError as NodeJS.ErrnoException & { code?: string | number }).code ?? 'unknown'
                    : 'ok';
                  finishAfterProcessClose(
                    `${terminationLabel()}\n警告: taskkill 失败 (code=${taskkillCode})，进程树未能确认完整清理；`
                    + `枚举状态: ${enumerationCode}，未清理 PID: ${failedIds.length > 0 ? failedIds.join(', ') : '未知'}。`
                  );
                }
              );
            }
          );
          return;
        }

        const signalSent = runningChild.kill('SIGTERM');
        finishAfterProcessClose(signalSent
          ? terminationLabel()
          : `${terminationLabel()}\n警告: 进程终止信号发送失败，可能存在残留进程。`);
      };
      context?.abortSignal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          terminationReason = 'timeout';
          abort();
        }, timeoutMs);
        timeout.unref?.();
      }
      if (context?.abortSignal?.aborted) abort();
    });
  }
}
