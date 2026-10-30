import assert from "node:assert/strict";
import test from "node:test";

import { GitHubPatrolAdapter, mapCheckStatus } from "../dist/patrol/github.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function makeAdapter(routes, token = "t0k3n") {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const path = url.replace("https://api.github.com", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const route = routes.find((item) => item.path === path && (item.method ?? "GET") === method);
    if (!route) return jsonResponse(404, { message: `no route: ${method} ${path}` });
    return typeof route.response === "function"
      ? route.response()
      : jsonResponse(route.status ?? 200, route.body);
  };
  return { adapter: new GitHubPatrolAdapter({ repo: "owner/repo", token, fetchImpl }), calls };
}

test("mapCheckStatus：未完成与异常结论都不冒充成功", () => {
  assert.equal(mapCheckStatus("completed", "success"), "success");
  assert.equal(mapCheckStatus("in_progress", undefined), "pending");
  assert.equal(mapCheckStatus("queued", undefined), "pending");
  assert.equal(mapCheckStatus("completed", "failure"), "failure");
  assert.equal(mapCheckStatus("completed", "timed_out"), "failure");
  assert.equal(mapCheckStatus("completed", "startup_failure"), "failure");
  assert.equal(mapCheckStatus("completed", "action_required"), "failure");
  assert.equal(mapCheckStatus("completed", "cancelled"), "cancelled");
  assert.equal(mapCheckStatus("completed", "skipped"), "skipped");
  assert.equal(mapCheckStatus("completed", "neutral"), "skipped");
  assert.equal(mapCheckStatus("completed", null), "pending");
});

test("适配器：列出开放 PR 并映射字段", async () => {
  const { adapter } = makeAdapter([
    {
      path: "/repos/owner/repo/pulls?state=open&per_page=100",
      body: [
        {
          number: 7,
          state: "open",
          draft: false,
          title: "fix",
          head: { sha: "aaaa1111", ref: "agent/fix" },
          base: { sha: "bbbb0000", ref: "master" },
        },
      ],
    },
  ]);
  const prs = await adapter.listOpenPullRequests();
  assert.equal(prs.length, 1);
  assert.equal(prs[0].headSha, "aaaa1111");
  assert.equal(prs[0].branch, "agent/fix");
  assert.equal(prs[0].targetBranch, "master");
  assert.equal(prs[0].draft, false);
});

test("适配器：check-runs 映射与 404 容忍", async () => {
  const { adapter } = makeAdapter([
    {
      path: "/repos/owner/repo/commits/aaaa1111/check-runs?per_page=100",
      body: {
        check_runs: [
          {
            name: "ci",
            status: "completed",
            conclusion: "success",
            app: { slug: "github-actions" },
          },
          { name: "other", status: "in_progress", app: { slug: "evil" } },
        ],
      },
    },
    { path: "/repos/owner/repo/pulls/99", status: 404, body: { message: "Not Found" } },
  ]);
  const checks = await adapter.listCheckRuns("aaaa1111");
  assert.deepEqual(checks, [
    { name: "ci", status: "success", appSlug: "github-actions" },
    { name: "other", status: "pending", appSlug: "evil" },
  ]);
  assert.equal(await adapter.getPullRequest(99), null);
});

test("适配器：diff 走专用 Accept；状态评论 upsert（先查再 PATCH/POST）", async () => {
  const routes = [
    { path: "/repos/owner/repo/pulls/7", body: "diff --git a" },
    {
      path: "/repos/owner/repo/issues/7/comments?per_page=100",
      body: [{ id: 42, body: "<!-- haji-patrol:status --> 旧内容" }],
    },
    { method: "PATCH", path: "/repos/owner/repo/issues/comments/42", body: {} },
  ];
  const { adapter, calls } = makeAdapter(routes);
  const diff = await adapter.getDiff(7);
  assert.match(diff, /^diff --git/);
  await adapter.postStatusComment(7, "<!-- haji-patrol:status -->", "新内容");
  const patch = calls.find((call) => call.init?.method === "PATCH");
  assert.ok(patch, "已存在同标记评论时应 PATCH");
  assert.equal(JSON.parse(patch.init.body).body, "新内容");

  // 没有历史评论 → POST
  const { adapter: fresh } = makeAdapter([
    { path: "/repos/owner/repo/issues/8/comments?per_page=100", body: [] },
    { method: "POST", path: "/repos/owner/repo/issues/8/comments", body: {} },
  ]);
  await fresh.postStatusComment(8, "<!-- m -->", "内容");
});

test("适配器：merge 带 sha 条件；已被合并识别为幂等成功", async () => {
  const { adapter } = makeAdapter([
    {
      method: "PUT",
      path: "/repos/owner/repo/pulls/7/merge",
      status: 200,
      body: { merged: true, sha: "merge123" },
    },
    {
      method: "PUT",
      path: "/repos/owner/repo/pulls/8/merge",
      status: 409,
      body: { message: "Pull Request is not mergeable" },
    },
    {
      method: "PUT",
      path: "/repos/owner/repo/pulls/9/merge",
      status: 422,
      body: { message: "Pull Request was merged already" }, // GitHub 实际文案大小写不定
    },
  ]);
  const ok = await adapter.merge(7, { headSha: "aaaa1111", method: "squash" });
  assert.deepEqual(ok, { merged: true, sha: "merge123" });

  await assert.rejects(() => adapter.merge(8, { headSha: "aaaa1111" }), /not mergeable/);
  const already = await adapter.merge(9, { headSha: "aaaa1111" });
  assert.equal(already.merged, true);
  assert.equal(already.alreadyMerged, true);
});

test("适配器：请求携带鉴权与 API 版本头；仓库标识校验", () => {
  assert.throws(
    () => new GitHubPatrolAdapter({ repo: "bad-repo", fetchImpl: fetch }),
    /无效的 GitHub 仓库标识/,
  );
  const { adapter, calls } = makeAdapter([
    { path: "/repos/owner/repo/pulls?state=open&per_page=100", body: [] },
  ]);
  return adapter.listOpenPullRequests().then(() => {
    const headers = calls[0].init.headers;
    assert.equal(headers.Authorization, "Bearer t0k3n");
    assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
  });
});
