import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPermissionCardItems } from "../dist/cli-runtime.js";
import {
  isToolAllowedPersistently,
  loadAllPermissionRules,
  loadPermissionRulesScope,
  permissionRulesPath,
  projectPermissionRulesPath,
  removePermissionRule,
  savePermissionRule,
  userPermissionRulesPath,
} from "../dist/permission-rules.js";

/**
 * permission-rules 的路径基于 os.homedir() 与 process.cwd()。
 * 测试前切换到临时目录并覆盖 HOME/USERPROFILE，结束后恢复。
 */
function withIsolatedPaths(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-permrules-"));
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });

  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  process.chdir(proj);
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    run({ root, home, proj });
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("permission rules start empty in both scopes", () => {
  withIsolatedPaths(() => {
    assert.deepEqual(loadAllPermissionRules(), { user: [], project: [] });
  });
});

test("path helpers split user and project scopes", () => {
  withIsolatedPaths(({ home, proj }) => {
    assert.equal(userPermissionRulesPath(), path.join(home, ".haji", "permissions.json"));
    assert.equal(projectPermissionRulesPath(), path.join(proj, ".haji", "permissions.json"));
    assert.equal(permissionRulesPath("user"), userPermissionRulesPath());
    assert.equal(permissionRulesPath("project"), projectPermissionRulesPath());
  });
});

test("save writes to the requested scope and dedupes by key", () => {
  withIsolatedPaths(({ home, proj }) => {
    const entry = {
      key: "bash:npm test",
      scope: "npm test 开头的命令",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(savePermissionRule(entry, "user"), true);
    assert.equal(savePermissionRule(entry, "project"), true);

    // 同 key 再写一次：去重且保留原 createdAt，仅刷新 scope 描述
    assert.equal(
      savePermissionRule(
        {
          key: "bash:npm test",
          scope: "npm test 开头的命令（新）",
          createdAt: "2026-02-01T00:00:00.000Z",
        },
        "user",
      ),
      true,
    );
    const userRules = loadPermissionRulesScope("user");
    assert.equal(userRules.length, 1);
    assert.equal(userRules[0].createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(userRules[0].scope, "npm test 开头的命令（新）");

    // 两级文件各写各的，互不串
    assert.equal(loadPermissionRulesScope("project").length, 1);
    assert.ok(fs.existsSync(path.join(home, ".haji", "permissions.json")));
    assert.ok(fs.existsSync(path.join(proj, ".haji", "permissions.json")));

    // 写盘内容带 version 字段且只含合法条目
    const raw = JSON.parse(fs.readFileSync(path.join(home, ".haji", "permissions.json"), "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.allow.length, 1);
  });
});

test("isToolAllowedPersistently hits either scope and rejects unsafe compounds", () => {
  withIsolatedPaths(() => {
    savePermissionRule(
      { key: "bash:npm test", scope: "npm test 开头的命令", createdAt: "2026-01-01T00:00:00.000Z" },
      "user",
    );
    savePermissionRule(
      { key: "write", scope: "写入文件", createdAt: "2026-01-01T00:00:00.000Z" },
      "project",
    );

    const rules = loadAllPermissionRules();
    // 用户级命中
    assert.equal(
      isToolAllowedPersistently("bash", { command: "npm test -- --watch" }, rules)?.scope,
      "user",
    );
    // 项目级命中
    assert.equal(isToolAllowedPersistently("write", { path: "a.txt" }, rules)?.scope, "project");
    // 前缀不匹配不命中
    assert.equal(isToolAllowedPersistently("bash", { command: "npm publish" }, rules), undefined);
    // 组合/重定向命令没有可持久化的键，永远不命中
    assert.equal(
      isToolAllowedPersistently("bash", { command: "npm test && rm -rf ." }, rules),
      undefined,
    );
  });
});

test("remove deletes only the matched key in the matched scope", () => {
  withIsolatedPaths(() => {
    savePermissionRule(
      { key: "bash:git push", scope: "git push 开头的命令", createdAt: "2026-01-01T00:00:00.000Z" },
      "user",
    );
    savePermissionRule(
      { key: "bash:git push", scope: "git push 开头的命令", createdAt: "2026-01-01T00:00:00.000Z" },
      "project",
    );

    // 删除项目级不影响用户级
    assert.equal(removePermissionRule("bash:git push", "project"), true);
    const rules = loadAllPermissionRules();
    assert.equal(rules.project.length, 0);
    assert.equal(rules.user.length, 1);

    // 不存在的 key 返回 false 且不写盘
    assert.equal(removePermissionRule("bash:git push", "project"), false);
    assert.equal(removePermissionRule("bash:never-saved", "user"), false);
    assert.equal(loadAllPermissionRules().user.length, 1);
  });
});

test("corrupted or malformed rule files fall back to empty", () => {
  withIsolatedPaths(({ home, proj }) => {
    fs.mkdirSync(path.join(home, ".haji"), { recursive: true });
    fs.writeFileSync(path.join(home, ".haji", "permissions.json"), "{ not json", "utf8");
    fs.mkdirSync(path.join(proj, ".haji"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".haji", "permissions.json"),
      JSON.stringify({ version: 1, allow: [{ key: "", scope: "x" }, { noKey: true }, "junk"] }),
      "utf8",
    );
    assert.deepEqual(loadAllPermissionRules(), { user: [], project: [] });

    // 容错后仍可正常写回
    assert.equal(
      savePermissionRule(
        { key: "edit", scope: "编辑文件", createdAt: "2026-01-01T00:00:00.000Z" },
        "user",
      ),
      true,
    );
    assert.equal(loadPermissionRulesScope("user").length, 1);
  });
});

test("permission card items expose persistent options only with a grant", () => {
  const withGrant = buildPermissionCardItems({
    key: "bash:npm test",
    scope: "npm test 开头的命令",
  });
  // 永久允许只有一项（作用域经 secondary 轴 Tab 切换），另加“拒绝并说明”。
  assert.deepEqual(
    withGrant.map((item) => item.value),
    ["once", "session", "always", "deny", "deny-reason"],
  );
  assert.deepEqual(
    withGrant.map((item) => item.hotkey),
    ["y", "a", "p", "n", "e"],
  );

  // 无授权范围（组合命令等）：只有单次允许/拒绝，不提供任何“总是允许”
  const withoutGrant = buildPermissionCardItems(undefined);
  assert.deepEqual(
    withoutGrant.map((item) => item.value),
    ["once", "deny", "deny-reason"],
  );
});

test("index.ts wires persistent rules into the PreToolUse hook and the card", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // hook 早查在权限引擎评估之前，plan/bypass 两档不查持久规则
  const hookStart = source.indexOf('hookEngine.register("PreToolUse"');
  assert.ok(hookStart >= 0, "PreToolUse hook 存在");
  const earlyCheck = source.indexOf("isToolAllowedPersistently", hookStart);
  const evaluateCall = source.indexOf("permissionEngine.evaluate", hookStart);
  assert.ok(earlyCheck > hookStart && evaluateCall > earlyCheck, "持久规则早于权限引擎评估");
  assert.ok(/mode !== "plan" && mode !== "bypass-permissions"/.test(source));
  // 授权卡片选项来自纯函数；永久允许（作用域走 secondary 轴）写盘后刷新缓存并给出确认提示
  assert.ok(source.includes("buildPermissionCardItems(grant)"));
  assert.ok(source.includes('selection.value === "always"'));
  assert.ok(source.includes('selection.secondaryValue === "user" ? "user" : "project"'));
  assert.ok(source.includes('selection.value === "deny-reason"'));
  assert.ok(source.includes("savePermissionRule"));
  assert.ok(source.includes("permissionRules = loadAllPermissionRules()"));
  // /permission rules 管理入口存在且删除后同步撤销会话授权
  assert.ok(source.includes('parts[1]?.toLowerCase() === "rules"'));
  assert.ok(source.includes("sessionToolGrants.keys.delete(ruleKey)"));
});
