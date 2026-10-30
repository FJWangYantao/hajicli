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
  /** 已跟踪文件的增减行数（git diff HEAD --numstat）；未跟踪的新文件不计入。 */
  insertions: number;
  deletions: number;
  /** 改动文件列表（含未跟踪），按 git status 的输出顺序；侧栏「改动」区一行一个。 */
  files: string[];
}

type ChangeCounts = Pick<
  WorkspaceStatus,
  "modified" | "added" | "deleted" | "untracked" | "conflicted"
>;

export type LineCounts = Pick<WorkspaceStatus, "insertions" | "deletions">;

/** -z 模式路径不转义；重命名/复制的第二个路径字段不计为额外文件。 */
function scanPorcelain(output: string): { counts: ChangeCounts; files: string[] } {
  const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, conflicted: 0 };
  const files: string[] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (/[RC]/.test(code)) index++;
    if (code === "!!") continue;
    if (code === "??") counts.untracked++;
    else if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) counts.conflicted++;
    else if (code.includes("D")) counts.deleted++;
    else if (/[AC]/.test(code)) counts.added++;
    else counts.modified++;
    files.push(file);
  }
  return { counts, files };
}

export function parseWorkspaceChanges(output: string): ChangeCounts {
  return scanPorcelain(output).counts;
}

/** 与 parseWorkspaceChanges 同一份 porcelain 输出，只取改动文件路径。 */
export function parseWorkspaceFiles(output: string): string[] {
  return scanPorcelain(output).files;
}

/** numstat 每行是「增\t减\t路径」；二进制文件的两列都是 "-"，按 0 计。 */
export function parseNumstat(output: string): LineCounts {
  const counts = { insertions: 0, deletions: 0 };
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed] = line.split("\t");
    counts.insertions += Number.parseInt(added, 10) || 0;
    counts.deletions += Number.parseInt(removed, 10) || 0;
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

/**
 * 已跟踪文件的增删行数。尚未产生第一个提交（unborn HEAD）时 HEAD 不存在，
 * 退化为「暂存区 vs HEAD + 工作区 vs 暂存区」两段之和，与 diff HEAD 等价。
 */
async function readLineChanges(cwd: string): Promise<LineCounts> {
  try {
    return parseNumstat(await git(cwd, ["diff", "--numstat", "HEAD"]));
  } catch {
    const [staged, unstaged] = await Promise.all([
      git(cwd, ["diff", "--numstat", "--cached"]).catch(() => ""),
      git(cwd, ["diff", "--numstat"]).catch(() => ""),
    ]);
    const a = parseNumstat(staged);
    const b = parseNumstat(unstaged);
    return { insertions: a.insertions + b.insertions, deletions: a.deletions + b.deletions };
  }
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
    insertions: 0,
    deletions: 0,
    files: [],
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
    const [status, branch, lines] = await Promise.all([
      git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() =>
        git(cwd, ["rev-parse", "--short", "HEAD"]).then((sha) => `detached · ${sha.trim()}`),
      ),
      readLineChanges(cwd),
    ]);
    const scanned = scanPorcelain(status);
    return {
      ...base,
      ...scanned.counts,
      ...lines,
      files: scanned.files,
      branch: branch.trim(),
      gitStatus: "ready",
    };
  } catch {
    return base;
  }
}
