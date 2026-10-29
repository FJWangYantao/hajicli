import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPermissionGrant } from "./cli-runtime.js";

export type PermissionRuleScope = "user" | "project";

export interface PermissionRuleEntry {
  /** 与会话授权表同形态的键：bash 为命令前缀（bash:npm test），其余为工具名或路径前缀。 */
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

/** 用户级路径规则：工作区外的读写按 glob 放行 / 禁止。 */
export interface PermissionPathRules {
  allow: string[];
  deny: string[];
}

export interface PersistentPermissionHit {
  entry: PermissionRuleEntry;
  scope: PermissionRuleScope;
}

interface PermissionRuleFile {
  version: number;
  allow: PermissionRuleEntry[];
  /** 路径规则只从用户级文件读取：项目级配置不能自行扩大可写范围。 */
  paths?: { allow: string[]; deny: string[] };
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

/** 读取完整规则文档（allow 条目 + 路径规则），损坏时返回空文档。 */
function readRulesDocument(filePath: string): PermissionRuleFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PermissionRuleFile>;
    if (!parsed || typeof parsed !== "object") return { version: 1, allow: [] };
    const allow = Array.isArray(parsed.allow)
      ? parsed.allow.filter(
          (entry): entry is PermissionRuleEntry =>
            Boolean(entry) && typeof entry.key === "string" && entry.key.trim().length > 0,
        )
      : [];
    const paths = sanitizePathRules(parsed.paths);
    return { version: 1, allow, ...(paths ? { paths } : {}) };
  } catch {
    // 文件不存在、损坏或结构非法时一律按空规则处理
    return { version: 1, allow: [] };
  }
}

function sanitizePathRules(input: unknown): { allow: string[]; deny: string[] } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as { allow?: unknown; deny?: unknown };
  const pick = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  return { allow: pick(candidate.allow), deny: pick(candidate.deny) };
}

function readRulesFile(filePath: string): PermissionRuleEntry[] {
  return readRulesDocument(filePath).allow;
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
 * 路径规则只认用户级 `~/.haji/permissions.json`。项目级文件随仓库分发，
 * 若允许它声明 `paths.allow: ["C:/"]` 就等于克隆即扩权，因此这里刻意忽略项目级。
 */
export function loadUserPathRules(): PermissionPathRules {
  const paths = readRulesDocument(userPermissionRulesPath()).paths;
  return { allow: paths?.allow ?? [], deny: paths?.deny ?? [] };
}

export type PermissionPathRuleKind = "allow" | "deny";

/** 追加一条用户级路径规则（读盘—去重—写回）。成功返回 true。 */
export function saveUserPathRule(kind: PermissionPathRuleKind, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.length > 500 || trimmed.includes("\0")) return false;
  const file = readRulesDocument(userPermissionRulesPath());
  const paths = file.paths ?? { allow: [], deny: [] };
  const list = kind === "allow" ? paths.allow : paths.deny;
  if (!list.includes(trimmed)) list.push(trimmed);
  file.paths = paths;
  return writeRulesDocument(file, "user");
}

/** 删除一条用户级路径规则；不存在时不写盘。 */
export function removeUserPathRule(kind: PermissionPathRuleKind, pattern: string): boolean {
  const file = readRulesDocument(userPermissionRulesPath());
  const paths = file.paths;
  if (!paths) return false;
  const before = kind === "allow" ? paths.allow : paths.deny;
  const next = before.filter((item) => item !== pattern);
  if (next.length === before.length) return false;
  if (kind === "allow") paths.allow = next;
  else paths.deny = next;
  file.paths = paths;
  return writeRulesDocument(file, "user");
}

/**
 * 判断工具调用是否命中持久化放行规则：项目级与用户级任一命中即放行。
 * 键由调用方给出（getPermissionGrant 或工作区外路径的路径前缀授权键；
 * 无法按前缀安全匹配的组合命令永远不会命中，也不会被写入）。
 */
export function isToolAllowedPersistently(
  toolName: string,
  args: Record<string, unknown>,
  rules: LoadedPermissionRules,
  grant = getPermissionGrant(toolName, args),
): PersistentPermissionHit | undefined {
  if (!grant) return undefined;
  const projectHit = rules.project.find((entry) => entry.key === grant.key);
  if (projectHit) return { entry: projectHit, scope: "project" };
  const userHit = rules.user.find((entry) => entry.key === grant.key);
  if (userHit) return { entry: userHit, scope: "user" };
  return undefined;
}

function writeRulesDocument(file: PermissionRuleFile, scope: PermissionRuleScope): boolean {
  const filePath = permissionRulesPath(scope);
  const document: PermissionRuleFile = {
    version: 1,
    allow: file.allow,
    ...(file.paths ? { paths: { allow: file.paths.allow, deny: file.paths.deny } } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(document, null, 2), "utf8");
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
  const document = readRulesDocument(permissionRulesPath(scope));
  const entries = document.allow;
  const existing = entries.find((item) => item.key === entry.key);
  if (existing) {
    existing.scope = entry.scope;
  } else {
    entries.push({ ...entry });
  }
  document.allow = entries;
  return writeRulesDocument(document, scope);
}

/**
 * 删除一条持久化放行规则。key 不存在时不写盘并返回 false。
 */
export function removePermissionRule(key: string, scope: PermissionRuleScope): boolean {
  const document = readRulesDocument(permissionRulesPath(scope));
  const next = document.allow.filter((item) => item.key !== key);
  if (next.length === document.allow.length) return false;
  document.allow = next;
  return writeRulesDocument(document, scope);
}

/**
 * 把命令行给的放行键（无头模式 `--allow`）并入内存规则视图：**只作用于本次进程，不落盘**。
 *
 * 键形态与持久化规则完全一致（`getPermissionGrant` 的产物）：`bash:<命令前缀>` 或工具名。
 * 归一化时整体转小写——`getPermissionGrant` 对 bash 前缀做小写化，工具名本身也全是小写，
 * 这样 `--allow "bash:NPM test"` 与 `bash:npm test` 等价。空键与非法键直接忽略（解析层已校验）。
 */
export function withCliAllowKeys(
  rules: LoadedPermissionRules,
  keys: readonly string[],
): LoadedPermissionRules {
  if (keys.length === 0) return rules;
  const createdAt = new Date().toISOString();
  const extra: PermissionRuleEntry[] = [];
  for (const raw of keys) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const scope = key.startsWith("bash:") ? `${key.slice("bash:".length)} 开头的命令` : key;
    if (rules.project.some((entry) => entry.key === key)) continue;
    if (extra.some((entry) => entry.key === key)) continue;
    extra.push({ key, scope: `命令行 --allow：${scope}`, createdAt });
  }
  if (extra.length === 0) return rules;
  // 放进 project 桶（isToolAllowedPersistently 先查它）：命令行授权优先于用户级规则。
  return { ...rules, project: [...extra, ...rules.project] };
}
