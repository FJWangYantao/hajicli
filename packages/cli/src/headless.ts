import { isPermissionMode, type PermissionMode } from "@hajicli/core";

/** `haji -p "prompt"` 无头单次执行模式的启动请求。 */
export interface HeadlessRequest {
  prompt: string;
  /** 显式指定的权限档位（--permission-mode）；缺省沿用偏好设置。 */
  permissionMode?: PermissionMode;
  /** 输出格式（--output-format）：text 直写正文（默认）；json 静音正文、结束时输出结构化结果。 */
  outputFormat?: "text" | "json";
  /**
   * 本次进程额外的放行键（--allow，可重复）。形态与 `.haji/permissions.json` 的 `key` 一致：
   * `bash:<命令前缀>`（如 `bash:npm test`）或工具名（如 `write`）。只作用于本次进程，不落盘。
   */
  allow?: string[];
}

export interface HeadlessParseResult {
  /** 存在 -p/--print 时非空。 */
  request?: HeadlessRequest;
  /** 参数非法时的用户可见错误文案（调用方打印到 stderr 并以退出码 1 结束）。 */
  error?: string;
}

const USAGE_PERMISSION_MODES = "plan | default | accept-edit | auto | bypass-permissions";

/**
 * `--allow` 的键形态校验：`bash:<命令前缀>`（前缀内允许空格，但不允许 shell 元字符——
 * 组合命令本来也拿不到 grant，写进来只会是永远不命中的死规则）或单个工具名。
 */
const ALLOW_KEY_PATTERN = /^(?:bash:[^;&|<>`$\r\n]+|[A-Za-z][A-Za-z0-9_.-]*)$/;

const USAGE_ALLOW = '--allow 需要一个放行键，例如：--allow "bash:npm test" --allow write';

/**
 * 解析无头单次执行参数（`haji -p "prompt" [--permission-mode <mode>] [--allow <key>]...`）。
 * 纯函数：不读环境、不退出进程，错误以 error 字段返回。
 * 其余旗标忽略（-v/-h 已由 handleEarlyCliArgs 处理）。
 */
export function parseHeadlessArgs(args: readonly string[]): HeadlessParseResult {
  let prompt: string | undefined;
  let permissionMode: PermissionMode | undefined;
  let outputFormat: "text" | "json" | undefined;
  const allow: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-p" || arg === "--print") {
      const value = args[index + 1];
      if (value === undefined || (value.startsWith("-") && value.length > 1)) {
        return { error: '-p/--print 需要一个 prompt 参数，例如：haji -p "解释这段代码"' };
      }
      prompt = value;
      index += 1;
    } else if (arg === "--permission-mode") {
      const value = args[index + 1];
      if (value === undefined) {
        return { error: `--permission-mode 需要一个模式参数：${USAGE_PERMISSION_MODES}` };
      }
      if (!isPermissionMode(value)) {
        return { error: `无效权限模式：${value}（可选 ${USAGE_PERMISSION_MODES}）` };
      }
      permissionMode = value;
      index += 1;
    } else if (arg === "--output-format") {
      const value = args[index + 1];
      if (value !== "text" && value !== "json") {
        return { error: "--output-format 只支持 text 或 json" };
      }
      outputFormat = value;
      index += 1;
    } else if (arg === "--allow") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return { error: USAGE_ALLOW };
      const key = value.trim();
      if (!ALLOW_KEY_PATTERN.test(key)) {
        return {
          error: `无效的 --allow 放行键：${value}（应为 bash:<命令前缀> 或工具名，且不含 ; & | < > \` $）`,
        };
      }
      allow.push(key);
      index += 1;
    } else if (arg.startsWith("--allow=")) {
      const key = arg.slice("--allow=".length).trim();
      if (!key || !ALLOW_KEY_PATTERN.test(key)) {
        return {
          error: `无效的 --allow 放行键：${arg.slice("--allow=".length)}（应为 bash:<命令前缀> 或工具名）`,
        };
      }
      allow.push(key);
    }
  }
  if (prompt === undefined) return {};
  return { request: { prompt, permissionMode, outputFormat, ...(allow.length ? { allow } : {}) } };
}

/**
 * 追加工作区根参数：`--add-dir <path>`（可重复，也接受 `--add-dir=<path>`）。
 * 只在本次进程内生效，不写配置；需要长期生效用 `/workspace add`。
 */
export interface AddDirParseResult {
  roots: string[];
  error?: string;
}

export function parseAddDirArgs(args: readonly string[]): AddDirParseResult {
  const roots: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--add-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { roots, error: "--add-dir 需要一个目录参数，例如：haji --add-dir ../other-repo" };
      }
      roots.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--add-dir=")) {
      const value = arg.slice("--add-dir=".length);
      if (!value) {
        return { roots, error: "--add-dir 需要一个目录参数，例如：haji --add-dir ../other-repo" };
      }
      roots.push(value);
    }
  }
  return { roots };
}

/** 会话恢复启动参数：`haji -c` 继续上次会话；`haji -r [关键词]` 搜索恢复。 */ export interface SessionResumeRequest {
  mode: "latest" | "search";
  keyword?: string;
}

/**
 * 解析会话恢复参数（-c/--continue 与 -r/--resume）。
 * 与无头 -p 互斥：调用方在进入无头模式时忽略返回值。
 */
export function parseSessionResumeArgs(args: readonly string[]): SessionResumeRequest | undefined {
  let resume: SessionResumeRequest | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-c" || arg === "--continue") {
      resume = { mode: "latest" };
    } else if (arg === "-r" || arg === "--resume") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        resume = { mode: "search", keyword: value };
        index += 1;
      } else {
        resume = { mode: "search" };
      }
    }
  }
  return resume;
}
