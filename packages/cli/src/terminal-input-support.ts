import { spawnSync } from "node:child_process";

/**
 * 终端输入层里与 TerminalUI 状态无关的零散支撑代码：
 * Windows 控制台 VT 输入开关、段尾换行/SGR 收尾，以及输入请求的三种中断信号。
 * 抽出来只为一件事：让 terminal-input.ts 里那个巨型类少一点无关噪声。
 */

/** Windows 控制台默认不把 Alt/方向键等组合键交给 VT 输入，需要显式打开该模式。 */
export function enableWindowsVirtualTerminalInput(): boolean {
  if (process.platform !== "win32") {
    return true;
  }

  const script = [
    `Add-Type -Namespace Haji -Name ConsoleMode -MemberDefinition '${[
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr GetStdHandle(int nStdHandle);',
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(System.IntPtr handle, out uint mode);',
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(System.IntPtr handle, uint mode);',
    ].join(" ")}'`,
    "$handle = [Haji.ConsoleMode]::GetStdHandle(-10)",
    "[uint32]$mode = 0",
    "if (-not [Haji.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)) { exit 1 }",
    "$virtualTerminalInput = [uint32]0x0200",
    "if (-not [Haji.ConsoleMode]::SetConsoleMode($handle, ($mode -bor $virtualTerminalInput))) { exit 1 }",
  ].join("; ");

  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      stdio: ["inherit", "ignore", "ignore"],
      windowsHide: true,
    },
  );

  return result.status === 0;
}

/** 段尾统一补换行：封口片段必须整行结束，拼接时才不会和下一段粘在一起。 */
export function ensureTrailingNewline(raw: string): string {
  if (raw.length === 0) return raw;
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

/**
 * 段尾若残留未复位的 SGR，在最后一个换行前补一个 reset。
 * 否则段尾的颜色会漏到下一段（各段独立换行再拼接就不再等价于整串换行）。
 */
export function closeTrailingStyle(raw: string): string {
  const pattern = /\x1b\[([0-9;]*)m/g;
  let active = false;
  let match = pattern.exec(raw);
  while (match !== null) {
    const params = match[1];
    active = !(params === "" || params === "0");
    match = pattern.exec(raw);
  }
  if (!active) return raw;
  return raw.endsWith("\n") ? `${raw.slice(0, -1)}\x1b[0m\n` : `${raw}\x1b[0m`;
}

export class TerminalInputCancelledError extends Error {
  constructor() {
    super("Terminal input cancelled");
    this.name = "TerminalInputCancelledError";
  }
}

/**
 * 输入行被鼠标交互（侧栏点击等）临时接管。
 * 刻意不继承 TerminalInputCancelledError：用户取消（Ctrl+D）会让主循环退出，
 * 而接管只是换一个交互继续，主循环必须继续等下一轮输入而不是收摊。
 */
export class TerminalInputTakenOverError extends Error {
  constructor() {
    super("Terminal input taken over");
    this.name = "TerminalInputTakenOverError";
  }
}

/**
 * 输入行已被占用：另一个输入请求或选择器还没结束。
 * 单独成类是为了让主循环能把「偶发竞态」和真正的编码错误区分开——
 * 前者等空闲后重取输入，不该把整场会话崩掉。
 */
export class TerminalInputBusyError extends Error {
  constructor() {
    super("已有输入请求正在等待处理");
    this.name = "TerminalInputBusyError";
  }
}
