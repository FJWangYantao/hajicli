/**
 * 远端仓库（forge）适配契约。
 *
 * 巡检服务只依赖这组窄接口，不感知具体平台；实现可以来自独立包
 * （如 `@hajicli/patrol-github`），测试注入假实现。
 */
import type { PatrolCheckInfo } from "./merge-gate.js";

export interface ForgePullRequest {
  repo: string;
  number: number;
  state: "open" | "closed";
  draft: boolean;
  /** 关闭且已合并。 */
  merged: boolean;
  branch: string;
  targetBranch: string;
  headSha: string;
  baseSha: string;
  title: string;
  mergeable: boolean | null;
  updatedAt: string;
  /** 作者登录名（GitHub 的 user.login）；适配器无法提供时缺省。 */
  author?: string;
  /** PR 的 label 名列表。 */
  labels?: string[];
}

export interface PatrolForgeAdapter {
  readonly repo: string;
  listOpenPullRequests(): Promise<ForgePullRequest[]>;
  getPullRequest(number: number): Promise<ForgePullRequest | null>;
  /** head 提交上的检查（check runs）。 */
  listCheckRuns(headSha: string): Promise<PatrolCheckInfo[]>;
  /** PR 的完整 diff（文本）。 */
  getDiff(number: number): Promise<string>;
  /** upsert 一条带标记的状态评论（同标记只保留一条，反复刷新）。 */
  postStatusComment(number: number, marker: string, body: string): Promise<void>;
  /**
   * 合并 PR。headSha 用于防止竞态：远端 head 不匹配时必须拒绝。
   * 已被合并的 PR 返回 `{ merged: true, alreadyMerged: true }` 而不是报错。
   */
  merge(
    number: number,
    options: { headSha: string; method?: "merge" | "squash" | "rebase" },
  ): Promise<{ merged: boolean; sha?: string; alreadyMerged?: boolean }>;
  close(number: number): Promise<void>;
  /**
   * 当前令牌对应的登录名，用于「本人提交」判定；适配器不支持或读不到时返回 null。
   * 可选：缺省实现时按「无法判定作者」处理（只靠分支前缀 / label 接管）。
   */
  getViewerLogin?(): Promise<string | null>;
}
