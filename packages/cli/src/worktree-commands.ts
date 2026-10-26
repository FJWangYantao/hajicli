/**
 * `/worktree` 命令族：查看 / 开关「每个新会话自动开独立工作树」。
 *
 * 开关本身写入主仓库的 `.haji/config.json`，下一次启动新会话时生效；
 * 当前会话不会中途搬家（进程目录与已载入的工作区根都已确定）。
 * 清理入口只处理 `haji/` 分支创建的工作树，主工作树与其他分支一律不动。
 */
import { normalizePathKey } from "@hajicli/core";
import { colors } from "./theme.js";
import {
  detectGitRepo,
  listHajiWorktrees,
  loadWorktreeSetting,
  makeWorktreeName,
  removeWorktree,
  resolveWorktreePath,
  saveWorktreeEnabled,
  WORKTREE_BRANCH_PREFIX,
} from "./worktree.js";

export interface WorktreeCommandContext {
  cwd: string;
  /** 主循环直接写对话区；回合中由立即通道寄存到安全点，不能直写 chatContent。 */
  writeLine(text: string): void;
  writeChat(text: string): void;
}

function usage(ctx: WorktreeCommandContext): void {
  ctx.writeLine(colors.gray("用法："));
  ctx.writeLine(colors.gray("  /worktree                查看当前状态与存放目录"));
  ctx.writeLine(
    colors.gray("  /worktree on|off         开关自动 worktree（写入主仓库 .haji/config.json）"),
  );
  ctx.writeLine(colors.gray("  /worktree list           列出 haji 创建的工作树"));
  ctx.writeLine(
    colors.gray("  /worktree remove [--force] <名称|路径>  移除工作树（--force 丢弃未提交改动）"),
  );
}

function printOverview(ctx: WorktreeCommandContext): void {
  const repo = detectGitRepo(ctx.cwd);
  if (!repo) {
    ctx.writeLine(colors.warnLine("当前目录不在 git 仓库内，自动 worktree 不可用。"));
    return;
  }
  const setting = loadWorktreeSetting(ctx.cwd);
  const state = setting.enabled ? colors.okLine("已启用") : colors.gray("未启用");
  ctx.writeLine(colors.bold("自动 worktree"));
  ctx.writeLine(`  状态：${state}${setting.enabled ? "（下一次启动新会话时生效）" : ""}`);
  ctx.writeLine(colors.gray(`  主仓库：${repo.mainRoot}`));
  const sample = resolveWorktreePath(setting, repo, makeWorktreeName());
  ctx.writeLine(
    colors.gray(`  存放目录：${setting.root ?? "~/.haji/worktrees/<仓库名>-<指纹>/<会话名>"}`),
  );
  ctx.writeLine(colors.gray(`  本次示例路径：${sample}`));
  ctx.writeLine(colors.gray(`  分支命名：${WORKTREE_BRANCH_PREFIX}<会话名>`));
  ctx.writeLine(
    colors.gray(
      repo.linked
        ? `  当前会话：在 worktree 中运行 · ${repo.root}`
        : `  当前会话：在主工作树中运行 · ${repo.root}`,
    ),
  );
  const existing = listHajiWorktrees(repo.mainRoot);
  ctx.writeLine(colors.gray(`  已有工作树：${existing.length} 个（/worktree list 查看）`));
  ctx.writeLine(
    colors.gray(
      "  临时覆盖：启动时加 --worktree 强制新建，--no-worktree 本次跳过；-c/-r 恢复会话不新建。",
    ),
  );
  ctx.writeLine(
    colors.gray(
      "  配置项：.haji/config.json 的 worktree 字段可写 true/false 或 { enabled, root, copy }。",
    ),
  );
}

function printList(ctx: WorktreeCommandContext, repoRoot: string): void {
  const entries = listHajiWorktrees(repoRoot);
  if (entries.length === 0) {
    ctx.writeLine(colors.gray("还没有 haji 创建的工作树。"));
    return;
  }
  const currentRoot = detectGitRepo(ctx.cwd)?.root;
  const rows = [colors.bold(`haji 工作树（${entries.length}）`)];
  for (const entry of entries) {
    const isCurrent =
      currentRoot !== undefined && normalizePathKey(entry.path) === normalizePathKey(currentRoot);
    const marker = isCurrent ? colors.okLine(" · 当前") : "";
    rows.push(`  ${colors.purple((entry.branch ?? "").padEnd(34))} ${entry.path}${marker}`);
  }
  ctx.writeChat(`${rows.join("\n")}\n`);
}

function toggle(ctx: WorktreeCommandContext, enable: boolean): void {
  const repo = detectGitRepo(ctx.cwd);
  if (!repo) {
    ctx.writeLine(colors.failLine("当前目录不在 git 仓库内，无法启用自动 worktree。"));
    return;
  }
  const saved = saveWorktreeEnabled(ctx.cwd, enable);
  if (!saved.ok) {
    ctx.writeLine(colors.failLine(`写入配置失败：${saved.error}`));
    return;
  }
  ctx.writeLine(
    colors.okLine(
      enable
        ? `已启用自动 worktree：以后每个新会话都会在独立工作树中启动（${saved.path}）。`
        : `已关闭自动 worktree（${saved.path}）。已创建的工作树仍保留，可用 /worktree list 查看。`,
    ),
  );
  if (enable) {
    ctx.writeLine(
      colors.gray("  提示：新工作树默认落在 ~/.haji/worktrees/ 下，需要时先安装依赖。"),
    );
  }
}

function remove(ctx: WorktreeCommandContext, args: readonly string[]): void {
  const repo = detectGitRepo(ctx.cwd);
  if (!repo) {
    ctx.writeLine(colors.failLine("当前目录不在 git 仓库内。"));
    return;
  }
  let force = false;
  const targets: string[] = [];
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") force = true;
    else targets.push(arg);
  }
  const target = targets.join(" ").trim();
  if (!target) {
    ctx.writeLine(colors.failLine("用法：/worktree remove [--force] <名称|路径>"));
    return;
  }
  const entry = listHajiWorktrees(repo.mainRoot).find(
    (item) =>
      item.branch === target ||
      item.branch === `${WORKTREE_BRANCH_PREFIX}${target}` ||
      item.branch?.endsWith(`/${target}`) ||
      item.path === target,
  );
  if (entry && normalizePathKey(entry.path) === normalizePathKey(repo.root)) {
    ctx.writeLine(colors.failLine("当前会话正在这个工作树里运行，不能移除自己。"));
    return;
  }
  const result = removeWorktree(repo.mainRoot, target, { force });
  if (!result.ok) {
    ctx.writeLine(colors.failLine(`移除失败：${result.error}`));
    return;
  }
  ctx.writeLine(colors.okLine(`已移除工作树：${result.path}`));
  if (result.archivePath) {
    ctx.writeLine(colors.gray(`  会话与快照已归档到：${result.archivePath}`));
  }
  ctx.writeLine(
    colors.gray(
      result.branchRemoved
        ? "  分支已无独有提交，已一并删除。"
        : "  分支仍有未合并提交，已保留；需要时用 git branch -D 删除。",
    ),
  );
}

/** 处理 `/worktree` 命令。 */
export function handleWorktreeCommand(ctx: WorktreeCommandContext, parts: readonly string[]): void {
  const sub = parts[1]?.toLowerCase();
  const repo = detectGitRepo(ctx.cwd);
  if (!sub) {
    printOverview(ctx);
    return;
  }
  if (sub === "on" || sub === "off") {
    toggle(ctx, sub === "on");
    return;
  }
  if (sub === "list" || sub === "ls") {
    if (!repo) {
      ctx.writeLine(colors.warnLine("当前目录不在 git 仓库内。"));
      return;
    }
    printList(ctx, repo.mainRoot);
    return;
  }
  if (sub === "remove" || sub === "rm") {
    remove(ctx, parts.slice(2));
    return;
  }
  if (sub === "help" || sub === "-h" || sub === "--help") {
    usage(ctx);
    return;
  }
  ctx.writeLine(colors.failLine(`未知子命令：${sub}`));
  usage(ctx);
}
