/**
 * 侧栏用的 git 摘要：未提交改动数异步读取，永不阻塞渲染。
 *
 * 分支名不在这里读——调用方用 cli-runtime 的 readGitBranch 直接读 .git/HEAD，
 * 那是同步的纯文件读取，成本可以忽略；只有 git status 这一条需要起子进程。
 */
import { execFile } from "node:child_process";

/**
 * 统计工作区未提交改动条数（含已暂存与未暂存，git status --porcelain 的行数）。
 * 非 git 仓库、未安装 git 或超时都返回 undefined，由调用方静默跳过显示。
 */
export function readGitDirtyCount(cwd: string, timeoutMs = 4000): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      {
        cwd,
        encoding: "utf8",
        timeout: Math.max(500, timeoutMs),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const lines = String(stdout)
          .split("\n")
          .filter((line) => line.trim().length > 0);
        resolve(lines.length);
      },
    );
  });
}
