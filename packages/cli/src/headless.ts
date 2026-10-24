import { isPermissionMode, type PermissionMode } from "@hajicli/core";

/** `haji -p "prompt"` 无头单次执行模式的启动请求。 */
export interface HeadlessRequest {
  prompt: string;
  /** 显式指定的权限档位（--permission-mode）；缺省沿用偏好设置。 */
  permissionMode?: PermissionMode;
}

export interface HeadlessParseResult {
  /** 存在 -p/--print 时非空。 */
  request?: HeadlessRequest;
  /** 参数非法时的用户可见错误文案（调用方打印到 stderr 并以退出码 1 结束）。 */
  error?: string;
}

const USAGE_PERMISSION_MODES = "plan | default | accept-edit | auto | bypass-permissions";

/**
 * 解析无头单次执行参数（`haji -p "prompt" [--permission-mode <mode>]`）。
 * 纯函数：不读环境、不退出进程，错误以 error 字段返回。
 * 其余旗标忽略（-v/-h 已由 handleEarlyCliArgs 处理）。
 */
export function parseHeadlessArgs(args: readonly string[]): HeadlessParseResult {
  let prompt: string | undefined;
  let permissionMode: PermissionMode | undefined;
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
    }
  }
  if (prompt === undefined) return {};
  return { request: { prompt, permissionMode } };
}
