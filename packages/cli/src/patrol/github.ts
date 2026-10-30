/**
 * GitHub REST 适配器：不引入新依赖，fetch + token。
 *
 * - token 取 options.token 或 GH_TOKEN / GITHUB_TOKEN；缺 token 时仍可读公开仓库，
 *   写操作（评论 / 合并 / 关闭）会直接失败并给出可读错误；
 * - merge 带 headSha 条件（GitHub 的 sha 参数），远端 head 不匹配时 GitHub 返回 409，
 *   适配层把它转成错误而不是误合并；「已被合并」识别为幂等成功。
 */
import type { PatrolCheckInfo } from "@hajicli/core";
import type { ForgePullRequest, PatrolForgeAdapter } from "./types.js";

export interface GitHubPatrolOptions {
  /** `owner/name`。 */
  repo: string;
  token?: string;
  /** 默认 https://api.github.com（GHES / 代理可覆盖）。 */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const GITHUB_ACCEPT = "application/vnd.github+json";

interface GhPullRequest {
  number: number;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  title?: string;
  updated_at?: string;
  mergeable?: boolean | null;
  head?: { sha?: string; ref?: string };
  base?: { sha?: string; ref?: string };
}

interface GhCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  app?: { slug?: string };
}

interface GhComment {
  id: number;
  body?: string;
}

export class GitHubPatrolAdapter implements PatrolForgeAdapter {
  readonly repo: string;
  private readonly token: string | undefined;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubPatrolOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
      throw new Error(`无效的 GitHub 仓库标识: ${options.repo}（应为 owner/name）`);
    }
    this.repo = options.repo;
    this.token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    this.apiBase = (options.apiBase || "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async listOpenPullRequests(): Promise<ForgePullRequest[]> {
    const data = await this.requestJson<GhPullRequest[]>(
      `/repos/${this.repo}/pulls?state=open&per_page=100`,
    );
    return data.map((pr) => this.mapPullRequest(pr));
  }

  async getPullRequest(number: number): Promise<ForgePullRequest | null> {
    try {
      const pr = await this.requestJson<GhPullRequest>(`/repos/${this.repo}/pulls/${number}`);
      return this.mapPullRequest(pr);
    } catch (error) {
      if ((error as GitHubApiError).status === 404) return null;
      throw error;
    }
  }

  async listCheckRuns(headSha: string): Promise<PatrolCheckInfo[]> {
    const data = await this.requestJson<{ check_runs?: GhCheckRun[] }>(
      `/repos/${this.repo}/commits/${headSha}/check-runs?per_page=100`,
    );
    return (data.check_runs ?? []).map((run) => ({
      name: run.name || "unnamed-check",
      status: mapCheckStatus(run.status, run.conclusion),
      appSlug: run.app?.slug,
    }));
  }

  async getDiff(number: number): Promise<string> {
    return this.requestText(`/repos/${this.repo}/pulls/${number}`, "application/vnd.github.diff");
  }

  async postStatusComment(number: number, marker: string, body: string): Promise<void> {
    const comments = await this.requestJson<GhComment[]>(
      `/repos/${this.repo}/issues/${number}/comments?per_page=100`,
    );
    const target = comments.find((comment) => (comment.body || "").includes(marker));
    const payload = JSON.stringify({ body });
    if (target) {
      await this.requestJson(`/repos/${this.repo}/issues/comments/${target.id}`, {
        method: "PATCH",
        body: payload,
      });
      return;
    }
    await this.requestJson(`/repos/${this.repo}/issues/${number}/comments`, {
      method: "POST",
      body: payload,
    });
  }

  async merge(
    number: number,
    options: { headSha: string; method?: "merge" | "squash" | "rebase" },
  ): Promise<{ merged: boolean; sha?: string; alreadyMerged?: boolean }> {
    try {
      const result = await this.requestJson<{ merged?: boolean; sha?: string }>(
        `/repos/${this.repo}/pulls/${number}/merge`,
        {
          method: "PUT",
          body: JSON.stringify({ sha: options.headSha, merge_method: options.method ?? "merge" }),
        },
      );
      return { merged: result.merged === true, sha: result.sha };
    } catch (error) {
      const apiError = error as GitHubApiError;
      const message = `${apiError.message ?? ""}`;
      if (apiError.status === 409 || apiError.status === 422) {
        if (/has already been merged|was merged already/i.test(message)) {
          return { merged: true, alreadyMerged: true };
        }
      }
      throw error;
    }
  }

  async close(number: number): Promise<void> {
    await this.requestJson(`/repos/${this.repo}/pulls/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }

  private mapPullRequest(pr: GhPullRequest): ForgePullRequest {
    return {
      repo: this.repo,
      number: pr.number,
      state: pr.state,
      draft: pr.draft === true,
      merged: pr.merged === true || pr.merged_at != null,
      branch: pr.head?.ref ?? "",
      targetBranch: pr.base?.ref ?? "",
      headSha: pr.head?.sha ?? "",
      baseSha: pr.base?.sha ?? "",
      title: pr.title ?? "",
      mergeable: pr.mergeable ?? null,
      updatedAt: pr.updated_at ?? "",
    };
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: GITHUB_ACCEPT,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!response.ok) {
      throw await toApiError(response);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async requestText(path: string, accept: string): Promise<string> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: {
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!response.ok) throw await toApiError(response);
    return response.text();
  }
}

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

/** check run 的 status/conclusion → 巡检门禁状态。未完成一律 pending，不冒充成功。 */
export function mapCheckStatus(
  status: string | undefined,
  conclusion: string | null | undefined,
): PatrolCheckInfo["status"] {
  if (status && status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "neutral":
      return "skipped";
    default:
      // completed 但没有 conclusion：按未完成处理。
      return "pending";
  }
}

async function toApiError(response: Response): Promise<GitHubApiError> {
  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ? `：${body.message}` : "";
  } catch {
    detail = "";
  }
  return new GitHubApiError(response.status, `GitHub API ${response.status}${detail}`);
}
