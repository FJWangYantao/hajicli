/**
 * 自动接管策略：判定一个开放 PR 是否该被巡检接管，以及是否允许自动合并。
 *
 * 纯函数，service（真正登记）与 hint（侧栏探测计数）共用同一份判定，
 * 避免「侧栏说有 2 个待接管、点下去只接管 1 个」这类不一致。
 *
 * 两个层级刻意分开：
 * - **接管**（adopted）：谁来审。可以放宽到「本人提交」或「带授权 label」。
 * - **自动合并授权**（mergeAuthorized）：谁能被自动合并。分支前缀只证明「这是我 agent 的
 *   命名空间」，不能证明「提交者是本人」——别人用同样前缀提的 PR 会被接管审查，但不自动合并。
 */

export interface AdoptablePullRequest {
  branch: string;
  /** PR 作者登录名（GitHub 的 user.login）；适配器不提供时缺省。 */
  author?: string;
  /** PR 的 label 名列表。 */
  labels?: string[];
}

export interface AdoptPolicy {
  /** 分支前缀，命中任一即接管。 */
  branchPrefixes: readonly string[];
  /** 是否接管「本人提交」的 PR（任意分支）。 */
  selfAuthored: boolean;
  /** 命中任一 label 即接管。 */
  labels: readonly string[];
  /** 当前令牌对应的登录名；解析不到时为 null（只能靠前缀 / label 判定）。 */
  viewerLogin: string | null;
}

export interface AdoptDecision {
  /** 是否建立巡检任务。 */
  adopted: boolean;
  /** 是否允许自动合并；adopted=false 时无意义。 */
  mergeAuthorized: boolean;
  /** 命中的分支前缀（未命中为 undefined）。 */
  matchedPrefix?: string;
  /** 人类可读的接管原因，用于日志与状态评论。 */
  reason: string;
}

/** 返回分支命中的自动接管前缀；未命中返回 undefined。 */
export function matchAdoptPrefix(branch: string, prefixes: readonly string[]): string | undefined {
  return prefixes.find((prefix) => prefix !== "" && branch.startsWith(prefix));
}

export function decideAdoption(pr: AdoptablePullRequest, policy: AdoptPolicy): AdoptDecision {
  const viewer = policy.viewerLogin;
  const own = viewer !== null && pr.author !== undefined && pr.author === viewer;
  const matchedPrefix = matchAdoptPrefix(pr.branch, policy.branchPrefixes);
  const matchedLabel = (pr.labels ?? []).find((label) => policy.labels.includes(label));

  const adopted =
    Boolean(matchedPrefix) || matchedLabel !== undefined || (own && policy.selfAuthored);

  // 授权合并的三种依据：本人提交、授权 label、或「解析不到登录名时退回前缀」。
  const mergeAuthorized =
    own || matchedLabel !== undefined || (matchedPrefix !== undefined && viewer === null);

  const reasons: string[] = [];
  if (matchedPrefix) reasons.push(`分支前缀 ${matchedPrefix}`);
  if (matchedLabel) reasons.push(`label ${matchedLabel}`);
  if (own) reasons.push("本人提交");

  return {
    adopted,
    mergeAuthorized,
    ...(matchedPrefix ? { matchedPrefix } : {}),
    reason: reasons.length > 0 ? reasons.join(" / ") : "未命中接管条件",
  };
}
