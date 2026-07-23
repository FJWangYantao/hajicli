import { execFile } from 'node:child_process';

export interface RipgrepResult {
  stdout: string;
  exitCode: number;
}

/** Uses ripgrep when installed; returns null so callers can keep a portable JS fallback. */
export function runRipgrep(
  args: readonly string[],
  cwd: string,
  abortSignal?: AbortSignal,
  executable = 'rg'
): Promise<RipgrepResult | null> {
  if (abortSignal?.aborted) {
    const error = new Error('ripgrep 已中止');
    error.name = 'AbortError';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: RipgrepResult | null) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const failAborted = () => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', abort);
      const error = new Error('ripgrep 已中止');
      error.name = 'AbortError';
      reject(error);
    };
    const child = execFile(executable, [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      if (abortSignal?.aborted) {
        failAborted();
        return;
      }
      if (!error) {
        finish({ stdout, exitCode: 0 });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
      const numericCode = Number(code);
      if (code === 'ENOENT') {
        finish(null);
        return;
      }
      if (numericCode === 1 || stdout) {
        finish({ stdout: stdout || '', exitCode: Number.isFinite(numericCode) ? numericCode : 1 });
        return;
      }
      finish(null);
    });
    const abort = () => {
      child.kill('SIGTERM');
      failAborted();
    };
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
  });
}
