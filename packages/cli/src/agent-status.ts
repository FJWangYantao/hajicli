/**
 * 向终端上报「本程序当前在做什么」（OSC 7501 程序状态协议）。
 *
 * Kero（kero.sh）用它给侧栏的会话状态上色：working 显示转圈、blocked 显示等待、
 * done 亮未读、error 标失败；没有上报的程序只能靠屏幕特征猜，猜不到就一直 idle。
 * 协议本身对不认识它的终端是无害的零宽序列（iTerm2 / Windows Terminal 等直接忽略），
 * 所以判定为「可能在 Kero 后面」就发：$KERO_PANE（直接在 Kero 拉起的 shell 里），
 * 或 ssh 会话（KERO_PANE 不会跨 ssh 转发，但 OSC 字节会原样回到本机终端）。
 *
 * 报文格式（kero internal/daemon/osc.go 与 `kero report`）：
 *   ESC ] 7501 ; state=<idle|working|done|blocked|error|clear>[:kind=…][:app=…]
 *     [:progress=0-100][:title=<base64>][:msg=<base64>] ESC \
 * msg 解码后 ≤2048 字节、title ≤192 字节，含控制字符的整条报文会被丢弃。
 */
export type AgentStatusState = "idle" | "working" | "done" | "blocked" | "error" | "clear";

/** blocked 时用户被卡在哪一步；Kero 侧栏据此显示「需要授权 / 有问题」。 */
export type AgentBlockedKind = "permission" | "question" | "auth";

export interface AgentStatusReport {
  state: AgentStatusState;
  kind?: AgentBlockedKind;
  /** 侧栏正文：一句话说明当前在做什么。 */
  message?: string;
  /** 侧栏标题，省略时用 "haji"。 */
  title?: string;
  /** 0–100，仅 working / blocked 有效。 */
  progress?: number;
}

/** 协议对 msg / title 的上限（解码后字节数）。 */
const MAX_MESSAGE_BYTES = 2048;
const MAX_TITLE_BYTES = 192;

function sanitizeReportText(value: string, maxBytes: number): string | undefined {
  // 去掉控制字符（含换行、ESC）与零宽/双向控制符：协议要求可打印文本，
  // 而这些字符也会让侧栏显示错位。
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  const buffer = Buffer.from(cleaned, "utf8");
  if (buffer.length <= maxBytes) return cleaned;
  // 按字节截断会把一个中文字符劈开：退到字符边界再切。
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8").trim() || undefined;
}

/** 组装一条 OSC 7501 报文；非法字段（如 idle 带 progress）按协议直接省略。 */
export function buildStatusSequence(report: AgentStatusReport, app = "haji"): string {
  const pairs = [`state=${report.state}`];
  if (report.kind && report.state === "blocked") {
    pairs.push(`kind=${report.kind}`);
  }
  if (
    report.progress !== undefined &&
    Number.isInteger(report.progress) &&
    report.progress >= 0 &&
    report.progress <= 100 &&
    (report.state === "working" || report.state === "blocked")
  ) {
    pairs.push(`progress=${report.progress}`);
  }
  if (/^[A-Za-z0-9_.+-]{1,32}$/.test(app)) pairs.push(`app=${app}`);
  const title =
    report.title === undefined ? undefined : sanitizeReportText(report.title, MAX_TITLE_BYTES);
  if (title) pairs.push(`title=${Buffer.from(title, "utf8").toString("base64")}`);
  const message =
    report.message === undefined
      ? undefined
      : sanitizeReportText(report.message, MAX_MESSAGE_BYTES);
  if (message) pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/**
 * 是否向终端上报。判定为「可能在 Kero 后面」就开：
 * - `$KERO_PANE`：直接跑在 Kero 拉起的 shell 里；
 * - `$SSH_CONNECTION` / `$SSH_TTY`：ssh 不会转发 KERO_PANE（sshd 默认只收 LANG/LC_*），
 *   但 OSC 字节会经 ssh 原样回到本机终端，Kero 照样解析；tmux 在中间时可能被吞掉。
 * `HAJI_STATUS_REPORT=1` 强制开启、`=0` 关闭（两者都优先于上面的推断）。
 */
export function resolveStatusReportEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.HAJI_STATUS_REPORT ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return false;
  if (flag === "1" || flag === "on" || flag === "true") return true;
  if (env.KERO_PANE) return true;
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY);
}

export interface AgentStatusReporter {
  /** 当前进程是否会真的写报文。 */
  readonly enabled: boolean;
  /** 运行期开关：无头模式（-p）等不适合上报的场景由调用方关掉。 */
  setEnabled(enabled: boolean): void;
  report(report: AgentStatusReport): void;
  working(message?: string): void;
  /** @param kind 缺省为 permission */
  blocked(kind?: AgentBlockedKind, message?: string): void;
  done(message?: string): void;
  error(message?: string): void;
  idle(message?: string): void;
  clear(): void;
}

export interface AgentStatusReporterOptions {
  env?: NodeJS.ProcessEnv;
  /** 写报文的目标，默认 process.stdout：必须直接写窗格 tty，不能经 execFile 捕获。 */
  write?: (sequence: string) => void;
  /** stdout 是否是终端，默认读 process.stdout.isTTY。 */
  isTTY?: boolean;
  app?: string;
}

/**
 * 造一个上报器。同一条报文重复上报会被跳过（异步状态回调容易重复触发）。
 * 进程退出时 Kero 会自动清掉 working / blocked 记录，所以不需要 atexit 收尾。
 */
export function createAgentStatusReporter(
  options: AgentStatusReporterOptions = {},
): AgentStatusReporter {
  const env = options.env ?? process.env;
  const app = options.app ?? "haji";
  const write = options.write ?? ((sequence: string) => process.stdout.write(sequence));
  // 只写 tty：`haji -p --output-format json` 的 stdout 是给管道读的，
  // 在 Kero 窗格里跑时同样有 $KERO_PANE，不能把 OSC 混进 JSON。
  let enabled = resolveStatusReportEnabled(env) && (options.isTTY ?? Boolean(process.stdout.isTTY));

  let lastSequence = "";
  const send = (report: AgentStatusReport): void => {
    if (!enabled) return;
    const sequence = buildStatusSequence(report, app);
    if (sequence === lastSequence) return;
    lastSequence = sequence;
    try {
      write(sequence);
    } catch {
      // 终端已关闭 / EPIPE：状态上报失败不该影响主流程。
    }
  };
  return {
    get enabled() {
      return enabled;
    },
    setEnabled: (value) => {
      enabled = value;
    },
    report: send,
    working: (message) => send({ state: "working", message }),
    blocked: (kind = "permission", message) => send({ state: "blocked", kind, message }),
    done: (message) => send({ state: "done", message }),
    error: (message) => send({ state: "error", message }),
    idle: (message) => send({ state: "idle", message }),
    clear: () => send({ state: "clear" }),
  };
}

/** 进程级默认上报器（index.ts / turn-runner.ts 共用）。 */
export const agentStatus = createAgentStatusReporter();
