import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ResolveWorkspacePathOptions {
  cwd?: string;
  mustExist?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

/** Returns a model-safe filesystem error without resolved host paths. */
export function formatWorkspaceError(error: unknown, inputPath: string): string {
  if (error instanceof WorkspacePathError) return error.message;
  const candidate = error as NodeJS.ErrnoException;
  const displayPath = inputPath || '.';
  switch (candidate?.code) {
    case 'ENOENT':
      return `路径不存在: ${displayPath}`;
    case 'EACCES':
    case 'EPERM':
      return `没有权限访问: ${displayPath}`;
    case 'EISDIR':
      return `目标是目录而不是文件: ${displayPath}`;
    case 'ENOTDIR':
      return `路径中的某一部分不是目录: ${displayPath}`;
    case 'EEXIST':
      return `目标已经存在: ${displayPath}`;
    case 'ENOSPC':
      return `磁盘空间不足，无法处理: ${displayPath}`;
    case 'EMFILE':
    case 'ENFILE':
      return `打开的文件过多，请稍后重试: ${displayPath}`;
    default:
      return `文件系统操作失败${candidate?.code ? ` (${candidate.code})` : ''}: ${displayPath}`;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function findExistingAncestor(target: string): Promise<string> {
  let current = target;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Resolves a tool path and rejects lexical or symlink escapes from the current workspace.
 * Set HAJI_ALLOW_OUTSIDE_WORKSPACE=1 only for an explicitly trusted local session.
 */
export async function resolveWorkspacePath(
  inputPath: string,
  options: ResolveWorkspacePathOptions = {}
): Promise<string> {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const unresolvedCandidate = path.resolve(cwd, inputPath);

  if (env.HAJI_ALLOW_OUTSIDE_WORKSPACE === '1') return unresolvedCandidate;

  const root = await fs.realpath(cwd);
  const candidate = path.isAbsolute(inputPath) ? unresolvedCandidate : path.resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new WorkspacePathError(`路径越出当前工作区，已拒绝访问: ${inputPath}`);
  }

  const resolvedTarget = options.mustExist === false
    ? await findExistingAncestor(candidate)
    : await fs.realpath(candidate);
  if (!isInside(root, resolvedTarget)) {
    throw new WorkspacePathError(`路径通过符号链接越出当前工作区，已拒绝访问: ${inputPath}`);
  }

  return candidate;
}
