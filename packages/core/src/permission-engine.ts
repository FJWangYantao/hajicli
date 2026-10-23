import fs from "node:fs";
import path from "node:path";
import {
  type RiskLevel,
  type SecurityAssessment,
  SecurityClassifier,
} from "./security-classifier.js";
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
    description: "AI 分类器判定危险等级，不安全命令拒绝并提示修正",
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
}

/**
 * 权限评估参数接口。
 */
export interface PermissionEvaluateOptions {
  mode: PermissionMode;
  toolName: string;
  args: Record<string, unknown>;
  userIntent?: string;
  riskThreshold?: RiskLevel;
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

/**
 * 路径（解析符号链接后）是否位于工作区内。目标不存在时按最近的已存在上级目录判断，
 * 防止经由指向工作区外的符号链接目录访问其下的文件。
 */
function isInsideWorkspace(target: string, cwd: string): boolean {
  try {
    const root = fs.realpathSync(cwd);
    let existing = path.resolve(cwd, target);
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    const real = fs.realpathSync(existing);
    return real === root || real.startsWith(`${root}${path.sep}`);
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
 * - 路径参数只能是工作区内的相对路径（拒绝绝对路径、`~` 与 `..`），输出文件内容的命令
 *   还会解析符号链接，避免绕过文件工具的工作区边界读取工作区外的内容。
 * 无法确认时返回 false，交由正常审批流程处理。
 */
export function isReadOnlyShellCommand(command: string, cwd: string = process.cwd()): boolean {
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
    if (/^[\\/~]/.test(unquoted) || /^[a-z]:/i.test(unquoted)) return false;
    if (unquoted.split(/[\\/]/).includes("..")) return false;
    if (CONTENT_READING_SHELL_COMMANDS.has(name)) {
      // 通配符可能展开到指向工作区外的符号链接，无法静态确认。
      if (/[*?[\]]/.test(unquoted) || !isInsideWorkspace(unquoted, cwd)) return false;
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

  constructor() {
    this.classifier = new SecurityClassifier();
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
   */
  public async evaluate(options: PermissionEvaluateOptions): Promise<PermissionCheckResult> {
    const { mode, toolName, args, userIntent = "", riskThreshold = "medium" } = options;

    // Plan 模式只允许只读调研与计划管理，禁止修改工作区。
    if (mode === "plan") {
      if (
        this.isReadOnlyTool(toolName) ||
        ["subagent", "verifyagent"].includes(toolName.toLowerCase()) ||
        ["taskcreate", "tasklist", "updatetask"].includes(toolName.toLowerCase())
      ) {
        return { action: "allow", riskLevel: "safe" };
      }
      return {
        action: "deny",
        riskLevel: "medium",
        reason: "Plan 模式禁止修改文件或执行脚本，请先提交计划并等待用户批准",
      };
    }

    // 1. Bypass Permissions 模式：无条件全部允许
    if (mode === "bypass-permissions") {
      return { action: "allow", riskLevel: "safe" };
    }

    // 2. 只读型工具：在任何模式下均自动允许
    if (this.isReadOnlyTool(toolName)) {
      return { action: "allow", riskLevel: "safe" };
    }

    // 只读 shell 查询（ls、git status 等）与只读工具同等对待，无需审批。
    if (
      toolName.toLowerCase() === "bash" &&
      typeof args.command === "string" &&
      isReadOnlyShellCommand(args.command)
    ) {
      return { action: "allow", riskLevel: "safe" };
    }

    // task* 仅写入 .haji 下的会话计划元数据，在所有模式中均可安全使用。
    if (["taskcreate", "tasklist", "updatetask", "taskfinish"].includes(toolName.toLowerCase())) {
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

    // 5. Auto 模式：调起 SecurityClassifier 动态分析
    if (mode === "auto") {
      const assessment: SecurityAssessment = await this.classifier.assess({
        toolName,
        args,
        userIntent,
        riskThreshold,
      });

      if (assessment.isSafe) {
        return {
          action: "allow",
          riskLevel: assessment.riskLevel,
        };
      }

      return {
        action: "deny",
        riskLevel: assessment.riskLevel,
        reason: assessment.reason || "分类器检测到该操作超出允许的安全风险阈值",
      };
    }

    return { action: "prompt", riskLevel: "medium" };
  }
}
