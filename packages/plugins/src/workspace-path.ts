import * as path from "node:path";

export interface ResolveWorkspacePathOptions {
  cwd?: string;
}

/**
 * 文件工具的错误信息映射：只回显调用方给的路径，绝不暴露 realpath 后的宿主绝对路径。
 */
export function formatWorkspaceError(error: unknown, inputPath: string): string {
  const candidate = error as NodeJS.ErrnoException;
  const displayPath = inputPath || ".";
  switch (candidate?.code) {
    case "ENOENT":
      return `路径不存在: ${displayPath}`;
    case "EACCES":
    case "EPERM":
      return `没有权限访问: ${displayPath}`;
    case "EISDIR":
      return `目标是目录而不是文件: ${displayPath}`;
    case "ENOTDIR":
      return `路径中的某一部分不是目录: ${displayPath}`;
    case "EEXIST":
      return `目标已经存在: ${displayPath}`;
    case "ENOSPC":
      return `磁盘空间不足，无法处理: ${displayPath}`;
    case "EMFILE":
    case "ENFILE":
      return `打开的文件过多，请稍后重试: ${displayPath}`;
    default:
      return `文件系统操作失败${candidate?.code ? ` (${candidate.code})` : ""}: ${displayPath}`;
  }
}

/**
 * 把工具入参解析成绝对路径。
 *
 * 边界判定已上移到权限层（core/path-scope.ts + PermissionEngine）：工作区外的调用会在
 * PreToolUse 阶段被要求授权或拒绝，走到这里的路径都已获准，因此工具本身不再抛越界错误。
 */
export async function resolveWorkspacePath(
  inputPath: string,
  options: ResolveWorkspacePathOptions = {},
): Promise<string> {
  const cwd = options.cwd || process.cwd();
  return path.resolve(cwd, inputPath);
}
