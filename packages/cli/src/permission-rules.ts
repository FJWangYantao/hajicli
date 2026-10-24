import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPermissionGrant } from "./cli-runtime.js";

export type PermissionRuleScope = "user" | "project";

export interface PermissionRuleEntry {
  /** 与会话授权表同形态的键：bash 为命令前缀（bash:npm test），其余为工具名。 */
  key: string;
  /** 授权范围描述（如“npm test 开头的命令”），用于 /permissions 列表展示。 */
  scope: string;
  /** 写入时间（ISO 字符串）。 */
  createdAt: string;
}

/** 两级作用域各自加载出的持久化放行规则。 */
export interface LoadedPermissionRules {
  user: PermissionRuleEntry[];
  project: PermissionRuleEntry[];
}

export interface PersistentPermissionHit {
  entry: PermissionRuleEntry;
  scope: PermissionRuleScope;
}

interface PermissionRuleFile {
  version: number;
  allow: PermissionRuleEntry[];
}

export function userPermissionRulesPath(): string {
  return path.join(os.homedir(), ".haji", "permissions.json");
}

export function projectPermissionRulesPath(): string {
  return path.join(process.cwd(), ".haji", "permissions.json");
}

export function permissionRulesPath(scope: PermissionRuleScope): string {
  return scope === "project" ? projectPermissionRulesPath() : userPermissionRulesPath();
}

function readRulesFile(filePath: string): PermissionRuleEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PermissionRuleFile>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.allow)) return [];
    return parsed.allow.filter(
      (entry): entry is PermissionRuleEntry =>
        Boolean(entry) && typeof entry.key === "string" && entry.key.trim().length > 0,
    );
  } catch {
    // 文件不存在、损坏或结构非法时一律按空规则处理
    return [];
  }
}

/** 读取单一作用域的持久化放行规则。 */
export function loadPermissionRulesScope(scope: PermissionRuleScope): PermissionRuleEntry[] {
  return readRulesFile(permissionRulesPath(scope));
}

export function loadAllPermissionRules(): LoadedPermissionRules {
  return {
    user: readRulesFile(userPermissionRulesPath()),
    project: readRulesFile(projectPermissionRulesPath()),
  };
}

/**
 * 判断工具调用是否命中持久化放行规则：项目级与用户级任一命中即放行。
 * 键由 getPermissionGrant 计算（bash 按命令前缀；无法按前缀安全匹配的组合命令
 * 永远不会命中，也不会被写入）。
 */
export function isToolAllowedPersistently(
  toolName: string,
  args: Record<string, unknown>,
  rules: LoadedPermissionRules,
): PersistentPermissionHit | undefined {
  const grant = getPermissionGrant(toolName, args);
  if (!grant) return undefined;
  const projectHit = rules.project.find((entry) => entry.key === grant.key);
  if (projectHit) return { entry: projectHit, scope: "project" };
  const userHit = rules.user.find((entry) => entry.key === grant.key);
  if (userHit) return { entry: userHit, scope: "user" };
  return undefined;
}

function writeRulesFile(entries: PermissionRuleEntry[], scope: PermissionRuleScope): boolean {
  const filePath = permissionRulesPath(scope);
  const file: PermissionRuleFile = { version: 1, allow: entries };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2), "utf8");
    // 尽量收紧文件权限；Windows 上可能无效，忽略失败
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // 忽略权限设置失败
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 追加一条持久化放行规则（读盘—按 key 去重—整体写回）。
 * 同 key 已存在时仅刷新范围描述、保留原写入时间。成功返回 true。
 */
export function savePermissionRule(
  entry: PermissionRuleEntry,
  scope: PermissionRuleScope,
): boolean {
  const entries = readRulesFile(permissionRulesPath(scope));
  const existing = entries.find((item) => item.key === entry.key);
  if (existing) {
    existing.scope = entry.scope;
  } else {
    entries.push({ ...entry });
  }
  return writeRulesFile(entries, scope);
}

/**
 * 删除一条持久化放行规则。key 不存在时不写盘并返回 false。
 */
export function removePermissionRule(key: string, scope: PermissionRuleScope): boolean {
  const entries = readRulesFile(permissionRulesPath(scope));
  const next = entries.filter((item) => item.key !== key);
  if (next.length === entries.length) return false;
  return writeRulesFile(next, scope);
}
