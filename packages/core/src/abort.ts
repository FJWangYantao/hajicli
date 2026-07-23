/** Returns true for the abort error shapes used by Node, undici and browser-compatible APIs. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (value.name === 'AbortError' || value.code === 'ABORT_ERR') return true;
  return Boolean(value.cause && isAbortError(value.cause));
}

/** Creates a stable AbortError without changing the caller's timeout reason. */
export function normalizeAbortError(error: unknown, fallback = 'Operation aborted'): Error {
  const normalized = new Error(error instanceof Error && error.message ? error.message : fallback);
  normalized.name = 'AbortError';
  Object.defineProperty(normalized, 'code', { value: 'ABORT_ERR', enumerable: false });
  return normalized;
}
