/**
 * `haji mcp-serve` 启动参数：把 haji 作为常驻驱动进程，经 MCP（stdio）对外提供
 * 「发消息 + 调整 + 查询状态」的工具面，供外部 Agent（如 Hermes）调用。
 *
 * 纯函数：不读环境、不退出进程，错误以 error 字段返回，便于单测。
 */
export interface ServeRequest {
  /** 工作目录覆盖（默认沿用启动目录，含自动 worktree 的结果）。 */
  cwd?: string;
  /**
   * 授权策略：
   * - `ask`（默认）：需要授权时发 `selection_request` 事件并挂起，等 `haji_approve`。
   * - `auto`：无人值守。普通授权只放行本次，受保护目标、加工作区目录、临时提权一律拒绝，
   *   计划审批批准后只切到 [默认]（见 DriverSelectionRequest.autoValue / fallbackValue）。
   */
  approval: "ask" | "auto";
  /** 单次 `haji_send` 的默认等待时长（毫秒）；超时返回 running + taskId。 */
  waitMs: number;
}

export interface ServeParseResult {
  request?: ServeRequest;
  error?: string;
}

export const SERVE_COMMAND = "mcp-serve";

const DEFAULT_WAIT_MS = 25_000;
const MAX_WAIT_MS = 600_000;

/** 是否请求了驱动服务（`haji mcp-serve`）。 */
export function isServeCommand(args: readonly string[]): boolean {
  return args[0] === SERVE_COMMAND || args[0] === `--${SERVE_COMMAND}`;
}

export function parseServeArgs(args: readonly string[]): ServeParseResult {
  if (!isServeCommand(args)) return {};

  let cwd: string | undefined;
  let approval: "ask" | "auto" = "ask";
  let waitMs = DEFAULT_WAIT_MS;

  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--cwd") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--cwd 需要一个目录参数，例如：haji mcp-serve --cwd /path/to/repo" };
      }
      cwd = value;
      index += 1;
      continue;
    }
    if (arg === "--approval") {
      const value = args[index + 1];
      if (value !== "ask" && value !== "auto") {
        return { error: "--approval 只支持 ask 或 auto" };
      }
      approval = value;
      index += 1;
      continue;
    }
    if (arg === "--wait-ms") {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value) || value <= 0 || value > MAX_WAIT_MS) {
        return { error: `--wait-ms 需要一个 1–${MAX_WAIT_MS} 之间的毫秒数` };
      }
      waitMs = Math.floor(value);
      index += 1;
      continue;
    }
    return { error: `未知的 mcp-serve 参数：${arg}` };
  }

  return { request: { cwd, approval, waitMs } };
}
