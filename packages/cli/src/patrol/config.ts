/**
 * 巡检配置：`.haji/patrol/config.json` 覆盖默认值。
 * ruleVersion 变更后旧结论按版本不一致处理，触发重审。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizePatrolLimits, type PatrolLimits } from "@hajicli/core";
import { WORKTREE_BRANCH_PREFIX } from "../worktree.js";

export interface PatrolConfig {
  repo: string;
  /** 规则版本：变更即作废旧结论。 */
  ruleVersion: string;
  requiredChecks: string[];
  trustedApps: string[];
  limits: PatrolLimits;
  pollIntervalMs: number;
  mergeMethod: "merge" | "squash" | "rebase";
  /**
   * 自动登记前缀（多个）：分支名命中任一前缀的开放 PR 视为 agent 产出，无需 `/patrol register`。
   * 默认与 worktree 分支前缀一致（`haji/`）；置空数组即关闭自动接管。
   */
  autoAdoptBranchPrefixes: string[];
  /**
   * 是否接管「当前令牌本人提交」的 PR（任意分支）。
   * 默认 false：开启后你自己的 PR 也会被审查 / 自动合并，属于显式选择。
   */
  autoAdoptSelfAuthored: boolean;
  /** 带任一 label 的开放 PR 视为已授权接管（也可授权自动合并）。默认空。 */
  autoAdoptLabels: string[];
}

export const DEFAULT_PATROL_CONFIG: PatrolConfig = {
  repo: "",
  ruleVersion: "v1",
  requiredChecks: [],
  trustedApps: ["github-actions"],
  limits: normalizePatrolLimits(),
  pollIntervalMs: 60_000,
  mergeMethod: "merge",
  autoAdoptBranchPrefixes: [WORKTREE_BRANCH_PREFIX],
  autoAdoptSelfAuthored: false,
  autoAdoptLabels: [],
};

export function patrolConfigPath(cwd: string): string {
  return path.join(cwd, ".haji", "patrol", "config.json");
}

export function loadPatrolConfig(cwd: string): PatrolConfig {
  const file = patrolConfigPath(cwd);
  let raw: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file))
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`巡检配置读取失败（${file}）：${(error as Error).message}`);
  }
  const limitsRaw = (raw.limits ?? {}) as Record<string, unknown>;
  return {
    repo: typeof raw.repo === "string" ? raw.repo : DEFAULT_PATROL_CONFIG.repo,
    ruleVersion:
      typeof raw.ruleVersion === "string" ? raw.ruleVersion : DEFAULT_PATROL_CONFIG.ruleVersion,
    requiredChecks: stringList(raw.requiredChecks),
    trustedApps:
      raw.trustedApps === undefined
        ? [...DEFAULT_PATROL_CONFIG.trustedApps]
        : stringList(raw.trustedApps),
    limits: normalizePatrolLimits(limitsRaw as Partial<PatrolLimits>),
    pollIntervalMs:
      typeof raw.pollIntervalMs === "number" && raw.pollIntervalMs >= 5_000
        ? Math.trunc(raw.pollIntervalMs)
        : DEFAULT_PATROL_CONFIG.pollIntervalMs,
    mergeMethod:
      raw.mergeMethod === "squash" || raw.mergeMethod === "rebase" || raw.mergeMethod === "merge"
        ? raw.mergeMethod
        : DEFAULT_PATROL_CONFIG.mergeMethod,
    autoAdoptBranchPrefixes: adoptPrefixesFrom(raw),
    autoAdoptSelfAuthored:
      typeof raw.autoAdoptSelfAuthored === "boolean"
        ? raw.autoAdoptSelfAuthored
        : DEFAULT_PATROL_CONFIG.autoAdoptSelfAuthored,
    autoAdoptLabels: [...new Set(stringList(raw.autoAdoptLabels))],
  };
}

/**
 * 自动接管前缀：新键 `autoAdoptBranchPrefixes`（数组或单个字符串）优先，
 * 兼容旧键 `autoAdoptBranchPrefix`；两者都缺省时用默认值。
 * 显式 `[]` / `""` 表示关闭自动接管，不会被当成「未配置」。
 */
function adoptPrefixesFrom(raw: Record<string, unknown>): string[] {
  const value = raw.autoAdoptBranchPrefixes ?? raw.autoAdoptBranchPrefix;
  if (value === undefined) return [...DEFAULT_PATROL_CONFIG.autoAdoptBranchPrefixes];
  return stringOrList(value);
}

/**
 * 巡检仓库：`config.json` 的 `repo` 优先，缺省时从 `git remote origin` 推断，
 * 这样配好 GitHub 的仓库无需任何配置文件即可启动巡检。
 */
export function resolvePatrolRepo(cwd: string): string | undefined {
  return loadPatrolConfig(cwd).repo.trim() || repoFromGitRemote(cwd);
}

/** 把 remote URL 归一成 `owner/name`；本地路径 / 无 remote 时返回 undefined。 */
export function repoFromGitRemote(cwd: string, remote = "origin"): string | undefined {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", remote], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  return parseRepoFromRemote(url);
}

export function parseRepoFromRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  // 只接受远端形态：`scheme://[user@]host[:port]/owner/name` 或 `user@host:owner/name`。
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?[^/]*\/?(.*)$/i.exec(trimmed);
  const scpLike = /^[^/@\s]+@[^/\s:]+:(.+)$/.exec(trimmed);
  const rest = withScheme ? withScheme[1] : scpLike ? scpLike[1] : undefined;
  if (rest === undefined) return undefined;
  const segments = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  // 必须恰好是 owner/name 两段：单段（只有 host）或多段（子路径 / 本地路径）都无法映射。
  if (segments.length !== 2) return undefined;
  return `${segments[0]}/${segments[1]}`;
}

export function savePatrolConfig(cwd: string, config: PatrolConfig): void {
  fs.mkdirSync(path.dirname(patrolConfigPath(cwd)), { recursive: true });
  fs.writeFileSync(patrolConfigPath(cwd), JSON.stringify(config, null, 2));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

/** 单个字符串视作一元列表，其余按数组处理。 */
function stringOrList(value: unknown): string[] {
  return typeof value === "string" ? stringList([value]) : stringList(value);
}
