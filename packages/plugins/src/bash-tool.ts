import { type ChildProcess, exec, execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  BaseTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolMutationScope,
} from "@hajicli/core";

export type ShellKind = "bash" | "sh" | "powershell" | "cmd";

export interface ShellSpec {
  kind: ShellKind;
  /** 显式 shell 可执行文件；POSIX 交给 exec 的默认 shell 时为 undefined。 */
  file?: string;
  /** 拼在命令之前的固定参数（如 -c / -Command）。 */
  args: string[];
}

const POWERSHELL_SHELL: ShellSpec = {
  kind: "powershell",
  file: "powershell.exe",
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
};

const CMD_SHELL: ShellSpec = { kind: "cmd", file: "cmd.exe", args: ["/d", "/s", "/c"] };

/**
 * 找 Git Bash。Windows 自带的 `System32\bash.exe` 是 WSL，路径与文件系统语义都不同，
 * 不能拿来当本地 shell；这里只从 PATH 里带 "git" 的目录和常见 Git 安装位置推导。
 *
 * 路径一律按 Windows 语义解析（分隔符 `;`、`\`）：这段逻辑只服务 win32，
 * 在非 Windows 上运行测试或预览时也必须推出同样的候选路径。
 */
function findGitBash(
  env: NodeJS.ProcessEnv,
  fileExists: (candidate: string) => boolean,
): string | undefined {
  const override = env.HAJI_BASH_PATH?.trim();
  if (override && fileExists(override)) return override;

  const candidates: string[] = [];
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const entry of pathValue.split(";")) {
    if (!entry.trim() || !/git/i.test(entry)) continue;
    const root = path.win32.resolve(entry.trim(), "..");
    candidates.push(
      path.win32.join(root, "bin", "bash.exe"),
      path.win32.join(root, "usr", "bin", "bash.exe"),
      path.win32.join(root, "..", "bin", "bash.exe"),
      path.win32.join(root, "..", "usr", "bin", "bash.exe"),
    );
  }
  const programDirs = [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
    (value): value is string => Boolean(value),
  );
  if (env.LOCALAPPDATA) programDirs.push(path.win32.join(env.LOCALAPPDATA, "Programs"));
  for (const dir of programDirs) {
    candidates.push(path.win32.join(dir, "Git", "bin", "bash.exe"));
  }

  return candidates.find((candidate) => fileExists(candidate));
}

export interface ShellEnvironment {
  preferred: ShellSpec;
  /** 其他可用方言（有 Git Bash 时的 PowerShell/cmd 等），供按命令语法切换。 */
  alternatives: ShellSpec[];
}

/**
 * 探测可用 shell：Windows 优先 Git Bash（模型默认按 bash 语法写），
 * 没有则回退 PowerShell；cmd 始终作为候选，供识别到 cmd 语法时使用。
 * `HAJI_SHELL=cmd|powershell|bash` 可强制首选。
 */
export function resolveShellEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = existsSync,
): ShellEnvironment {
  if (platform !== "win32") {
    // POSIX 上有 bash 就用 bash（heredoc / [[ ]] 都能用），否则交给 exec 的默认 sh。
    const bash: ShellSpec | undefined = fileExists("/bin/bash")
      ? { kind: "bash", file: "/bin/bash", args: ["-c"] }
      : undefined;
    const sh: ShellSpec = { kind: "sh", args: [] };
    return { preferred: bash ?? sh, alternatives: bash ? [sh] : [] };
  }

  const bashPath = findGitBash(env, fileExists);
  const bash: ShellSpec | undefined = bashPath
    ? { kind: "bash", file: bashPath, args: ["-c"] }
    : undefined;
  const available = [bash, POWERSHELL_SHELL, CMD_SHELL].filter((spec): spec is ShellSpec =>
    Boolean(spec),
  );

  const forced = (env.HAJI_SHELL ?? "").trim().toLowerCase();
  const preferred =
    forced === "cmd"
      ? CMD_SHELL
      : forced === "powershell" || forced === "pwsh"
        ? POWERSHELL_SHELL
        : (bash ?? POWERSHELL_SHELL);

  return {
    preferred,
    alternatives: available.filter((spec) => spec.kind !== preferred.kind),
  };
}

/** 兼容入口：只取首选 shell。 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = existsSync,
): ShellSpec {
  return resolveShellEnvironment(platform, env, fileExists).preferred;
}

const DIALECT_HINTS: Record<ShellKind, string> = {
  bash: "bash 支持 heredoc、;、&&、$(...)",
  sh: "sh（POSIX shell）支持 heredoc、;、&&、$(...)",
  powershell: "PowerShell 用 ; 串联、多行用 here-string @'...'@（不支持 && 与 heredoc）",
  cmd: "cmd.exe 用 && 串联（不支持 heredoc、多行字符串与 ;）",
};

/** 单个 shell 的方言说明。 */
export function describeShell(shell: ShellSpec): string {
  return `在本地终端执行一条命令并返回控制台输出：${DIALECT_HINTS[shell.kind]}。`;
}

/** 工具描述：列出可用方言与自动选择规则，避免模型按错误语法重试。 */
export function describeEnvironment(environment: ShellEnvironment): string {
  const kinds = [
    ...new Set([environment.preferred, ...environment.alternatives].map((spec) => spec.kind)),
  ];
  return `在本地终端执行一条命令并返回控制台输出。会按命令语法自动选择 shell（当前可用：${kinds.join(" / ")}）：${kinds.map((kind) => DIALECT_HINTS[kind]).join("；")}。可用 shell 参数强制指定。`;
}

export type ShellDialect = Extract<ShellKind, "bash" | "powershell" | "cmd">;

const POWERSHELL_CMDLET_RE =
  /\b(?:Get|Set|New|Remove|Test|Select|Where|ForEach|Sort|Measure|Write|Start|Stop|Copy|Move|Rename|Invoke|Out|Import|Export|ConvertTo|ConvertFrom|Join|Split|Add|Clear|Update|Resolve|Push|Pop)-[A-Z][A-Za-z]+\b/;

const POWERSHELL_MARKERS: RegExp[] = [
  /\$env:[A-Za-z_]/i,
  /\$_(\b|\.)/,
  /-(?:ErrorAction|ErrorVariable|WarningAction|OutVariable|PipelineVariable)\b/i,
  POWERSHELL_CMDLET_RE,
  /\|\s*(?:Select|Where|ForEach|Sort|Measure|ConvertTo|Out)-[A-Z]/,
];

const BASH_MARKERS: RegExp[] = [
  /\$\{/,
  /\$\?/,
  /(?:^|[\n;&|])\s*(?:export|source|chmod|chown|sudo|apt|apt-get|brew|yum|dnf|pacman)\b/,
  /(?:^|[\n;&|])\s*(?:ls|cat|grep|sed|awk|find|xargs|rm|cp|mv|touch|mkdir|pwd|which|head|tail|wc|ln|basename|dirname)\b/,
];

const CMD_MARKERS: RegExp[] = [
  /%[A-Za-z_][A-Za-z0-9_]*%/,
  /(?:^|[\n;&|])\s*(?:dir|type|copy|del|erase|move|ren|rename|where|chcp|mklink|setlocal|endlocal|call|start)\b/i,
  />\s*nul\b/i,
];

/** 去掉引号里的内容：引号中的词是数据，不该决定 shell 方言。 */
function stripQuoted(command: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === "\\" && quote !== "'") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    result += char;
  }
  return result;
}

function countMatches(value: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    count += (value.match(new RegExp(pattern.source, flags)) ?? []).length;
  }
  return count;
}

/**
 * 按命令本身判断它属于哪种方言。只在有明确信号时返回结果：
 * heredoc / $(...) / [[ ]] 只有 POSIX shell 认，$env: / 谓词-名词 只有 PowerShell 认，
 * %VAR% / dir / type 一类则是 cmd 的写法。
 */
export function detectShellDialect(command: string): ShellDialect | undefined {
  if (!command.trim()) return undefined;
  const code = stripQuoted(command);
  // heredoc 与 [[ ]] 是 POSIX shell 独有的结构，内容里出现别的词也不改变这一点。
  if (/<<-?\s*['"]?[A-Za-z_]/.test(command) || /\[\[/.test(command)) return "bash";
  // here-string 与 $env:/[System.] 是 PowerShell 独有写法。
  if (/@['"]\s*\n/.test(command) || /\$env:|\$PSVersionTable|\[System\./i.test(code)) {
    return "powershell";
  }
  // $(...) 两种 shell 都有，先看里面是不是 PowerShell 谓词-名词。
  if (POWERSHELL_CMDLET_RE.test(code)) return "powershell";
  if (/\$\(/.test(code)) return "bash";

  const powershell = countMatches(code, POWERSHELL_MARKERS);
  const bash = countMatches(code, BASH_MARKERS);
  const cmd = countMatches(code, CMD_MARKERS);

  if (powershell > 0 && powershell >= bash) return "powershell";
  if (bash > powershell && bash >= cmd) return "bash";
  if (cmd > Math.max(powershell, bash)) return "cmd";
  return undefined;
}

/** 选中执行命令的 shell：显式指定 > 命令方言 > 环境首选。 */
export function selectShell(
  environment: ShellEnvironment,
  command: string,
  override?: string,
): ShellSpec {
  const available = [environment.preferred, ...environment.alternatives];
  if (override) {
    const explicit = available.find((spec) => spec.kind === override);
    if (explicit) return explicit;
  }
  const dialect = detectShellDialect(command);
  if (dialect) {
    const match = available.find((spec) => spec.kind === dialect);
    if (match) return match;
  }
  // Windows PowerShell 5.1 不支持 && / ||：首选是 PowerShell 时交给 cmd。
  if (environment.preferred.kind === "powershell" && /&&|\|\|/.test(stripQuoted(command))) {
    const cmd = available.find((spec) => spec.kind === "cmd");
    if (cmd) return cmd;
  }
  return environment.preferred;
}

const DEFAULT_ENVIRONMENT = resolveShellEnvironment();

/**
 * 显式 shell 用 execFile 传 argv，命令作为单个参数原样交给 shell，
 * 不再经过 cmd.exe 的引号/换行重写——多行提交信息因此能直接写。
 */
function createCommandLauncher(shell: ShellSpec): typeof exec {
  if (!shell.file) return exec;
  const file = shell.file;
  const args = shell.args;
  const launch = (command: string, options: unknown, callback: unknown): ChildProcess =>
    execFile(
      file,
      [...args, command],
      { ...(options as object), windowsHide: true },
      callback as (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
    );
  return launch as unknown as typeof exec;
}

class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalLength = 0;

  constructor(
    private readonly headLimit = 1_000,
    private readonly tailLimit = 2_500,
  ) {}

  append(value: string): void {
    if (!value) return;
    this.totalLength += value.length;
    let remaining = value;
    if (this.head.length < this.headLimit) {
      const accepted = remaining.slice(0, this.headLimit - this.head.length);
      this.head += accepted;
      remaining = remaining.slice(accepted.length);
    }
    if (remaining) this.tail = `${this.tail}${remaining}`.slice(-this.tailLimit);
  }

  render(): string {
    const omitted = Math.max(0, this.totalLength - this.head.length - this.tail.length);
    if (omitted === 0) return `${this.head}${this.tail}`;
    return `${this.head}\n[中间省略 ${omitted} 个字符]\n${this.tail}`;
  }
}

/** Windows 控制台代码页 → WHATWG 编码名（TextDecoder 认得的那些）。 */
const CODE_PAGE_ENCODINGS: Record<number, string> = {
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  54936: "gb18030",
};

/** 控制台是 UTF-8（chcp 65001）或查不到代码页时，按系统语言猜本地编码。 */
function localeEncoding(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (/^zh-(?:tw|hk|mo)|^zh-hant/.test(locale)) return "big5";
  if (locale.startsWith("zh")) return "gbk";
  if (locale.startsWith("ja")) return "shift_jis";
  if (locale.startsWith("ko")) return "euc-kr";
  if (locale.startsWith("ru")) return "windows-1251";
  return "windows-1252";
}

let cachedLegacyEncoding: string | undefined;

/**
 * Windows 上 cmd 内建命令（dir 等）和不少老程序按控制台代码页输出（中文系统是 GBK），
 * 按 UTF-8 解码就是一串 �。只在真遇到非法 UTF-8 时才查一次 chcp，正常输出不多起进程。
 * 其他平台返回 undefined（继续按 UTF-8，坏字节换成 �）。
 */
export function detectLegacyEncoding(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (cachedLegacyEncoding) return cachedLegacyEncoding;
  let codePage: number | undefined;
  try {
    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "chcp"], {
      encoding: "latin1",
      timeout: 2000,
      windowsHide: true,
    });
    const match = String(result.stdout || "").match(/(\d+)\s*$/);
    if (match) codePage = Number(match[1]);
  } catch {
    // 查不到就按系统语言猜。
  }
  cachedLegacyEncoding =
    (codePage !== undefined ? CODE_PAGE_ENCODINGS[codePage] : undefined) || localeEncoding();
  return cachedLegacyEncoding;
}

/** 末尾有几个字节是「还没收全的 UTF-8 多字节序列」，留到下一块再解。 */
function incompleteUtf8Tail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    if (byte < 0xc0) return 0;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return needed > back ? back : 0;
  }
  return 0;
}

/**
 * 命令输出的流式解码：先按 UTF-8（严格），一旦出现非法字节就整条流改用本地编码
 * （之前解出来的多半是 ASCII，两种编码下一样）。块边界切断的多字节字符留到下一块。
 */
export class CommandOutputDecoder {
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private legacy?: TextDecoder;
  private carry: Uint8Array = new Uint8Array(0);

  constructor(private readonly resolveLegacy: () => string | undefined = detectLegacyEncoding) {}

  write(chunk: Uint8Array | string): string {
    if (typeof chunk === "string") return chunk;
    if (this.legacy) return this.legacy.decode(chunk, { stream: true });
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const cut = incompleteUtf8Tail(data);
    try {
      const text = this.utf8.decode(data.subarray(0, data.length - cut));
      this.carry = data.slice(data.length - cut);
      return text;
    } catch {
      this.carry = new Uint8Array(0);
      this.legacy = createLegacyDecoder(this.resolveLegacy());
      return this.legacy.decode(data, { stream: true });
    }
  }

  end(): string {
    if (this.legacy) return this.legacy.decode();
    if (!this.carry.length) return "";
    const rest = this.carry;
    this.carry = new Uint8Array(0);
    try {
      return this.utf8.decode(rest);
    } catch {
      return createLegacyDecoder(this.resolveLegacy()).decode(rest);
    }
  }
}

function createLegacyDecoder(encoding: string | undefined): TextDecoder {
  if (encoding) {
    try {
      return new TextDecoder(encoding);
    } catch {
      // Node 没带完整 ICU 时不认识这个编码，退回宽松 UTF-8。
    }
  }
  return new TextDecoder("utf-8");
}

/** 一次性解完整段输出。 */
function decodeWhole(value: Uint8Array | string): string {
  const decoder = new CommandOutputDecoder();
  return decoder.write(value) + decoder.end();
}

/**
 * 只对无法组合其他命令、且没有输出重定向的白名单查询命令跳过工作区快照。
 * 任何不确定命令都按 workspace 处理，宁可多做一次快照也不漏记修改。
 */
export function classifyBashMutationScope(command: string): ToolMutationScope {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized || /[;&|><`\r\n]/.test(command) || /\$\(/.test(command)) return "workspace";
  if (/\s--output(?:=|\s|$)/.test(normalized)) return "workspace";

  if (/^git (?:status|diff|log|show|rev-parse|ls-files)(?:\s|$)/.test(normalized)) return "none";
  if (/^(?:rg|ripgrep)(?:\s|$)/.test(normalized) && !/\s--pre(?:=|\s|$)/.test(normalized))
    return "none";
  if (/^(?:dir|type|where(?:\.exe)?|findstr)(?:\s|$)/.test(normalized)) return "none";
  if (
    /^(?:get-childitem|get-item|get-content|select-string|test-path|resolve-path)(?:\s|$)/.test(
      normalized,
    )
  )
    return "none";
  return "workspace";
}

/**
 * 终端命令执行工具。
 */
export class BashTool implements BaseTool {
  public readonly name = "bash";

  public readonly definition: ToolDefinition;

  private readonly environment: ShellEnvironment;
  private readonly launchers = new Map<ShellKind, typeof exec>();
  private readonly fileExecutor: typeof execFile;
  private readonly processKiller: (pid: number, signal: NodeJS.Signals) => boolean;
  /** 中止时的进程树清理按平台分派；可注入，便于在任意平台上验证 win32 分支。 */
  private readonly platform: NodeJS.Platform;

  /** 可注入执行器，便于验证 Windows 进程清理失败的兜底路径。 */
  constructor(
    commandExecutor?: typeof exec,
    fileExecutor: typeof execFile = execFile,
    processKiller: (pid: number, signal: NodeJS.Signals) => boolean = (pid, signal) =>
      process.kill(pid, signal),
    environment: ShellEnvironment = DEFAULT_ENVIRONMENT,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.environment = environment;
    this.fileExecutor = fileExecutor;
    this.processKiller = processKiller;
    this.platform = platform;
    for (const spec of [environment.preferred, ...environment.alternatives]) {
      this.launchers.set(
        spec.kind,
        spec.kind === environment.preferred.kind && commandExecutor
          ? commandExecutor
          : createCommandLauncher(spec),
      );
    }

    const kinds = [...this.launchers.keys()];
    this.definition = {
      type: "function",
      function: {
        name: "bash",
        description: describeEnvironment(environment),
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "要在终端运行的完整命令行指令。",
            },
            timeoutMs: {
              type: "number",
              description: "可选超时，1000-600000 毫秒；超时后清理命令进程树。",
            },
            shell: {
              type: "string",
              enum: kinds,
              description: "可选：强制指定 shell 方言；默认按命令语法自动选择。",
            },
          },
          required: ["command"],
        },
      },
    };
  }

  public getMutationScope(args: Record<string, unknown>): ToolMutationScope {
    return classifyBashMutationScope(typeof args.command === "string" ? args.command : "");
  }

  /**
   * 执行 Bash 命令。
   * @param args 包含命令参数的对象。
   */
  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const command = args.command as string;
    if (!command) {
      return "错误: 缺少 command 参数。";
    }
    const timeoutMs = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs);
    if (
      timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)
    ) {
      return "错误: timeoutMs 必须是 1000 到 600000 之间的整数。";
    }

    if (args.shell !== undefined && typeof args.shell !== "string") {
      return "错误: shell 参数必须是字符串。";
    }
    const override = typeof args.shell === "string" ? args.shell.trim() : undefined;
    const selected = selectShell(this.environment, command, override);
    if (override && selected.kind !== override) {
      return `错误: 当前环境不支持 shell "${override}"（可用：${[...this.launchers.keys()].join(" / ")}）。`;
    }
    const launcher = this.launchers.get(selected.kind) ?? createCommandLauncher(selected);

    if (context?.abortSignal?.aborted) return "[命令已中止]";

    return new Promise<string>((resolve) => {
      let settled = false;
      let aborting = false;
      let terminationReason: "abort" | "timeout" = "abort";
      let child: ChildProcess | undefined;
      let abort = () => {};
      let timeout: NodeJS.Timeout | undefined;
      const startedAt = Date.now();
      const stdoutBuffer = new HeadTailBuffer();
      const stderrBuffer = new HeadTailBuffer();
      const stdoutDecoder = new CommandOutputDecoder();
      const stderrDecoder = new CommandOutputDecoder();
      let sawStdoutChunk = false;
      let sawStderrChunk = false;
      const terminationLabel = () =>
        terminationReason === "timeout" ? `[命令执行超时 - ${timeoutMs}ms]` : "[命令已中止]";
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        context?.abortSignal?.removeEventListener("abort", abort);
        child = undefined;
        resolve(value);
      };
      // 允许使用 10MB 的缓冲区，防止长输出崩掉；按字节收，自己解码（见 CommandOutputDecoder）。
      child = launcher(
        command,
        { maxBuffer: 1024 * 1024 * 10, encoding: "buffer" },
        (error, stdout, stderr) => {
          if (context?.abortSignal?.aborted) {
            if (!aborting) abort();
            return;
          }
          if (aborting) return;
          const exitCode = error ? (error.code ?? 1) : 0;
          if (sawStdoutChunk) stdoutBuffer.append(stdoutDecoder.end());
          else if (stdout) stdoutBuffer.append(decodeWhole(stdout));
          if (sawStderrChunk) stderrBuffer.append(stderrDecoder.end());
          else if (stderr) stderrBuffer.append(decodeWhole(stderr));
          const boundedStdout = stdoutBuffer.render();
          const boundedStderr = stderrBuffer.render();
          const durationMs = Date.now() - startedAt;

          let result = `[命令执行结果 - 退出码 ${exitCode}；耗时 ${durationMs}ms]\n`;
          if (boundedStdout) {
            result += `--- 标准输出 (stdout，保留头尾) ---\n${boundedStdout}\n`;
          }
          if (boundedStderr) {
            result += `--- 标准错误 (stderr，保留头尾) ---\n${boundedStderr}\n`;
          }
          if (!boundedStdout && !boundedStderr) {
            result += `(命令执行完成，无控制台输出)\n`;
          }
          finish(result);
        },
      );
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (!settled) {
          sawStdoutChunk = true;
          const text = stdoutDecoder.write(chunk);
          stdoutBuffer.append(text);
          if (text) context?.onProgress?.({ type: "stdout", chunk: text });
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (!settled) {
          sawStderrChunk = true;
          const text = stderrDecoder.write(chunk);
          stderrBuffer.append(text);
          if (text) context?.onProgress?.({ type: "stderr", chunk: text });
        }
      });

      abort = () => {
        if (settled || aborting) return;
        aborting = true;
        const runningChild = child;
        // 立即返回中止标记：进程树清理转入后台尽力执行，终止提示不等待杀进程完成。
        finish(terminationLabel());
        if (!runningChild || runningChild.exitCode !== null) return;

        if (runningChild.pid && this.platform === "win32") {
          const rootPid = runningChild.pid;
          const processTreeType = [
            "using System;",
            "using System.Collections.Generic;",
            "using System.Runtime.InteropServices;",
            "public static class HajiProcessTree {",
            "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
            "  private struct PROCESSENTRY32 {",
            "    public uint dwSize; public uint cntUsage; public uint th32ProcessID;",
            "    public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads;",
            "    public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;",
            "    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;",
            "  }",
            '  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);',
            '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);',
            '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);',
            '  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);',
            "  public static int[] Descendants(int rootPid) {",
            "    var relations = new List<Tuple<int, int>>();",
            "    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);",
            "    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());",
            "    try {",
            "      var entry = new PROCESSENTRY32(); entry.dwSize = (uint)Marshal.SizeOf(entry);",
            "      if (Process32FirstW(snapshot, ref entry)) {",
            "        do { relations.Add(Tuple.Create((int)entry.th32ProcessID, (int)entry.th32ParentProcessID)); }",
            "        while (Process32NextW(snapshot, ref entry));",
            "      }",
            "    } finally { CloseHandle(snapshot); }",
            "    var result = new List<int>(); var frontier = new List<int> { rootPid };",
            "    while (frontier.Count > 0) {",
            "      var next = new List<int>();",
            "      foreach (var relation in relations) if (frontier.Contains(relation.Item2)) { next.Add(relation.Item1); result.Add(relation.Item1); }",
            "      frontier = next;",
            "    }",
            "    result.Reverse(); return result.ToArray();",
            "  }",
            "}",
          ].join(" ");
          const cleanupScript = [
            "$ErrorActionPreference = 'Stop'",
            `$rootProcessId = ${rootPid}`,
            `$typeDefinition = '${processTreeType}'`,
            "Add-Type -TypeDefinition $typeDefinition",
            "Write-Output ([HajiProcessTree]::Descendants($rootProcessId) -join ',')",
          ].join("; ");

          // 优先调用系统原生 taskkill。只有失败时才启动较慢的进程树枚举，避免 ESC 被 PowerShell 编译阻塞。
          this.fileExecutor(
            "taskkill.exe",
            ["/PID", String(rootPid), "/T", "/F"],
            { windowsHide: true, timeout: 3000 },
            (taskkillError) => {
              if (!taskkillError) return;
              this.fileExecutor(
                "powershell.exe",
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cleanupScript],
                { windowsHide: true, timeout: 5000 },
                (enumerationError, stdout) => {
                  const descendantIds = enumerationError
                    ? []
                    : String(stdout || "")
                        .trim()
                        .split(",")
                        .map((value) => Number(value.trim()))
                        .filter((value) => Number.isInteger(value) && value > 0);
                  for (const descendantId of descendantIds) {
                    try {
                      this.processKiller(descendantId, "SIGTERM");
                    } catch {
                      // 后台兜底清理是尽力而为：进程已退出或信号失败都不再上报。
                    }
                  }
                  runningChild.kill("SIGTERM");
                },
              );
            },
          );
          return;
        }

        runningChild.kill("SIGTERM");
      };
      context?.abortSignal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          terminationReason = "timeout";
          abort();
        }, timeoutMs);
        timeout.unref?.();
      }
      if (context?.abortSignal?.aborted) abort();
    });
  }
}
