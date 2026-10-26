import fs from "node:fs";
import path from "node:path";
import {
  type AutoJudge,
  buildActionSection,
  buildSystemPrompt,
  buildUserSection,
  hardBlock,
  parseDecision,
} from "./auto-classifier.js";
import {
  formatPathScopeReason,
  inspectPathScope,
  type PathScopeConfig,
  type PathScopeGrant,
} from "./path-scope.js";
import {
  formatProtectedReason,
  inspectProtectedTarget,
  type ProtectedLevel,
  protectedTargetsDisabled,
} from "./protected-targets.js";
import { type RiskLevel, SecurityClassifier } from "./security-classifier.js";
import { HajiError } from "./types.js";

/**
 * 权限控制模式。
 * - default: 只读自动批，编辑和脚本交互需要审批
 * - accept-edit: 在 default 基础上，文件 write/edit 默认自动通过，bash 需要审批
 * - auto: 分类器结合用户意图与危险阈值自动评估安全性，若不安全则拒绝并输出理由给 Runtime
 * - bypass-permissions: 全信任模式，不做任何审批
 */
export type PermissionMode = "plan" | "default" | "accept-edit" | "auto" | "bypass-permissions";

/**
 * 权限模式列表与中文描述。
 */
export const PERMISSION_MODES: Array<{
  value: PermissionMode;
  label: string;
  description: string;
}> = [
  { value: "plan", label: "Plan", description: "只允许调研与制定计划，批准后才进入实施阶段" },
  { value: "default", label: "Default", description: "只读命令自动通过，编辑/脚本需要审批" },
  {
    value: "accept-edit",
    label: "Accept Edit",
    description: "只读与文件编辑自动通过，bash 脚本需要审批",
  },
  {
    value: "auto",
    label: "Auto Classifier",
    description: "LLM 结合用户意图判定：常规操作自动放行，越界或危险操作拦截并说明原因",
  },
  {
    value: "bypass-permissions",
    label: "Bypass Permissions",
    description: "全信任模式，接受所有命令无需审批",
  },
];

/**
 * 校验输入字符串是否为有效的权限模式。
 */
export function isPermissionMode(mode: string | undefined): mode is PermissionMode {
  return Boolean(mode && PERMISSION_MODES.some((m) => m.value === mode));
}

/** 新会话的默认权限档：LLM 自动分类器（用户显式保存的偏好仍然优先）。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

/**
 * 权限检查动作。
 * - allow: 直接批准执行
 * - prompt: 弹窗/终端询问用户授权
 * - deny: 自动拒绝执行
 */
export type PermissionAction = "allow" | "prompt" | "deny";

/**
 * 权限评估结果接口。
 */
export interface PermissionCheckResult {
  action: PermissionAction;
  reason?: string;
  riskLevel?: RiskLevel;
  /** 工作区外操作对应的授权范围（授权卡据此给出「本会话/永久允许 该目录」）。 */
  grant?: PathScopeGrant;
  /**
   * 命中受保护目标时的级别：
   * - hard 不接受永久授权，也不能被持久放行规则命中；
   * - sensitive 允许用户按会话或全局记住。
   */
  protectedLevel?: ProtectedLevel;
}

/**
 * 权限评估参数接口。
 */
export interface PermissionEvaluateOptions {
  mode: PermissionMode;
  toolName: string;
  args: Record<string, unknown>;
  userIntent?: string;
  /** 本会话用户说过的话（从早到晚）；缺省退回 `userIntent` 单条。 */
  userMessages?: readonly string[];
  riskThreshold?: RiskLevel;
  /** 发起本次调用的工具调用 id；透传进判定事件供 UI 定位工具格。 */
  toolCallId?: string;
  /** 用户中止当前回合时透传，用于取消分类器调用。 */
  abortSignal?: AbortSignal;
}

/** Auto 分类器的一次判定进度（供 UI 展示「判定中 / 已放行 / 已拦截」）。 */
export interface AutoJudgeEvent {
  phase: "start" | "done";
  toolName: string;
  /** 触发判定的工具调用 id；UI 用它把判定状态挂到对应工具格上。 */
  toolCallId?: string;
  /** 判定来源：模型分类器、确定性硬熔断、未注入分类器时的规则回退。 */
  source: "classifier" | "hard-block" | "fallback" | "error";
  allowed?: boolean;
  reason?: string;
  durationMs?: number;
}

/**
 * Auto 模式分类器运行参数。
 * 不注入 `judge` 时退回确定性的 SecurityClassifier，保证任何嵌入场景下 auto 档仍可用。
 */
export interface AutoClassifierConfig {
  judge?: AutoJudge;
  /** 用户可配的信任边界（自然语言），拼进分类器系统提示词。 */
  environment?: string;
  /** 单次判定超时（ms）；超时按拒绝处理（fail-closed）。 */
  timeoutMs?: number;
  /** 分类器看到的用户原话来源；缺省用 `userIntent`。 */
  userMessages?: () => readonly string[];
  /** 工作目录（动作描述里的相对路径基准、硬熔断的路径判断）。 */
  cwd?: string;
  onJudge?: (event: AutoJudgeEvent) => void;
}

/**
 * 权限引擎错误。
 */
export class PermissionError extends HajiError {
  constructor(message: string) {
    super(message, "PERMISSION_ERROR");
    this.name = "PermissionError";
  }
}

const DEFAULT_AUTO_TIMEOUT_MS = 20_000;

interface JudgeSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

/** 组合超时与用户中止：任一触发都会 abort 分类器请求，并在 dispose 时清理定时器/监听器。 */
function createJudgeSignal(timeoutMs: number, external?: AbortSignal): JudgeSignal {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/** 即使 judge 实现忽略了 signal，也要让 await 在 abort 时立刻返回（fail-closed）。 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/** 只读 shell 命令（首个词，小写）：只查看文件或目录，不产生副作用。 */
const READ_ONLY_SHELL_COMMANDS = new Set([
  "ls",
  "dir",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "type",
  "rg",
  "get-childitem",
  "get-content",
  "get-location",
  "test-path",
]);

/** 只读的 git 子命令。 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "branch",
]);

/** `git branch` 只在列出分支时视为只读（带分支名会创建/删除分支）。 */
const GIT_BRANCH_LIST_FLAGS = new Set(["-a", "-r", "-l", "-v", "-vv", "--list", "--show-current"]);

/** 会输出文件内容的命令：其路径参数还需解析符号链接，确认仍在工作区内。 */
const CONTENT_READING_SHELL_COMMANDS = new Set(["cat", "head", "tail", "type", "get-content"]);

/** Windows 绝对路径（盘符或 UNC）：即便当前进程跑在 POSIX 上也要按 win32 语义解析。 */
function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]/.test(value);
}

/**
 * 路径（解析符号链接后）是否位于任一工作区根内。目标不存在时按最近的已存在上级目录判断，
 * 防止经由指向工作区外的符号链接目录访问其下的文件。
 *
 * Windows 盘符/UNC 路径用 win32 语义解析：在 POSIX 上运行时 `C:\secret` 是「不存在的工作区
 * 外路径」（返回 false），而不是相对文件名（否则会被误判为工作区内的普通文件而免审批）。
 */
function isInsideAnyWorkspace(
  target: string,
  cwd: string,
  extraRoots: readonly string[] = [],
): boolean {
  try {
    const impl = isWindowsAbsolutePath(target) ? path.win32 : path;
    const roots = [cwd, ...extraRoots].map((root) => fs.realpathSync(root));
    let existing = impl.resolve(cwd, target);
    while (!fs.existsSync(existing)) {
      const parent = impl.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    const real = fs.realpathSync(existing);
    return roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
  } catch {
    return false;
  }
}

/** 会写文件、执行外部程序或无限等待的参数（如 `git diff --output`、`rg --pre`、`tail -f`）。 */
const UNSAFE_SHELL_FLAG_RE = /^--?(?:output|pre|pre-glob|ext-diff|exec|follow|f)(?:=|$)/i;

/**
 * 判断 bash 命令是否为可静态确认的只读查询。规则刻意保守：
 * - 不允许任何命令组合、重定向、替换、变量展开或换行；
 * - 首个词必须在白名单内（git 只允许查询类子命令）；
 * - 路径参数只能是某个工作区根内的相对路径（拒绝绝对路径、`~` 与 `..`），输出文件内容的命令
 *   还会解析符号链接，避免绕过文件工具的路径判定读取工作区外的内容。
 * 无法确认时返回 false，交由正常审批流程处理。
 */
export function isReadOnlyShellCommand(
  command: string,
  cwd: string = process.cwd(),
  extraRoots: readonly string[] = [],
): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 300) return false;
  if (/[;&|<>`$\r\n(){}]/.test(trimmed)) return false;
  const [head, ...rest] = trimmed.split(/\s+/);
  const name = head.toLowerCase();
  let args = rest;
  if (name === "git") {
    const subcommand = rest[0]?.toLowerCase();
    if (!subcommand || !GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
    args = rest.slice(1);
    if (subcommand === "branch" && args.some((arg) => !GIT_BRANCH_LIST_FLAGS.has(arg))) {
      return false;
    }
  } else if (!READ_ONLY_SHELL_COMMANDS.has(name)) {
    return false;
  }
  for (const arg of args) {
    if (UNSAFE_SHELL_FLAG_RE.test(arg)) return false;
    if (arg.startsWith("-")) continue;
    const unquoted = arg.replace(/^["']+|["']+$/g, "");
    if (/^~/.test(unquoted)) return false;
    if (unquoted.split(/[\\/]/).includes("..")) return false;
    const absoluteArg = path.isAbsolute(unquoted) || /^[a-z]:/i.test(unquoted);
    if (absoluteArg) {
      // 绝对路径只对「只读取内容」的命令、且位于某个工作区根内时放行；
      // 这样 `cat D:/added-root/a.txt` 不必审批，而 /etc/passwd 仍需审批。
      if (
        !CONTENT_READING_SHELL_COMMANDS.has(name) ||
        !isInsideAnyWorkspace(unquoted, cwd, extraRoots)
      ) {
        return false;
      }
      continue;
    }
    if (CONTENT_READING_SHELL_COMMANDS.has(name)) {
      // 通配符可能展开到指向工作区外的符号链接，无法静态确认。
      if (/[*?[\]]/.test(unquoted) || !isInsideAnyWorkspace(unquoted, cwd, extraRoots)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 核心权限引擎类。
 */
/** 运行期注册的额外只读工具（如 readOnly MCP server 的工具），小写。 */
const extraReadOnlyTools = new Set<string>();

export class PermissionEngine {
  private classifier: SecurityClassifier;
  private autoConfig: AutoClassifierConfig;
  /** 工作区根与用户级路径规则；由 CLI 在启动与根变更时注入。 */
  private pathScopeConfig: PathScopeConfig = { cwd: process.cwd() };

  constructor(autoConfig: AutoClassifierConfig = {}) {
    this.classifier = new SecurityClassifier();
    this.autoConfig = { ...autoConfig };
  }

  /**
   * 配置工作区根（cwd + 追加目录）与用户级路径规则（permissions.json 的 paths 段）。
   * CLI 在启动、`--add-dir`、`/workspace add|remove` 与规则变更后调用。
   */
  public configurePathScope(config: PathScopeConfig): void {
    const rules = config.rules
      ? {
          allow: [...(config.rules.allow ?? [])],
          deny: [...(config.rules.deny ?? [])],
        }
      : undefined;
    this.pathScopeConfig = {
      cwd: path.resolve(config.cwd),
      roots: (config.roots ?? []).map((root) => path.resolve(root)),
      ...(rules ? { rules } : {}),
    };
  }

  /**
   * 注入 / 更新 Auto 模式的 LLM 分类器。CLI 在主模型可用后调用，
   * 未注入 judge 时 auto 档退回确定性的 SecurityClassifier。
   */
  public configureAuto(autoConfig: AutoClassifierConfig): void {
    this.autoConfig = { ...this.autoConfig, ...autoConfig };
  }

  /**
   * 注册运行期发现的只读工具名（如 readOnly MCP server 的工具），
   * 使其在任何权限模式下自动放行。仅应传入来源可信、确认无副作用的工具。
   */
  public registerReadOnlyTool(name: string): void {
    extraReadOnlyTools.add(name.toLowerCase());
  }

  /**
   * 判断给定的工具是否属于只读类型。
   */
  public isReadOnlyTool(toolName: string): boolean {
    const readOnlyTools = [
      "read_file",
      "read",
      "grep_search",
      "grep",
      "global_find_files",
      "find_files",
      "projectinfo",
      "selfstate",
      "history",
      // 内置网络工具的实际名字没有下划线；带下划线的写法保留兼容旧别名。
      "websearch",
      "webfetch",
      "web_search",
      "web_fetch",
      "loadskill",
      "listskillresources",
      "readskillresource",
    ];
    return (
      readOnlyTools.includes(toolName.toLowerCase()) ||
      extraReadOnlyTools.has(toolName.toLowerCase())
    );
  }

  /**
   * 判断给定的工具是否属于文件编辑类型。
   */
  public isEditTool(toolName: string): boolean {
    const editTools = ["write_file", "write", "edit_file", "edit"];
    return editTools.includes(toolName.toLowerCase());
  }

  /**
   * 根据当前权限模式和工具入参，评估工具调用的处理动作。
   * 文件路径的作用域判定在这里完成：工作区外不再是工具内部硬拒绝，
   * 而是按模式给出「允许 / 询问 / 拒绝」，授权范围随结果一起返回。
   */
  public async evaluate(options: PermissionEvaluateOptions): Promise<PermissionCheckResult> {
    const { mode, toolName, args } = options;

    // 0. 受保护目标：任何档位（plan / auto / bypass）都不能跳过。
    //    必须在 plan 与 bypass 的短路之前判定，否则这两个分支会直接放行。
    if (!protectedTargetsDisabled()) {
      const protectedHit = inspectProtectedTarget(toolName, args, this.pathScopeConfig.cwd);
      if (protectedHit) {
        const reason = formatProtectedReason(protectedHit);
        // 灾难性操作直接拒绝：连“本次允许”都不提供。
        if (protectedHit.level === "forbidden") {
          if (mode === "auto") {
            this.emitAutoJudge({
              phase: "done",
              toolName,
              toolCallId: options.toolCallId,
              source: "hard-block",
              allowed: false,
              reason,
            });
          }
          return {
            action: "deny",
            riskLevel: "critical",
            reason,
            protectedLevel: protectedHit.level,
          };
        }
        return {
          action: "prompt",
          riskLevel: protectedHit.level === "hard" ? "critical" : "high",
          reason,
          protectedLevel: protectedHit.level,
        };
      }
    }

    const pathScope = inspectPathScope(toolName, args, this.pathScopeConfig);
    const allowOutside = process.env.HAJI_ALLOW_OUTSIDE_WORKSPACE === "1";
    const denyByRule = (): PermissionCheckResult => ({
      action: "deny",
      riskLevel: "high",
      reason: `命中禁止路径规则（${pathScope.rule}）：${pathScope.targets[0] ?? ""}`,
    });
    const promptOutside = (): PermissionCheckResult => ({
      action: "prompt",
      riskLevel: "medium",
      reason: formatPathScopeReason(pathScope),
      ...(pathScope.grant ? { grant: pathScope.grant } : {}),
    });

    // Plan 模式只允许只读调研与计划管理，禁止修改工作区。
    if (mode === "plan") {
      if (
        this.isReadOnlyTool(toolName) ||
        ["subagent", "verifyagent"].includes(toolName.toLowerCase()) ||
        ["taskcreate", "tasklist", "updatetask", "setgoal"].includes(toolName.toLowerCase())
      ) {
        if (pathScope.status === "deny") return denyByRule();
        if (pathScope.status === "outside" && !allowOutside) return promptOutside();
        return { action: "allow", riskLevel: "safe" };
      }
      return {
        action: "deny",
        riskLevel: "medium",
        reason: "Plan 模式禁止修改文件或执行脚本，请先提交计划并等待用户批准",
      };
    }

    // 用户级禁止路径规则优先于任何放行（含 bypass 与只读路径）。
    if (pathScope.status === "deny") return denyByRule();

    // 1. Bypass Permissions 模式：跳过常规审批（受保护目标已在最前面拦截）
    if (mode === "bypass-permissions") {
      return { action: "allow", riskLevel: "safe" };
    }

    // 命中用户级放行规则的越界路径等同于工作区内。
    if (pathScope.status === "allowed") {
      return {
        action: "allow",
        riskLevel: "low",
        reason: `命中路径放行规则（${pathScope.rule}）：${pathScope.targets[0] ?? ""}`,
      };
    }

    // 2. 工作区外：全局开关放行，否则交人工授权（auto 档也不交给分类器静默决定）。
    if (pathScope.status === "outside") {
      if (allowOutside) {
        return {
          action: "allow",
          riskLevel: "medium",
          reason: `HAJI_ALLOW_OUTSIDE_WORKSPACE=1 已放行工作区外路径：${pathScope.targets[0] ?? ""}`,
        };
      }
      return promptOutside();
    }

    // 3. 只读型工具：在任何模式下均自动允许
    if (this.isReadOnlyTool(toolName)) {
      return { action: "allow", riskLevel: "safe" };
    }

    // 只读 shell 查询（ls、git status 等）与只读工具同等对待，无需审批。
    if (
      toolName.toLowerCase() === "bash" &&
      typeof args.command === "string" &&
      isReadOnlyShellCommand(
        args.command,
        this.pathScopeConfig.cwd,
        this.pathScopeConfig.roots ?? [],
      )
    ) {
      return { action: "allow", riskLevel: "safe" };
    }

    // task* 与 goal* 仅写入 .haji 下的会话元数据，在所有模式中均可安全使用。
    if (
      ["taskcreate", "tasklist", "updatetask", "taskfinish", "setgoal", "goalfinish"].includes(
        toolName.toLowerCase(),
      )
    ) {
      return { action: "allow", riskLevel: "safe" };
    }

    // subagent 只是调度入口；子代理内部的每次真实工具调用仍会单独经过本权限引擎。
    if (["subagent", "verifyagent"].includes(toolName.toLowerCase())) {
      return { action: "allow", riskLevel: "safe" };
    }

    // 3. Accept Edit 模式：编辑工具自动允许，脚本等需要审批
    if (mode === "accept-edit") {
      if (this.isEditTool(toolName)) {
        return { action: "allow", riskLevel: "low" };
      }
      return { action: "prompt", riskLevel: "medium", reason: "命令需用户手动确认授权" };
    }

    // 4. Default 模式：编辑和脚本都需要人工审批
    if (mode === "default") {
      return { action: "prompt", riskLevel: "medium", reason: "修改型工具需用户手动确认授权" };
    }

    // 5. Auto 模式：确定性硬熔断 + LLM 分类器；未注入 judge 时退回规则分类器
    if (mode === "auto") {
      return this.evaluateAuto(toolName, args, options);
    }

    return { action: "prompt", riskLevel: "medium" };
  }

  private emitAutoJudge(event: AutoJudgeEvent): void {
    try {
      this.autoConfig.onJudge?.(event);
    } catch {
      // UI 回调失败不能影响安全判定。
    }
  }

  private async evaluateAuto(
    toolName: string,
    args: Record<string, unknown>,
    options: PermissionEvaluateOptions,
  ): Promise<PermissionCheckResult> {
    const startedAt = Date.now();
    const cwd = this.autoConfig.cwd ?? process.cwd();
    // 判定事件一并带上工具调用 id：UI 据此把「判定中 / 结论」挂到对话区对应的工具格上。
    const emit = (event: Omit<AutoJudgeEvent, "toolName" | "toolCallId">): void => {
      this.emitAutoJudge({ ...event, toolName, toolCallId: options.toolCallId });
    };

    // 确定性硬熔断优先于模型：分类器再准也不把「一句命令毁掉机器」交给它判。
    const hardBlockReason = hardBlock(toolName, args, cwd);
    if (hardBlockReason) {
      emit({
        phase: "done",
        source: "hard-block",
        allowed: false,
        reason: hardBlockReason,
        durationMs: Date.now() - startedAt,
      });
      return { action: "deny", riskLevel: "critical", reason: hardBlockReason };
    }

    const judge = this.autoConfig.judge;
    if (!judge) {
      emit({ phase: "start", source: "fallback" });
      const assessment = await this.classifier.assess({
        toolName,
        args,
        userIntent: options.userIntent,
        riskThreshold: options.riskThreshold,
      });
      emit({
        phase: "done",
        source: "fallback",
        allowed: assessment.isSafe,
        reason: assessment.reason,
        durationMs: Date.now() - startedAt,
      });
      return assessment.isSafe
        ? { action: "allow", riskLevel: assessment.riskLevel }
        : {
            action: "deny",
            riskLevel: assessment.riskLevel,
            reason: assessment.reason || "分类器检测到该操作超出允许的安全风险阈值",
          };
    }

    emit({ phase: "start", source: "classifier" });
    const configMessages = this.autoConfig.userMessages?.();
    const userMessages =
      configMessages && configMessages.length > 0
        ? configMessages
        : options.userMessages && options.userMessages.length > 0
          ? options.userMessages
          : options.userIntent
            ? [options.userIntent]
            : [];
    const system = buildSystemPrompt(this.autoConfig.environment);
    const user = `${buildUserSection(userMessages)}\n\n${buildActionSection(toolName, args, cwd)}`;
    const judgeSignal = createJudgeSignal(
      this.autoConfig.timeoutMs ?? DEFAULT_AUTO_TIMEOUT_MS,
      options.abortSignal,
    );

    try {
      // 先挂一个空 catch：超时/中止让 race 先返回后，模型请求稍后的拒绝不应变成未处理异常。
      const judgePromise = Promise.resolve().then(() =>
        judge({ system, user, signal: judgeSignal.signal }),
      );
      judgePromise.catch(() => {});
      const reply = await Promise.race([judgePromise, rejectOnAbort(judgeSignal.signal)]);
      const decision = parseDecision(reply);
      if (!decision) {
        const reason = "分类器返回无法解析的判定，已按拒绝处理。请改用更安全的做法或询问用户。";
        emit({
          phase: "done",
          source: "error",
          allowed: false,
          reason,
          durationMs: Date.now() - startedAt,
        });
        return { action: "deny", riskLevel: "high", reason };
      }
      emit({
        phase: "done",
        source: "classifier",
        allowed: decision.allow,
        reason: decision.reason,
        durationMs: Date.now() - startedAt,
      });
      return decision.allow
        ? { action: "allow", riskLevel: "low", reason: decision.reason }
        : { action: "deny", riskLevel: "high", reason: decision.reason };
    } catch (error) {
      const aborted = judgeSignal.timedOut()
        ? `分类器判定超时（${this.autoConfig.timeoutMs ?? DEFAULT_AUTO_TIMEOUT_MS}ms），已按拒绝处理`
        : options.abortSignal?.aborted
          ? "判定已被用户中止，该工具未执行"
          : `分类器调用失败，已按拒绝处理：${
              error instanceof Error ? error.message : String(error)
            }`;
      emit({
        phase: "done",
        source: "error",
        allowed: false,
        reason: aborted,
        durationMs: Date.now() - startedAt,
      });
      return { action: "deny", riskLevel: "high", reason: aborted };
    } finally {
      judgeSignal.dispose();
    }
  }
}
