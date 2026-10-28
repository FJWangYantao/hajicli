import { execFile } from "node:child_process";
import path from "node:path";

export interface WorkspaceStatus {
  name: string;
  branch?: string;
  gitStatus: "ready" | "unavailable" | "not-repository";
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  conflicted: number;
}

type ChangeCounts = Pick<
  WorkspaceStatus,
  "modified" | "added" | "deleted" | "untracked" | "conflicted"
>;

/** -z 模式路径不转义；重命名/复制的第二个路径字段不计为额外文件。 */
export function parseWorkspaceChanges(output: string): ChangeCounts {
  const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, conflicted: 0 };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    if (/[RC]/.test(code)) index++;
    if (code === "??") counts.untracked++;
    else if (code === "!!") continue;
    else if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) counts.conflicted++;
    else if (code.includes("D")) counts.deleted++;
    else if (/[AC]/.test(code)) counts.added++;
    else counts.modified++;
  }
  return counts;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export async function readWorkspaceStatus(cwd: string): Promise<WorkspaceStatus> {
  const base: WorkspaceStatus = {
    name: path.basename(cwd) || cwd,
    gitStatus: "unavailable",
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    conflicted: 0,
  };
  try {
    await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    // Git 退出码 128 表示此目录无法作为仓库读取；不存在的命令仍归为不可用。
    return {
      ...base,
      gitStatus: (error as { code?: unknown }).code === 128 ? "not-repository" : "unavailable",
    };
  }
  try {
    const [status, branch] = await Promise.all([
      git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() =>
        git(cwd, ["rev-parse", "--short", "HEAD"]).then((sha) => `detached · ${sha.trim()}`),
      ),
    ]);
    return { ...base, ...parseWorkspaceChanges(status), branch: branch.trim(), gitStatus: "ready" };
  } catch {
    return base;
  }
}
