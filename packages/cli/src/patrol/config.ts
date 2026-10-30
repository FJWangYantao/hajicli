/**
 * 巡检配置：`.haji/patrol/config.json` 覆盖默认值。
 * ruleVersion 变更后旧结论按版本不一致处理，触发重审。
 */
import fs from "node:fs";
import path from "node:path";
import { normalizePatrolLimits, type PatrolLimits } from "@hajicli/core";

export interface PatrolConfig {
  repo: string;
  /** 规则版本：变更即作废旧结论。 */
  ruleVersion: string;
  requiredChecks: string[];
  trustedApps: string[];
  limits: PatrolLimits;
  pollIntervalMs: number;
  mergeMethod: "merge" | "squash" | "rebase";
}

export const DEFAULT_PATROL_CONFIG: PatrolConfig = {
  repo: "",
  ruleVersion: "v1",
  requiredChecks: [],
  trustedApps: ["github-actions"],
  limits: normalizePatrolLimits(),
  pollIntervalMs: 60_000,
  mergeMethod: "merge",
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
    trustedApps: stringList(raw.trustedApps) || DEFAULT_PATROL_CONFIG.trustedApps,
    limits: normalizePatrolLimits(limitsRaw as Partial<PatrolLimits>),
    pollIntervalMs:
      typeof raw.pollIntervalMs === "number" && raw.pollIntervalMs >= 5_000
        ? Math.trunc(raw.pollIntervalMs)
        : DEFAULT_PATROL_CONFIG.pollIntervalMs,
    mergeMethod:
      raw.mergeMethod === "squash" || raw.mergeMethod === "rebase" || raw.mergeMethod === "merge"
        ? raw.mergeMethod
        : DEFAULT_PATROL_CONFIG.mergeMethod,
  };
}

export function savePatrolConfig(cwd: string, config: PatrolConfig): void {
  fs.mkdirSync(path.dirname(patrolConfigPath(cwd)), { recursive: true });
  fs.writeFileSync(patrolConfigPath(cwd), JSON.stringify(config, null, 2));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
