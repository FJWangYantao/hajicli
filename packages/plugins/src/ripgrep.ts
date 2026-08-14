import { execFile, spawn } from 'node:child_process';

export interface RipgrepResult {
  stdout: string;
  exitCode: number;
}

export interface RipgrepLinesResult {
  lines: string[];
  exitCode: number;
  truncated: boolean;
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

/**
 * Streams ripgrep output and stops after a bounded number of lines.
 * This avoids buffering an unbounded repository-wide search in memory.
 */
export function runRipgrepLines(
  args: readonly string[],
  cwd: string,
  maxLines: number,
  abortSignal?: AbortSignal,
  executable = 'rg'
): Promise<RipgrepLinesResult | null> {
  if (abortSignal?.aborted) {
    const error = new Error('ripgrep 已中止');
    error.name = 'AbortError';
    return Promise.reject(error);
  }

  const lineLimit = Math.max(1, Math.trunc(maxLines));
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let exitCode = 0;
    let truncated = false;
    const lines: string[] = [];
    const child = spawn(executable, [...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });

    const cleanup = () => abortSignal?.removeEventListener('abort', abort);
    const finish = (result: RipgrepLinesResult | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const failAborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error('ripgrep 已中止');
      error.name = 'AbortError';
      reject(error);
    };
    const stopAtLimit = () => {
      if (lines.length < lineLimit || settled) return;
      truncated = true;
      child.kill('SIGTERM');
      finish({ lines, exitCode: 0, truncated });
    };
    const pushCompleteLines = () => {
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1 && lines.length < lineLimit) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line) lines.push(line);
        newlineIndex = buffer.indexOf('\n');
      }
      stopAtLimit();
    };
    const abort = () => {
      child.kill('SIGTERM');
      failAborted();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      pushCompleteLines();
    });
    child.on('error', error => {
      if (abortSignal?.aborted) {
        failAborted();
        return;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        finish(null);
        return;
      }
      finish(null);
    });
    child.on('close', code => {
      if (settled) return;
      if (abortSignal?.aborted) {
        failAborted();
        return;
      }
      if (buffer && lines.length < lineLimit) {
        lines.push(buffer.replace(/\r$/, ''));
      }
      exitCode = typeof code === 'number' ? code : 1;
      if (exitCode === 0 || exitCode === 1 || lines.length > 0) {
        finish({ lines, exitCode, truncated });
        return;
      }
      finish(null);
    });

    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
  });
}
