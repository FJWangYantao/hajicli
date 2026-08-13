import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { replaceFileAtomically } from '@hajicli/core';

export function contentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export class FileConflictError extends Error {
  public readonly code = 'HAJI_FILE_CONFLICT';

  constructor(public readonly expectedHash: string, public readonly actualHash?: string) {
    super(actualHash
      ? `文件已变化：期望 hash=${expectedHash}，当前 hash=${actualHash}`
      : `文件已变化或不存在：期望 hash=${expectedHash}`);
    this.name = 'FileConflictError';
  }
}

function abortError(): Error {
  const error = new Error('文件写入已中止');
  error.name = 'AbortError';
  return error;
}

/** Writes beside the target and atomically replaces it while preserving its mode when possible. */
export async function writeUtf8Atomically(
  targetPath: string,
  content: string,
  abortSignal?: AbortSignal,
  expectedHash?: string
): Promise<void> {
  if (abortSignal?.aborted) throw abortError();
  let mode: number | undefined;
  try {
    mode = (await fs.stat(targetPath)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.haji-${process.pid}-${randomUUID()}.tmp`
  );
  try {
    await fs.writeFile(tempPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
      signal: abortSignal
    });
    if (abortSignal?.aborted) throw abortError();
    if (expectedHash !== undefined) {
      let actualHash: string | undefined;
      try {
        actualHash = contentHash(await fs.readFile(targetPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (actualHash !== expectedHash) throw new FileConflictError(expectedHash, actualHash);
    }
    await replaceFileAtomically(tempPath, targetPath);
  } finally {
    try { await fs.rm(tempPath, { force: true }); } catch {}
  }
}
