import fs from "node:fs";

/** 重启只携带恢复会话和工作区所需参数，不重复执行旧的启动动作。 */
export function buildReloadArgs(
  sessionId: string | undefined,
  workspaceRoots: readonly string[],
): string[] {
  return [
    ...(sessionId ? ["--reload-session", sessionId] : ["--no-worktree"]),
    ...workspaceRoots.flatMap((root) => ["--add-dir", root]),
  ];
}

export function supportsProcessReload(): boolean {
  return (
    process.platform !== "win32" &&
    typeof (process as NodeJS.Process & { execve?: unknown }).execve === "function"
  );
}

/** 原位替换进程，保留 PID、前台进程组和标准输入输出，避免重载链累积。 */
export async function runReloadProcess(options: {
  entryPath: string;
  sessionId?: string;
  workspaceRoots: readonly string[];
  cwd: string;
}): Promise<number> {
  const execve = (
    process as NodeJS.Process & {
      execve?: (file: string, args: string[], env: Record<string, string>) => never;
    }
  ).execve;
  if (!execve || process.platform === "win32") {
    throw new Error(
      "当前 Node 或平台不支持原位重载，请升级到支持 process.execve 的 Node（22.15+ / 24+，非 Windows）或手动重启 haji",
    );
  }
  fs.accessSync(options.entryPath, fs.constants.R_OK);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  process.chdir(options.cwd);
  execve(
    process.execPath,
    [
      process.execPath,
      ...process.execArgv,
      options.entryPath,
      ...buildReloadArgs(options.sessionId, options.workspaceRoots),
    ],
    env,
  );
  throw new Error("原位重载意外返回");
}
