import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatProtectedReason,
  inspectProtectedTarget,
  isHardProtectedTarget,
  PermissionEngine,
} from "@hajicli/core";
import { buildPermissionCardItems } from "../dist/cli-runtime.js";

const MODES = ["plan", "default", "accept-edit", "auto", "bypass-permissions"];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-protected-"));
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  return { root, home, proj };
}

function withIsolatedHome(run) {
  const dirs = makeProject();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCwd = process.cwd();
  process.env.HOME = dirs.home;
  process.env.USERPROFILE = dirs.home;
  process.chdir(dirs.proj);
  const restore = () => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  };
  let result;
  try {
    result = run(dirs);
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

test("受保护目标：hard 级路径与命令可被识别", () => {
  withIsolatedHome(({ proj }) => {
    const hardPaths = [
      path.join(proj, ".haji", "permissions.json"),
      path.join(proj, ".haji", "config.json"),
      path.join(proj, ".haji", "workspaces.json"),
      path.join(proj, ".haji", "preferences.json"),
      path.join(proj, ".haji", "skills", "demo", "SKILL.md"),
      path.join(proj, ".haji", "memory", "note.md"),
      path.join(proj, ".haji", "instincts", "rule.md"),
      path.join(proj, ".haji", "snapshots", "abc"),
      path.join(proj, ".haji", "transcripts", "t.jsonl"),
      path.join(proj, ".haji", "traces", "session", "events.jsonl"),
      path.join(proj, ".haji", "sessions", "s1.json"),
    ];
    for (const target of hardPaths) {
      const hit = inspectProtectedTarget("write", { path: target }, proj);
      assert.equal(hit?.level, "hard", `${target} 应为 hard`);
      assert.equal(isHardProtectedTarget("write", { path: target }, proj), true);
    }

    // 读取配置文件（含明文 Key）同样受保护，但普通源码不受影响
    assert.equal(
      inspectProtectedTarget("read", { path: path.join(proj, ".haji", "config.json") }, proj)
        ?.level,
      "hard",
    );
    assert.equal(
      inspectProtectedTarget("read", { path: path.join(proj, "src", "index.ts") }, proj),
      undefined,
    );
    assert.equal(
      inspectProtectedTarget("write", { path: path.join(proj, "src", "index.ts") }, proj),
      undefined,
    );
  });
});

test("受保护目标：凭据文件为 sensitive 级", () => {
  withIsolatedHome(({ proj }) => {
    const sensitive = [
      ".env",
      ".env.local",
      "certs/server.pem",
      "certs/server.key",
      "id_rsa",
      "deploy/.npmrc",
    ];
    for (const relative of sensitive) {
      const hit = inspectProtectedTarget("read", { path: path.join(proj, relative) }, proj);
      assert.equal(hit?.level, "sensitive", `${relative} 应为 sensitive`);
      assert.equal(isHardProtectedTarget("read", { path: path.join(proj, relative) }, proj), false);
    }
    assert.equal(
      inspectProtectedTarget("write", { path: path.join(proj, "AGENTS.md") }, proj)?.level,
      "sensitive",
    );
  });
});

test("受保护目标：高影响命令识别，普通命令不误伤", () => {
  withIsolatedHome(({ proj }) => {
    // 删除工作区或更外层：直接拒绝，连“本次允许”都不提供
    const forbidden = ["rm -rf .", "rm -rf ..", "rm -rf src/..", "Remove-Item -Recurse -Force ."];
    for (const command of forbidden) {
      assert.equal(inspectProtectedTarget("bash", { command }, proj)?.level, "forbidden", command);
    }

    const hard = [
      "git reset --hard HEAD~1",
      "git clean -fdx",
      "git push origin main --force",
      "git push origin main -f",
      "npm publish --access public",
    ];
    for (const command of hard) {
      assert.equal(inspectProtectedTarget("bash", { command }, proj)?.level, "hard", command);
      assert.equal(isHardProtectedTarget("bash", { command }, proj), true);
    }

    const safe = [
      "git reset HEAD~1",
      "git clean -n",
      "git push origin main",
      "rm -rf node_modules",
      "rm -rf ./dist",
      "ls -la",
    ];
    for (const command of safe) {
      assert.equal(inspectProtectedTarget("bash", { command }, proj), undefined, command);
    }
  });
});

test("权限矩阵：受保护目标在所有档位都必须询问（含 bypass）", async () => {
  await withIsolatedHome(async ({ proj }) => {
    const engine = new PermissionEngine();
    engine.configurePathScope({ cwd: proj, roots: [] });

    const cases = [
      {
        toolName: "write",
        args: { path: path.join(proj, ".haji", "permissions.json") },
        level: "hard",
      },
      { toolName: "write", args: { path: path.join(proj, ".haji", "config.json") }, level: "hard" },
      {
        toolName: "write",
        args: { path: path.join(proj, ".haji", "skills", "x", "SKILL.md") },
        level: "hard",
      },
      { toolName: "read", args: { path: path.join(proj, ".env") }, level: "sensitive" },
      { toolName: "bash", args: { command: "git reset --hard" }, level: "hard" },
      { toolName: "bash", args: { command: "npm publish" }, level: "hard" },
    ];

    for (const mode of MODES) {
      for (const item of cases) {
        const result = await engine.evaluate({ mode, toolName: item.toolName, args: item.args });
        assert.equal(
          result.action,
          "prompt",
          `${mode} · ${item.toolName} · ${JSON.stringify(item.args)}`,
        );
        assert.equal(result.protectedLevel, item.level);
      }
    }

    // 未被保护的目标仍按原有档位语义处理
    const bypassWrite = await engine.evaluate({
      mode: "bypass-permissions",
      toolName: "write",
      args: { path: path.join(proj, "src", "a.ts") },
    });
    assert.equal(bypassWrite.action, "allow");

    const planWrite = await engine.evaluate({
      mode: "plan",
      toolName: "write",
      args: { path: path.join(proj, "src", "a.ts") },
    });
    assert.equal(planWrite.action, "deny");

    // 灾难性删除在任何档位都是直接拒绝（forbidden 级不提供“本次允许”）
    for (const mode of MODES) {
      const result = await engine.evaluate({
        mode,
        toolName: "bash",
        args: { command: "rm -rf ." },
      });
      assert.equal(result.action, "deny", mode);
      assert.equal(result.protectedLevel, "forbidden");
    }
  });
});

test("用户级 paths.deny 优先于 bypass-permissions", async () => {
  await withIsolatedHome(async ({ proj }) => {
    const engine = new PermissionEngine();
    engine.configurePathScope({
      cwd: proj,
      roots: [],
      rules: { deny: [path.join(proj, "secret", "**")] },
    });
    const result = await engine.evaluate({
      mode: "bypass-permissions",
      toolName: "write",
      args: { path: path.join(proj, "secret", "a.txt"), content: "x" },
    });
    assert.equal(result.action, "deny");
    assert.match(result.reason ?? "", /禁止路径规则/);
  });
});

test("HAJI_ALLOW_PROTECTED=1 才关闭整层保护", async () => {
  const previous = process.env.HAJI_ALLOW_PROTECTED;
  process.env.HAJI_ALLOW_PROTECTED = "1";
  try {
    await withIsolatedHome(async ({ proj }) => {
      const engine = new PermissionEngine();
      engine.configurePathScope({ cwd: proj, roots: [] });
      const result = await engine.evaluate({
        mode: "bypass-permissions",
        toolName: "write",
        args: { path: path.join(proj, ".haji", "permissions.json") },
      });
      assert.equal(result.action, "allow");
    });
  } finally {
    if (previous === undefined) delete process.env.HAJI_ALLOW_PROTECTED;
    else process.env.HAJI_ALLOW_PROTECTED = previous;
  }
});

test("受保护目标的授权卡不提供本会话/永久选项", () => {
  const grant = { key: "write", scope: "写入文件" };
  const items = buildPermissionCardItems(grant, { persistent: false }).map((item) => item.value);
  assert.deepEqual(items, ["once", "deny", "deny-reason"]);
  const normal = buildPermissionCardItems(grant).map((item) => item.value);
  assert.ok(normal.includes("always"));
});

test("formatProtectedReason 说明级别与原因", () => {
  const hit = {
    level: "hard",
    kind: "path",
    rule: "x",
    target: "C:\\proj\\.haji\\permissions.json",
    access: "write",
    reason: "这是授权/运行配置",
  };
  const text = formatProtectedReason(hit);
  assert.ok(text.includes("permissions.json"));
  assert.ok(text.includes("bypass"));
});

test("PreToolUse：hard 级检查早于持久放行规则，且卡片按受保护渲染", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const hookStart = source.indexOf('hookEngine.register("PreToolUse"');
  const hardCheck = source.indexOf("isHardProtectedTarget", hookStart);
  const persistentCheck = source.indexOf("isToolAllowedPersistently", hookStart);
  assert.ok(hardCheck > hookStart, "PreToolUse 中存在 hard 级检查");
  assert.ok(persistentCheck > hardCheck, "hard 级检查必须早于持久规则早查");
  assert.ok(source.includes("protectedLevel"));
  assert.ok(source.includes("persistent: !hardProtected"));
});
