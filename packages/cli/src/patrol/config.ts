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
   * 自动登记前缀：分支名命中的开放 PR 视为 agent 产出，无需 `/patrol register`。
   * 默认与 worktree 分支前缀一致（`haji/`），置空字符串即关闭自动接管。
   */
  autoAdoptBranchPrefix: string;
}

export const DEFAULT_PATROL_CONFIG: PatrolConfig = {
  repo: "",
  ruleVersion: "v1",
  requiredChecks: [],
  trustedApps: ["github-actions"],
  limits: normalizePatrolLimits(),
  pollIntervalMs: 60_000,
  mergeMethod: "merge",
  autoAdoptBranchPrefix: WORKTREE_BRANCH_PREFIX,
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
    autoAdoptBranchPrefix:
      typeof raw.autoAdoptBranchPrefix === "string"
        ? raw.autoAdoptBranchPrefix.trim()
        : DEFAULT_PATROL_CONFIG.autoAdoptBranchPrefix,
  };
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
