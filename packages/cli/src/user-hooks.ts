/**
 * 用户可配置的生命周期 Hook：把 `hooks.json` 里的 shell 命令挂到 core 的 HookEngine 上。
 *
 * 配置两级：
 * - 用户级 `~/.haji/hooks.json`：用户自己写的，直接生效；
 * - 项目级 `<cwd>/.haji/hooks.json`：可能随仓库克隆而来，**按内容哈希信任**后才执行
 *   （`/hooks trust` 记到用户级 `~/.haji/hooks-trust.json`，文件一改就要重新信任）。
 *   CI 可设 `HAJI_TRUST_PROJECT_HOOKS=1` 显式信任。
 *
 * 语义（退出码 2 = 拦截 / 回注，与常见 agent CLI 的约定一致）：
 * - PreToolUse：退出码 2 拦下这次工具调用，stderr（或 stdout）作为原因回给模型；
 *   其他非 0 / 超时只告警、不拦截。Hook 只能拦，不能替用户放行——放行仍走权限引擎。
 * - PostToolUse：退出码 2 时 stderr 作为一条反馈注入会话（例如 lint 失败）；工具被拦下时不跑。
 * - UserPromptSubmit：退出码 0 且 stdout 非空时，stdout 作为补充上下文注入本轮。
 * - Stop：退出前执行（通知、清理），结果只在失败时告警。
 *
 * 每次执行把上下文 JSON 写到 stdin，另设 `HAJI_HOOK_EVENT` / `HAJI_TOOL_NAME` /
 * `HAJI_TOOL_PATH` / `HAJI_PROJECT_DIR` / `HAJI_SESSION_ID` 环境变量方便单行命令取用。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookContext, HookEngine, HookEvent } from "@hajicli/core";
import { workspaceProjectKey } from "./workspace-roots.js";

export const USER_HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
];

export type UserHookScope = "user" | "project";

export interface UserHookEntry {
  event: HookEvent;
  command: string;
  /** 工具名正则（整名匹配、不分大小写）；缺省或 `*` 匹配全部。只对工具类事件有意义。 */
  matcher?: string;
  timeoutMs: number;
  scope: UserHookScope;
}

export interface ParsedHooksFile {
  entries: UserHookEntry[];
  errors: string[];
}

export interface ProjectHooksState extends ParsedHooksFile {
  path: string;
  hash: string;
  trusted: boolean;
}

export interface LoadedUserHooks {
  user: ParsedHooksFile;
  /** 项目级文件不存在时为 undefined。 */
  project?: ProjectHooksState;
  /** 实际生效的条目：用户级 + 已信任的项目级。 */
  active: UserHookEntry[];
}

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_TIMEOUT_MS = 600_000;
/** stdout / stderr 各自保留的字符上限，回注上下文前再按用途截短。 */
const MAX_CAPTURE_CHARS = 16_000;
/** 注入会话的 hook 文本上限，防止一个啰嗦脚本撑爆上下文。 */
const MAX_INJECT_CHARS = 4_000;
const MAX_PAYLOAD_OUTPUT_CHARS = 20_000;

export function userHooksPath(): string {
  return path.join(os.homedir(), ".haji", "hooks.json");
}

export function projectHooksPath(cwd: string = process.cwd()): string {
  return path.join(cwd, ".haji", "hooks.json");
}

export function hooksTrustPath(): string {
  return path.join(os.homedir(), ".haji", "hooks-trust.json");
}

export function hashHooksContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isHookEvent(value: string): value is HookEvent {
  return (USER_HOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * 解析 hooks.json：`{ "<事件>": [{ command, matcher?, timeoutMs? }] }`，也接受外面再包一层 `hooks`。
 * 坏条目跳过并记一条错误，好条目照常生效。
 */
export function parseHooksFile(text: string, scope: UserHookScope): ParsedHooksFile {
  const entries: UserHookEntry[] = [];
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { entries, errors: [`JSON 解析失败：${(error as Error).message}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { entries, errors: ['顶层应为对象：{ "PreToolUse": [ … ] }'] };
  }
  const root = parsed as Record<string, unknown>;
  const table =
    root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : root;
  for (const [event, list] of Object.entries(table)) {
    if (!isHookEvent(event)) {
      errors.push(`未知事件 ${event}（可选：${USER_HOOK_EVENTS.join(" / ")}）`);
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(`${event} 应为数组`);
      continue;
    }
    list.forEach((item, index) => {
      const where = `${event}[${index}]`;
      if (!item || typeof item !== "object") {
        errors.push(`${where} 应为对象`);
        return;
      }
      const raw = item as Record<string, unknown>;
      const command = typeof raw.command === "string" ? raw.command.trim() : "";
      if (!command) {
        errors.push(`${where} 缺少 command`);
        return;
      }
      let matcher: string | undefined;
      if (raw.matcher !== undefined) {
        if (typeof raw.matcher !== "string") {
          errors.push(`${where}.matcher 应为字符串`);
          return;
        }
        matcher = raw.matcher.trim() || undefined;
        if (matcher && matcher !== "*") {
          try {
            new RegExp(`^(?:${matcher})$`, "i");
          } catch {
            errors.push(`${where}.matcher 不是合法正则：${matcher}`);
            return;
          }
        }
      }
      let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
      if (raw.timeoutMs !== undefined) {
        const value = Number(raw.timeoutMs);
        if (!Number.isFinite(value) || value <= 0 || value > MAX_HOOK_TIMEOUT_MS) {
          errors.push(`${where}.timeoutMs 应为 1–${MAX_HOOK_TIMEOUT_MS} 之间的毫秒数`);
          return;
        }
        timeoutMs = Math.floor(value);
      }
      entries.push({ event, command, ...(matcher ? { matcher } : {}), timeoutMs, scope });
    });
  }
  return { entries, errors };
}

interface TrustFile {
  version: 1;
  projects: Record<string, string>;
}

function readTrustFile(): TrustFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksTrustPath(), "utf8")) as Partial<TrustFile>;
    if (parsed?.projects && typeof parsed.projects === "object") {
      return { version: 1, projects: { ...parsed.projects } };
    }
  } catch {
    // 不存在或损坏：按「什么都没信任」处理
  }
  return { version: 1, projects: {} };
}

export function isProjectHooksTrusted(cwd: string, hash: string): boolean {
  return readTrustFile().projects[workspaceProjectKey(cwd)] === hash;
}

/** 记住「这个项目的这一版 hooks.json 可信」；写失败返回 false。 */
export function trustProjectHooks(cwd: string, hash: string): boolean {
  const file = readTrustFile();
  file.projects[workspaceProjectKey(cwd)] = hash;
  try {
    fs.mkdirSync(path.dirname(hooksTrustPath()), { recursive: true });
    fs.writeFileSync(hooksTrustPath(), `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function readOptional(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function loadUserHooks(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): LoadedUserHooks {
  const userText = readOptional(userHooksPath());
  const user =
    userText === undefined ? { entries: [], errors: [] } : parseHooksFile(userText, "user");
  const projectFile = projectHooksPath(cwd);
  // 项目目录就是 home 时两级是同一个文件，不重复加载。
  const projectText =
    path.resolve(projectFile) === path.resolve(userHooksPath())
      ? undefined
      : readOptional(projectFile);
  let project: ProjectHooksState | undefined;
  if (projectText !== undefined) {
    const hash = hashHooksContent(projectText);
    const trusted = env.HAJI_TRUST_PROJECT_HOOKS === "1" || isProjectHooksTrusted(cwd, hash);
    project = { ...parseHooksFile(projectText, "project"), path: projectFile, hash, trusted };
  }
  return {
    user,
    project,
    active: [...user.entries, ...(project?.trusted ? project.entries : [])],
  };
}

export function hookMatchesTool(entry: UserHookEntry, toolName: string | undefined): boolean {
  if (!entry.matcher || entry.matcher === "*") return true;
  if (!toolName) return false;
  return new RegExp(`^(?:${entry.matcher})$`, "i").test(toolName);
}

export interface HookRunResult {
  /** 进程退出码；被信号杀掉或没能启动时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 启动失败等异常（命令不存在通常表现为退出码 127，不在这里）。 */
  error?: string;
}

export interface HookRunOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** 用系统 shell 跑一条 hook 命令：stdin 写入上下文 JSON，超时或中止时连同子进程组一起杀掉。 */
export function runHookCommand(
  command: string,
  stdinPayload: string,
  options: HookRunOptions,
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const posix = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: true,
        // POSIX 下独立进程组：超时时 kill(-pid) 连孙进程一起收掉。
        detached: posix,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout, stderr, timedOut, error: (error as Error).message });
      return;
    }
    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // 已退出
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: HookRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code) => {
      finish({
        code,
        stdout: stdout.slice(0, MAX_CAPTURE_CHARS),
        stderr: stderr.slice(0, MAX_CAPTURE_CHARS),
        timedOut,
      });
    });
    // 不读 stdin 的脚本会让写入报 EPIPE，忽略即可。
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdinPayload);
  });
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n…（已截断）` : trimmed;
}

function lastUserPrompt(ctx: HookContext): string | undefined {
  const messages = ctx.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string") return message.content;
  }
  return undefined;
}

export function buildHookPayload(event: HookEvent, ctx: HookContext, cwd: string): string {
  const output = ctx.toolOutput;
  return JSON.stringify({
    event,
    cwd,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.toolName ? { toolName: ctx.toolName } : {}),
    ...(ctx.args ? { args: ctx.args } : {}),
    ...(output !== undefined ? { toolOutput: output.slice(0, MAX_PAYLOAD_OUTPUT_CHARS) } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(event === "UserPromptSubmit" ? { prompt: lastUserPrompt(ctx) ?? "" } : {}),
  });
}

export interface UserHookRunnerOptions {
  /** 失败、超时这类不拦截的问题给用户看（同一条命令同类问题只提示一次）。 */
  warn(message: string): void;
  /** 往会话注入一条 hook 文本（PostToolUse 反馈 / UserPromptSubmit 上下文）。 */
  inject(content: string, event: HookEvent, ctx: HookContext): void;
  /** 当前会话 id（环境变量与 payload 用）。 */
  getSessionId?(): string | undefined;
  /** 测试注入执行器。 */
  run?: typeof runHookCommand;
}

/**
 * 持有当前生效的 hook 集合并负责执行。集合可 `reload()`（/hooks trust、切工作树后），
 * 处理器只注册一次、每次触发读最新集合。
 */
export class UserHookRunner {
  private loaded: LoadedUserHooks = { user: { entries: [], errors: [] }, active: [] };
  private readonly warned = new Set<string>();

  constructor(private readonly options: UserHookRunnerOptions) {}

  reload(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): LoadedUserHooks {
    this.loaded = loadUserHooks(cwd, env);
    return this.loaded;
  }

  getLoaded(): LoadedUserHooks {
    return this.loaded;
  }

  /**
   * 把四个事件的分发器挂到引擎上。PreToolUse 必须在权限引擎之前注册（拦下了就不必再弹授权卡），
   * 其余事件只产生副作用、不返回值，不会截断后面的内置处理器。
   */
  registerPreToolUse(engine: HookEngine): void {
    engine.register("PreToolUse", (ctx) => this.dispatch("PreToolUse", ctx));
  }

  registerAfterBuiltins(engine: HookEngine): void {
    for (const event of ["PostToolUse", "UserPromptSubmit", "Stop"] as const) {
      engine.register(event, async (ctx) => {
        await this.dispatch(event, ctx);
      });
    }
  }

  async dispatch(event: HookEvent, ctx: HookContext): Promise<string | null> {
    const entries = this.loaded.active.filter((entry) => entry.event === event);
    if (entries.length === 0) return null;
    // 被拦下的工具调用没有真正执行，PostToolUse 的格式化/检查类脚本不该跑。
    if (event === "PostToolUse" && ctx.blocked) return null;
    const isToolEvent = event === "PreToolUse" || event === "PostToolUse";
    const cwd = ctx.cwd ?? process.cwd();
    const sessionId = ctx.sessionId ?? this.options.getSessionId?.();
    const payloadCtx = sessionId ? { ...ctx, sessionId } : ctx;
    const payload = buildHookPayload(event, payloadCtx, cwd);
    const toolPath = typeof ctx.args?.path === "string" ? path.resolve(cwd, ctx.args.path) : "";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HAJI_HOOK_EVENT: event,
      HAJI_PROJECT_DIR: cwd,
      HAJI_TOOL_NAME: ctx.toolName ?? "",
      HAJI_TOOL_PATH: toolPath,
      HAJI_SESSION_ID: sessionId ?? "",
    };
    const run = this.options.run ?? runHookCommand;
    for (const entry of entries) {
      if (isToolEvent && !hookMatchesTool(entry, ctx.toolName)) continue;
      if (ctx.abortSignal?.aborted) return null;
      const result = await run(entry.command, payload, {
        cwd,
        timeoutMs: entry.timeoutMs,
        env,
        signal: ctx.abortSignal,
      });
      const label = describeHook(entry);
      if (result.code === 2) {
        const message = clip(result.stderr || result.stdout, MAX_INJECT_CHARS);
        if (event === "PreToolUse") {
          return `[Hook 拦截] 工具 "${ctx.toolName}" 未执行（${label}）。原因：${message || "hook 以退出码 2 拦截"}\n按原因调整做法，不要原样重试。`;
        }
        if (event === "PostToolUse") {
          if (message) this.options.inject(`[Hook 反馈 · ${label}]\n${message}`, event, ctx);
          continue;
        }
      }
      if (result.code === 0) {
        if (event === "UserPromptSubmit") {
          const context = clip(result.stdout, MAX_INJECT_CHARS);
          if (context) this.options.inject(`[Hook 上下文 · ${label}]\n${context}`, event, ctx);
        }
        continue;
      }
      if (ctx.abortSignal?.aborted) return null;
      const problem = result.timedOut
        ? `超时（${entry.timeoutMs}ms）`
        : result.error
          ? `启动失败：${result.error}`
          : `退出码 ${result.code ?? "null"}${result.stderr.trim() ? `：${clip(result.stderr, 200)}` : ""}`;
      this.warnOnce(
        `${entry.scope}:${entry.event}:${entry.command}:${problem}`,
        `${label} ${problem}`,
      );
    }
    return null;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.warn(`Hook ${message}（不拦截，本会话同类问题不再提示）`);
  }
}

export function describeHook(entry: UserHookEntry): string {
  const matcher = entry.matcher && entry.matcher !== "*" ? `[${entry.matcher}]` : "";
  const command = entry.command.length > 60 ? `${entry.command.slice(0, 59)}…` : entry.command;
  return `${entry.event}${matcher} ${command}`;
}
