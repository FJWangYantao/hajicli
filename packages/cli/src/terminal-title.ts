/**
 * 把会话标题写到终端窗口标题（OSC 2）。
 *
 * Kero（kero.sh）的侧栏行名与单窗格标题栏都走 `Session.DisplayName`：
 * 用户没手动重命名时，取的是**前台程序设置的标题**（`Pane.Title`，来自 OSC 0/2）；
 * 程序没设就退化成目录名。haji 原来一条标题都不发，侧栏只能显示目录名，
 * 一眼看不出这个窗格在跑什么，所以由这里补上。
 *
 * 只在「可能在 Kero 后面」时写（与状态上报同一套判定），判定不到就一个字节都不发：
 * 其它终端里改标题是无害的，但没必要替用户改窗口名。
 * 标题形态 `haji · <会话标题>`：haji 不在 Kero 内置 agents 里，靠前缀才认得出是谁。
 */
import { resolveStatusReportEnabled } from "./agent-status.js";
import { fitText } from "./terminal-text.js";

/** 标题长度上限（显示列）：Kero 侧栏单行省略，再长只会被截掉，还会挤掉其它终端的信息。 */
export const MAX_TITLE_WIDTH = 120;

const DEFAULT_APP = "haji";

/** 压成可打印单行：控制字符会打断 OSC 或让侧栏错位，零宽/双向控制符也会。 */
function sanitizeTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 产出真正写进 OSC 的标题文本：`haji · 会话标题`，无标题时只留 `haji`。 */
export function formatTerminalTitle(sessionTitle?: string, app = DEFAULT_APP): string {
  const cleanApp = sanitizeTitle(app) || DEFAULT_APP;
  const clean = sessionTitle ? sanitizeTitle(sessionTitle) : "";
  return fitText(clean ? `${cleanApp} · ${clean}` : cleanApp, MAX_TITLE_WIDTH);
}

/**
 * OSC 2 = 只设窗口标题（不动图标名）。BEL 收尾兼容面最广，
 * Kero 的 libghostty-vt 与 xterm / iTerm2 都认。
 */
export function buildTitleSequence(title: string): string {
  return `\x1b]2;${sanitizeTitle(title)}\x07`;
}

export interface TerminalTitleReporter {
  /** 当前进程是否会真的写标题。 */
  readonly enabled: boolean;
  /** 运行期开关：无头模式（-p）等场景由调用方关掉。 */
  setEnabled(enabled: boolean): void;
  /** 会话标题变化时调用；同一条标题重复调用不会重复写。 */
  set(sessionTitle?: string): void;
}

export interface TerminalTitleReporterOptions {
  env?: NodeJS.ProcessEnv;
  /** 写标题的目标，默认 process.stdout：必须直接写窗格 tty。 */
  write?: (sequence: string) => void;
  /** stdout 是否是终端，默认读 process.stdout.isTTY。 */
  isTTY?: boolean;
  app?: string;
}

/** 造一个标题上报器：与状态上报共用开关判定，并且会去重（更新提示每批工具都会触发）。 */
export function createTerminalTitleReporter(
  options: TerminalTitleReporterOptions = {},
): TerminalTitleReporter {
  const env = options.env ?? process.env;
  const app = options.app ?? DEFAULT_APP;
  const write = options.write ?? ((sequence: string) => process.stdout.write(sequence));
  let enabled = resolveStatusReportEnabled(env) && (options.isTTY ?? Boolean(process.stdout.isTTY));
  let lastTitle = "";
  return {
    get enabled() {
      return enabled;
    },
    setEnabled: (value) => {
      enabled = value;
    },
    set: (sessionTitle) => {
      if (!enabled) return;
      const title = formatTerminalTitle(sessionTitle, app);
      if (title === lastTitle) return;
      lastTitle = title;
      try {
        write(buildTitleSequence(title));
      } catch {
        // 终端已关闭 / EPIPE：标题上报失败不该影响主流程。
      }
    },
  };
}

/** 进程级默认上报器（index.ts 的 updateStatusUI 共用）。 */
export const terminalTitle = createTerminalTitleReporter();
