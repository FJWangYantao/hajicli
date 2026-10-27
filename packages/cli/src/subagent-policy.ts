/**
 * 工具触发的子代理访问级别判定（纯函数）。
 *
 * 旧行为：非 Plan 一律 workspace-write，导致 research/review 也独占写锁。
 * 实验行为（subagent_access=role）：只有 implement 需要写权限，research/review 只读；
 * Plan 模式无论实验 arm 都只读。
 */
export type SubagentAccess = "readonly" | "workspace-write";

export interface ToolSubagentAccessInput {
  role?: string;
  permissionMode?: string;
  /** A/B：是否按 role 分配（false = 旧的“非 Plan 即可写”）。 */
  roleBased: boolean;
}

export function resolveToolSubagentAccess(input: ToolSubagentAccessInput): SubagentAccess {
  if (input.permissionMode === "plan") return "readonly";
  if (!input.roleBased) return "workspace-write";
  const role = input.role || "research";
  return role === "implement" ? "workspace-write" : "readonly";
}
