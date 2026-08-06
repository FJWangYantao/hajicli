import fs from 'node:fs/promises';

const TRANSIENT_REPLACE_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const REPLACE_RETRY_DELAYS_MS = [0, 10, 25, 50] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Replaces a file without falling back to a non-atomic in-place copy.
 * Windows scanners can briefly lock the destination, so transient failures are
 * retried before the caller retains its in-memory write for a later attempt.
 */
export async function replaceFileAtomically(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (const retryDelay of REPLACE_RETRY_DELAYS_MS) {
    if (retryDelay > 0) await delay(retryDelay);
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_REPLACE_ERRORS.has((error as NodeJS.ErrnoException).code || '')) break;
    }
  }

  try { await fs.rm(source, { force: true }); } catch {}
  throw lastError;
}
