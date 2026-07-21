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
