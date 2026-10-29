/** Explicit full/lite overrides SSH detection; unknown values behave like auto. */
export function liteDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.HAJI_DISPLAY?.trim().toLowerCase();
  if (mode === "full") return false;
  if (mode === "lite") return true;
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY);
}

export function renderDelay(interactive: boolean, env: NodeJS.ProcessEnv = process.env): number {
  return interactive ? 8 : liteDisplay(env) ? 100 : 16;
}

/** tmux passthrough requires allow-passthrough on in tmux configuration. */
export function clipboardSequence(text: string, tmux: boolean): string {
  const osc = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  return tmux ? `\x1bPtmux;${osc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : osc;
}
