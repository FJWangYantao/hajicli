import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePathKey } from "@hajicli/core";

/**
 * 追加工作区根（`--add-dir` 之外、`/workspace add` 持久化的部分）。
 *
 * 存到 **用户级** `~/.haji/workspaces.json`，按项目根（realpath）分组：
 * - 不写进项目配置，克隆别人的仓库不会自带“把 C:\ 加进工作区”的条目；
 * - 只在本机生效，换机器需要重新添加（与 permissions.json 的全局作用域同思路）。
 */
interface WorkspaceRootsEntry {
  roots: string[];
  updatedAt: string;
}

interface WorkspaceRootsFile {
  version: number;
  projects: Record<string, WorkspaceRootsEntry>;
}

export function workspaceRootsFilePath(): string {
  return path.join(os.homedir(), ".haji", "workspaces.json");
}

/** 项目标识：realpath（不存在时用 resolve）+ 统一口径的路径键。 */
export function workspaceProjectKey(cwd: string = process.cwd()): string {
  let resolved = path.resolve(cwd);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // 目录不存在时退回 resolve 结果
  }
  return normalizePathKey(resolved);
}

function readRootsFile(filePath: string): WorkspaceRootsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WorkspaceRootsFile>;
    const projects: Record<string, WorkspaceRootsEntry> = {};
    if (parsed && typeof parsed === "object" && parsed.projects) {
      for (const [key, entry] of Object.entries(parsed.projects)) {
        if (!entry || !Array.isArray(entry.roots)) continue;
        const roots = entry.roots.filter(
          (root): root is string => typeof root === "string" && root.trim().length > 0,
        );
        projects[key] = {
          roots,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
        };
      }
    }
    return { version: 1, projects };
  } catch {
    // 文件不存在、损坏或结构非法时一律按空配置处理
    return { version: 1, projects: {} };
  }
}

function writeRootsFile(file: WorkspaceRootsFile): boolean {
  const filePath = workspaceRootsFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2), "utf8");
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows 上可能无效，忽略
    }
    return true;
  } catch {
    return false;
  }
}

/** 读取当前项目的追加工作区根；已不存在的目录自动跳过。 */
export function loadWorkspaceRoots(cwd: string = process.cwd()): string[] {
  const file = readRootsFile(workspaceRootsFilePath());
  const entry = file.projects[workspaceProjectKey(cwd)];
  if (!entry) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const root of entry.roots) {
    if (!isUsableDirectory(root)) continue;
    const key = normalizePathKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(path.resolve(root));
  }
  return roots;
}

function isUsableDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 规范化一个待添加的目录：展开 `~`、相对路径按 cwd 解析、必须已存在且是目录。
 * 返回绝对路径；失败时给出用户可读原因。
 */
export function normalizeWorkspaceRoot(
  input: string,
  cwd: string = process.cwd(),
): { ok: true; root: string } | { ok: false; error: string } {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return { ok: false, error: "路径不能为空" };
  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  const resolved = path.resolve(cwd, expanded);
  if (!isUsableDirectory(resolved)) {
    return { ok: false, error: `目录不存在或不是目录：${resolved}` };
  }
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // 保留 resolve 结果
  }
  return { ok: true, root: real };
}

/** 把目录写入当前项目的追加根列表（读盘—改—整体写回）。 */
export function addWorkspaceRoot(
  input: string,
  cwd: string = process.cwd(),
): { ok: true; root: string } | { ok: false; error: string } {
  const normalized = normalizeWorkspaceRoot(input, cwd);
  if (!normalized.ok) return normalized;
  if (normalizePathKey(normalized.root) === workspaceProjectKey(cwd)) {
    return { ok: false, error: "该目录就是当前工作区根，无需添加" };
  }
  const file = readRootsFile(workspaceRootsFilePath());
  const key = workspaceProjectKey(cwd);
  const entry = file.projects[key] ?? { roots: [], updatedAt: "" };
  if (!entry.roots.some((root) => normalizePathKey(root) === normalizePathKey(normalized.root))) {
    entry.roots.push(normalized.root);
  }
  entry.updatedAt = new Date().toISOString();
  file.projects[key] = entry;
  if (!writeRootsFile(file)) return { ok: false, error: "写入 ~/.haji/workspaces.json 失败" };
  return { ok: true, root: normalized.root };
}

/** 从当前项目的追加根列表移除目录；未命中时不写盘。 */
export function removeWorkspaceRoot(
  input: string,
  cwd: string = process.cwd(),
): { ok: boolean; root?: string; error?: string } {
  const file = readRootsFile(workspaceRootsFilePath());
  const key = workspaceProjectKey(cwd);
  const entry = file.projects[key];
  if (!entry || entry.roots.length === 0) return { ok: false, error: "当前项目没有追加的工作区根" };
  const normalized = normalizeWorkspaceRoot(input, cwd);
  const targetKey = normalized.ok
    ? normalizePathKey(normalized.root)
    : normalizePathKey(input.trim().replace(/^["']|["']$/g, ""));
  const index = entry.roots.findIndex((root) => normalizePathKey(root) === targetKey);
  if (index === -1) return { ok: false, error: `未找到追加目录：${input}` };
  const [removed] = entry.roots.splice(index, 1);
  if (entry.roots.length === 0) delete file.projects[key];
  else entry.updatedAt = new Date().toISOString();
  if (!writeRootsFile(file)) return { ok: false, error: "写入 ~/.haji/workspaces.json 失败" };
  return { ok: true, root: removed };
}
