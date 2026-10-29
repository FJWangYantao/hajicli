import type { EventEmitter } from "node:events";

/** Bounded best-effort persistence when the controlling terminal disappears. */
export function installTerminalShutdown(options: {
  signals: EventEmitter;
  input?: EventEmitter;
  output?: EventEmitter;
  flush: () => Promise<void>;
  exit: (code: number) => void;
  timeoutMs?: number;
}): () => void {
  let closing = false;
  const close = async (code: number) => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => options.exit(code), options.timeoutMs ?? 3000);
    timer.unref?.();
    try {
      await options.flush();
    } catch {
      // The terminal may already be gone; never write an error back to it.
    } finally {
      clearTimeout(timer);
      options.exit(code);
    }
  };
  const hup = () => void close(129);
  const term = () => void close(143);
  const end = () => void close(129);
  const error = () => void close(1);
  options.signals.on("SIGHUP", hup);
  options.signals.on("SIGTERM", term);
  options.input?.on("end", end);
  options.input?.on("error", error);
  options.output?.on("error", error);
  return () => {
    options.signals.off("SIGHUP", hup);
    options.signals.off("SIGTERM", term);
    options.input?.off("end", end);
    options.input?.off("error", error);
    options.output?.off("error", error);
  };
}
