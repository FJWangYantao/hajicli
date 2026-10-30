import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseRepoFromRemote,
  repoFromGitRemote,
  resolvePatrolRepo,
} from "../dist/patrol/config.js";

function tmpDir(prefix = "haji-patrol-cfg-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitInit(cwd, remote) {
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  if (remote) git("remote", "add", "origin", remote);
  return cwd;
}

test("parseRepoFromRemote：常见远端形态归一为 owner/name", () => {
  const cases = [
    ["https://github.com/FJWangYantao/hajicli.git", "FJWangYantao/hajicli"],
    ["https://github.com/FJWangYantao/hajicli", "FJWangYantao/hajicli"],
    ["https://github.com/FJWangYantao/hajicli/", "FJWangYantao/hajicli"],
    ["git@github.com:FJWangYantao/hajicli.git", "FJWangYantao/hajicli"],
    ["ssh://git@github.com/FJWangYantao/hajicli.git", "FJWangYantao/hajicli"],
    ["ssh://git@ghe.internal:2222/team/repo.git", "team/repo"],
  ];
  for (const [url, expected] of cases) {
    assert.equal(parseRepoFromRemote(url), expected, url);
  }
});

test("parseRepoFromRemote：本地路径与非法输入返回 undefined", () => {
  assert.equal(parseRepoFromRemote("/home/ubuntu/repo"), undefined);
  assert.equal(parseRepoFromRemote("../sibling"), undefined);
  assert.equal(parseRepoFromRemote(""), undefined);
  assert.equal(parseRepoFromRemote("https://github.com/onlyowner"), undefined);
});

test("repoFromGitRemote：从 origin 推断仓库", () => {
  const cwd = gitInit(tmpDir(), "https://github.com/FJWangYantao/hajicli.git");
  assert.equal(repoFromGitRemote(cwd), "FJWangYantao/hajicli");
});

test("repoFromGitRemote：无 origin / 非 git 仓库返回 undefined", () => {
  assert.equal(repoFromGitRemote(gitInit(tmpDir(), null)), undefined);
  assert.equal(repoFromGitRemote(tmpDir()), undefined);
});

test("resolvePatrolRepo：config.json 的 repo 优先于远端", () => {
  const cwd = gitInit(tmpDir(), "https://github.com/from/remote.git");
  fs.mkdirSync(path.join(cwd, ".haji", "patrol"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".haji", "patrol", "config.json"),
    JSON.stringify({ repo: "configured/repo" }),
  );
  assert.equal(resolvePatrolRepo(cwd), "configured/repo");
});

test("resolvePatrolRepo：无配置时回退到 origin，两者都没有则 undefined", () => {
  const cwd = gitInit(tmpDir(), "git@github.com:FJWangYantao/hajicli.git");
  assert.equal(resolvePatrolRepo(cwd), "FJWangYantao/hajicli");
  assert.equal(resolvePatrolRepo(gitInit(tmpDir(), null)), undefined);
});
