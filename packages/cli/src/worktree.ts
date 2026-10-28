/**
 * 自动 worktree：每个新会话在独立的 git 工作树里启动，方便多进程并行。
 *
 * 约定：
 * - 开关写在**主仓库**的 `.haji/config.json` 的 `worktree` 字段，形如
 *   `true` / `false` / `{ "enabled": true, "root": "...", "copy": [".env"] }`；
 * - 新工作树默认落在 `~/.haji/worktrees/<仓库名>-<路径指纹>/<会话名>`，分支为 `haji/<会话名>`，
 *   这样不会污染仓库目录，也便于 `/worktree list` 识别与清理；
 * - 只在「新会话」时创建：`-c/-r` 恢复会话、已经在 linked worktree 里启动都会跳过，
 *   避免层层嵌套；无头 `-p` 同样生效（每次调用一个隔离工作树）。
 *
 * 本模块只做纯文件/子进程操作，不读会话状态，方便单测直接跑真实 git。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePathKey } from "@hajicli/core";

/** 新建分支前缀：`/worktree list` 与清理逻辑都靠它识别 haji 创建的工作树。 */
export const WORKTREE_BRANCH_PREFIX = "haji/";

/** 主工作树里这些 `.haji` 内容会复制到新工作树（会话/快照等运行数据不复制）。 */
const HAJI_CARRY_FILES = ["config.json", "preferences.json", "permissions.json"];
const HAJI_CARRY_DIRS = ["skills", "agents"];

/** 默认额外拷贝的未跟踪文件：本地环境变量（仓库里已跟踪的不用拷）。 */
const DEFAULT_COPY = [".env", ".env.local", ".env.development.local"];

export interface WorktreeSetting {
  enabled: boolean;
  /** 存放目录模板，支持 `~` 与 `{repo}` / `{id}` / `{name}` 占位；缺省用内置目录。 */
  root?: string;
  /** 额外从主工作树拷贝的未跟踪文件（相对仓库根）。 */
  copy: string[];
}

export interface GitRepoInfo {
  /** 当前 checkout 根目录。 */
  root: string;
  /** 主工作树根目录（`git worktree add` 的基准仓库）。 */
  mainRoot: string;
  /** 当前目录是否位于 linked worktree（`git worktree add` 创建出来的 checkout）。 */
  linked: boolean;
}

export interface SessionWorktreeInfo {
  /** 新工作树根目录。 */
  path: string;
  /** 新分支名（`haji/...`）。 */
  branch: string;
  /** 基准分支（当前分支；分离 HEAD 时为提交号）。 */
  base: string;
  repoRoot: string;
  mainRoot: string;
  copied: string[];
  warnings: string[];
}

export type PrepareWorktreeResult =
  | { ok: true; info: SessionWorktreeInfo }
  | {
      ok: false;
      /** 跳过原因：不算错误，调用方可以静默继续。 */
      skipped: "no-repo" | "already-linked" | "unborn";
      message: string;
    }
  | { ok: false; error: string };

export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  current: boolean;
}

export interface WorktreeArgParseResult {
  /** `on` = --worktree（本次强制）；`off` = --no-worktree（本次禁用）。 */
  mode?: "on" | "off";
  error?: string;
}

/**
 * 解析 `--worktree` / `--no-worktree`。
 * 两者同时出现视为参数冲突，交回调用方报错，避免「到底听谁的」这种模糊行为。
 */
export function parseWorktreeArgs(args: readonly string[]): WorktreeArgParseResult {
  let mode: "on" | "off" | undefined;
  for (const arg of args) {
    if (arg === "--worktree") {
      if (mode === "off") return { error: "--worktree 与 --no-worktree 不能同时使用" };
      mode = "on";
    } else if (arg === "--no-worktree") {
      if (mode === "on") return { error: "--worktree 与 --no-worktree 不能同时使用" };
      mode = "off";
    }
  }
  return mode ? { mode } : {};
}

/**
 * 向上查找 `.git`，判断当前目录属于主工作树、linked worktree 还是子模块。
 * 纯文件读取，不依赖 git 可执行文件，启动路径上零子进程开销。
 */
export function detectGitRepo(cwd: string): GitRepoInfo | undefined {
  let dir = path.resolve(cwd);
  while (true) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return { root: dir, mainRoot: dir, linked: false };
    if (stat?.isFile()) {
      let gitDirRaw: string | undefined;
      try {
        gitDirRaw = fs
          .readFileSync(dotGit, "utf8")
          .match(/^gitdir:\s*(.+)$/m)?.[1]
          ?.trim();
      } catch {
        gitDirRaw = undefined;
      }
      if (!gitDirRaw) return { root: dir, mainRoot: dir, linked: false };
      const gitDir = path.resolve(dir, gitDirRaw);
      // linked worktree 的 gitdir 形如 <main>/.git/worktrees/<name>。
      if (path.basename(path.dirname(gitDir)) === "worktrees") {
        return { root: dir, mainRoot: path.resolve(gitDir, "..", "..", ".."), linked: true };
      }
      // 子模块的 gitdir 形如 <parent>/.git/modules/<name>：它自己就是一个仓库，可以正常开工作树。
      return { root: dir, mainRoot: dir, linked: false };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 文件不存在 / 损坏 / 不是对象：按未配置处理
  }
  return undefined;
}

/** 用户级与项目级 config.json（项目级 = 主仓库根，避免在 worktree 内重复配置）。 */
export function worktreeConfigPaths(cwd: string = process.cwd()): {
  user: string;
  project: string;
} {
  const mainRoot = detectGitRepo(cwd)?.mainRoot ?? path.resolve(cwd);
  return {
    user: path.join(os.homedir(), ".haji", "config.json"),
    project: path.join(mainRoot, ".haji", "config.json"),
  };
}

function parseSettingValue(raw: unknown): Partial<WorktreeSetting> | undefined {
  if (raw === true) return { enabled: true };
  if (raw === false) return { enabled: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const setting: Partial<WorktreeSetting> = {};
  if (typeof value.enabled === "boolean") setting.enabled = value.enabled;
  if (typeof value.root === "string" && value.root.trim()) setting.root = value.root.trim();
  if (Array.isArray(value.copy)) {
    setting.copy = value.copy.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  return setting;
}

/**
 * 读取生效的 worktree 配置：用户级 → 项目级依次覆盖，缺省关闭。
 * 项目级按「主仓库根」查找，所以在 worktree 里启动时读到的仍是同一个开关。
 */
export function loadWorktreeSetting(cwd: string = process.cwd()): WorktreeSetting {
  const paths = worktreeConfigPaths(cwd);
  const merged: Partial<WorktreeSetting> = {};
  for (const filePath of [paths.user, paths.project]) {
    const parsed = parseSettingValue(readJsonObject(filePath)?.worktree);
    if (parsed) Object.assign(merged, parsed);
  }
  return {
    enabled: merged.enabled === true,
    root: merged.root,
    copy: merged.copy && merged.copy.length > 0 ? merged.copy : [...DEFAULT_COPY],
  };
}

/**
 * 把开关写入主仓库的项目级 `.haji/config.json`（读盘—改—整体写回，保留其他字段）。
 * 在 worktree 内执行时也写回主仓库，避免设置随工作树一起被删掉。
 */
export function saveWorktreeEnabled(
  cwd: string,
  enabled: boolean,
): { ok: true; path: string } | { ok: false; error: string } {
  const target = worktreeConfigPaths(cwd).project;
  const raw = readJsonObject(target) ?? {};
  const existing = parseSettingValue(raw.worktree) ?? {};
  raw.worktree = { ...existing, enabled };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** 仓库路径指纹：同名仓库（如多个 fork）各自有独立目录。 */
function repoFingerprint(mainRoot: string): string {
  return createHash("sha1").update(normalizePathKey(mainRoot)).digest("hex").slice(0, 8);
}

/** 会话名：时间戳 + 短随机串，既可读又不会撞名。 */
export function makeWorktreeName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** 解析工作树存放目录；`{name}` 缺省时自动追加，保证每个会话一个目录。 */
export function resolveWorktreePath(
  setting: WorktreeSetting,
  repo: GitRepoInfo,
  name: string,
): string {
  const repoName = path.basename(repo.mainRoot) || "repo";
  const id = repoFingerprint(repo.mainRoot);
  const template = setting.root?.trim();
  if (!template) {
    return path.join(os.homedir(), ".haji", "worktrees", `${repoName}-${id}`, name);
  }
  let expanded = expandHome(template)
    .replace(/\{repo\}/g, repoName)
    .replace(/\{id\}/g, id)
    .replace(/\{name\}/g, name);
  if (!path.isAbsolute(expanded)) expanded = path.resolve(repo.mainRoot, expanded);
  if (!template.includes("{name}")) expanded = path.join(expanded, name);
  return expanded;
}

function git(
  cwd: string,
  args: readonly string[],
): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout) };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
    return { ok: false, error: (stderr || err.message || "git 执行失败").trim() };
  }
}

/** 仓库是否已有提交（空仓库不能建工作树）。 */
export function hasHeadCommit(repoRoot: string): boolean {
  return git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
}

/** 当前分支名；分离 HEAD 时返回提交号，交给 `git worktree add` 当基准。 */
export function currentBaseRef(repoRoot: string): string {
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.ok) {
    const name = branch.stdout.trim();
    if (name && name !== "HEAD") return name;
  }
  const head = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  return head.ok ? head.stdout.trim() : "HEAD";
}

function isTracked(repoRoot: string, relativePath: string): boolean {
  return git(repoRoot, ["ls-files", "--error-unmatch", "--", relativePath]).ok;
}

function copyIfMissing(source: string, target: string): boolean {
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把主工作树里的项目配置带进新工作树：
 * `.haji` 的配置/技能/子代理定义 + 未跟踪的本地环境文件。
 * 会话、快照、任务等运行数据刻意不拷，保证新会话从干净状态开始。
 */
function carryProjectFiles(
  repoRoot: string,
  worktreePath: string,
  extra: readonly string[],
): string[] {
  const copied: string[] = [];
  const sourceHaji = path.join(repoRoot, ".haji");
  const targetHaji = path.join(worktreePath, ".haji");
  if (fs.existsSync(sourceHaji)) {
    for (const file of HAJI_CARRY_FILES) {
      const source = path.join(sourceHaji, file);
      if (copyIfMissing(source, path.join(targetHaji, file))) copied.push(`.haji/${file}`);
    }
    for (const dir of HAJI_CARRY_DIRS) {
      const source = path.join(sourceHaji, dir);
      const target = path.join(targetHaji, dir);
      if (!fs.existsSync(source) || fs.existsSync(target)) continue;
      try {
        fs.cpSync(source, target, { recursive: true });
        copied.push(`.haji/${dir}/`);
      } catch {
        // 拷贝失败不阻断启动，用户仍可手动补
      }
    }
  }
  for (const relative of extra) {
    const cleaned = relative.trim().replace(/^\.\//, "");
    if (!cleaned || path.isAbsolute(cleaned) || cleaned.split(/[\\/]/).includes("..")) continue;
    if (isTracked(repoRoot, cleaned)) continue;
    if (copyIfMissing(path.join(repoRoot, cleaned), path.join(worktreePath, cleaned))) {
      copied.push(cleaned);
    }
  }
  return copied;
}

function collectWarnings(repoRoot: string, worktreePath: string): string[] {
  const warnings: string[] = [];
  const status = git(repoRoot, ["status", "--porcelain"]);
  if (status.ok && status.stdout.trim()) {
    warnings.push("主工作树有未提交改动：新工作树从当前提交开始，这些改动不会带过去。");
  }
  if (
    fs.existsSync(path.join(worktreePath, "package.json")) &&
    !fs.existsSync(path.join(worktreePath, "node_modules"))
  ) {
    warnings.push("新工作树没有 node_modules，需要时先安装依赖（如 pnpm install）。");
  }
  if (fs.existsSync(path.join(worktreePath, ".gitmodules"))) {
    warnings.push("仓库含子模块：需要时执行 git submodule update --init --recursive。");
  }
  return warnings;
}

/**
 * 为新会话创建独立工作树。
 *
 * 只负责「建目录 + 建分支 + 拷配置」，不切换进程目录；调用方拿到 `info.path`
 * 后自行 `process.chdir()`（并可按启动时的子目录对齐到工作树里的同名子目录）。
 */
export function prepareSessionWorktree(options: {
  cwd: string;
  setting: WorktreeSetting;
  name?: string;
}): PrepareWorktreeResult {
  const repo = detectGitRepo(options.cwd);
  if (!repo) {
    return {
      ok: false,
      skipped: "no-repo",
      message: "当前目录不在 git 仓库内，跳过自动 worktree。",
    };
  }
  if (repo.linked) {
    return {
      ok: false,
      skipped: "already-linked",
      message: "当前已在 worktree 中运行，跳过新建（避免嵌套工作树）。",
    };
  }
  if (!hasHeadCommit(repo.root)) {
    return {
      ok: false,
      skipped: "unborn",
      message: "仓库还没有提交，无法创建 worktree；先提交一次再启用。",
    };
  }

  const base = currentBaseRef(repo.root);
  // 撞名概率极低；仍失败时换一个名字重试一次，避免启动直接崩。
  for (let attempt = 0; attempt < 2; attempt++) {
    const name = options.name ?? makeWorktreeName();
    const branch = `${WORKTREE_BRANCH_PREFIX}${name}`;
    const worktreePath = resolveWorktreePath(options.setting, repo, name);
    try {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    } catch (error) {
      return {
        ok: false,
        error: `创建目录失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const added = git(repo.root, ["worktree", "add", "-b", branch, worktreePath, base]);
    if (!added.ok) {
      if (attempt === 0 && /already exists/i.test(added.error)) continue;
      return { ok: false, error: `git worktree add 失败：${added.error}` };
    }
    const copied = carryProjectFiles(repo.root, worktreePath, options.setting.copy);
    return {
      ok: true,
      info: {
        path: worktreePath,
        branch,
        base,
        repoRoot: repo.root,
        mainRoot: repo.mainRoot,
        copied,
        warnings: collectWarnings(repo.root, worktreePath),
      },
    };
  }
  return { ok: false, error: "git worktree add 失败：分支名重复" };
}

/** 启动目录若在仓库子目录里，切到工作树里的同名子目录（不存在则用工作树根）。 */
export function worktreeTargetCwd(info: SessionWorktreeInfo, originalCwd: string): string {
  const relative = path.relative(info.repoRoot, path.resolve(originalCwd));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return info.path;
  const target = path.join(info.path, relative);
  try {
    if (fs.statSync(target).isDirectory()) return target;
  } catch {
    // 子目录在新提交里不存在时退回工作树根
  }
  return info.path;
}

function parseWorktreeList(output: string, currentRoot: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  const flush = (): void => {
    if (!current.path) return;
    entries.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch,
      current: normalizePathKey(current.path) === normalizePathKey(currentRoot),
    });
    current = {};
  };
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
  }
  flush();
  return entries;
}

/** 列出当前仓库的全部工作树（含主工作树）。 */
export function listWorktrees(repoRoot: string): WorktreeEntry[] {
  const result = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return [];
  return parseWorktreeList(result.stdout, repoRoot);
}

/** 只保留 haji 创建的（分支前缀 `haji/`），供 `/worktree list` 展示与清理。 */
export function listHajiWorktrees(repoRoot: string): WorktreeEntry[] {
  return listWorktrees(repoRoot).filter(
    (entry) => entry.branch?.startsWith(WORKTREE_BRANCH_PREFIX) ?? false,
  );
}

/**
 * 同仓库其他 haji 工作树的会话目录：worktree 模式下每个并行会话的记录
 * 都存在自己那棵树的 `.haji/sessions` 里，主目录看不到。/resume、-c/-r
 * 把这些目录并进检索范围，选中后进程再切到对应的树继续工作。
 */
export function siblingSessionStoreDirs(cwd: string = process.cwd()): string[] {
  const repo = detectGitRepo(cwd);
  if (!repo) return [];
  const currentKey = normalizePathKey(process.cwd());
  const dirs: string[] = [];
  for (const entry of listHajiWorktrees(repo.root)) {
    if (normalizePathKey(entry.path) === currentKey) continue;
    const sessionsDir = path.join(entry.path, ".haji", "sessions");
    if (fs.existsSync(sessionsDir)) dirs.push(sessionsDir);
  }
  return dirs;
}

/**
 * `/worktree remove` 归档下来的会话目录（主仓库 `.haji/worktree-archive/<名称>/sessions`）。
 * 工作树已经删掉，这些会话只能「取回到当前目录继续」，所以与 siblingSessionStoreDirs 分开给。
 */
export function archivedSessionStoreDirs(cwd: string = process.cwd()): string[] {
  const repo = detectGitRepo(cwd);
  if (!repo) return [];
  const archiveRoot = path.join(repo.mainRoot, ".haji", "worktree-archive");
  let names: string[];
  try {
    names = fs.readdirSync(archiveRoot);
  } catch {
    return [];
  }
  return names
    .map((name) => path.join(archiveRoot, name, "sessions"))
    .filter((dir) => fs.existsSync(dir));
}

/**
 * 移除一个 haji 工作树。`force` 用于丢弃未提交改动（与 `git worktree remove --force` 一致）。
 * 移除前先把会话记录与快照复制到主仓库 `.haji/worktree-archive/<名称>/`，
 * 避免工作树一删、里面的对话历史和 /rewind 数据跟着消失。
 * 分支只有在没有独有提交时才会一并删除，避免误删还没合并的工作。
 */
export function removeWorktree(
  repoRoot: string,
  target: string,
  options: { force?: boolean } = {},
):
  | { ok: true; path: string; branchRemoved: boolean; archivePath?: string }
  | { ok: false; error: string } {
  const entries = listWorktrees(repoRoot);
  const resolved = path.resolve(target);
  const entry =
    entries.find((item) => normalizePathKey(item.path) === normalizePathKey(resolved)) ??
    entries.find((item) => item.branch === target) ??
    entries.find((item) => item.branch === `${WORKTREE_BRANCH_PREFIX}${target}`) ??
    entries.find((item) => item.branch?.endsWith(`/${target}`));
  if (!entry) return { ok: false, error: `未找到工作树：${target}` };
  if (normalizePathKey(entry.path) === normalizePathKey(repoRoot)) {
    return { ok: false, error: "不能移除主工作树。" };
  }
  if (!entry.branch?.startsWith(WORKTREE_BRANCH_PREFIX)) {
    return {
      ok: false,
      error: `该工作树不是 haji 创建的（分支 ${entry.branch ?? "detached"}），请用 git worktree remove 处理。`,
    };
  }
  const archivePath = archiveWorktreeData(
    entry.path,
    repoRoot,
    entry.branch.slice(WORKTREE_BRANCH_PREFIX.length),
  );
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(entry.path);
  const removed = git(repoRoot, args);
  if (!removed.ok) {
    return {
      ok: false,
      error: `${removed.error}${options.force ? "" : "（有未提交改动时可用 /worktree remove --force <名称>）"}`,
    };
  }
  // 分支已合并时删除，未合并则保留并提示，绝不静默丢弃提交。
  const branchRemoved = git(repoRoot, ["branch", "-d", entry.branch]).ok;
  return { ok: true, path: entry.path, branchRemoved, archivePath };
}

/** 把工作树里的会话与快照复制到主仓库归档目录；没有可归档数据时返回 undefined。 */
function archiveWorktreeData(
  worktreePath: string,
  repoRoot: string,
  name: string,
): string | undefined {
  const source = path.join(worktreePath, ".haji");
  const items = ["sessions", "snapshots"].filter((item) => fs.existsSync(path.join(source, item)));
  if (items.length === 0) return undefined;
  const destination = path.join(repoRoot, ".haji", "worktree-archive", name);
  try {
    for (const item of items) {
      const target = path.join(destination, item);
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(path.join(source, item), target, { recursive: true, force: true });
    }
    return destination;
  } catch {
    // 归档失败不阻断移除：清理工作树优先，数据仍可由用户自行备份。
    return undefined;
  }
}
