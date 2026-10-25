import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { parseRequestArgs, RequestTool } from "@hajicli/plugins";

test("request 参数校验：拒绝通配符、根目录与非法权限档", () => {
  const base = { action: "workspace.add", reason: "需要读写另一个仓库" };

  for (const target of ["/", "\\", "~", "D:\\", "D:/", "."]) {
    const parsed = parseRequestArgs({ ...base, target });
    assert.equal(parsed.ok, false, `应拒绝 ${target}`);
  }
  assert.equal(parseRequestArgs({ ...base, target: "D:\\**" }).ok, false);
  assert.equal(parseRequestArgs({ ...base, target: "  " }).ok, false);
  assert.equal(parseRequestArgs({ ...base, target: "D:\\work\\repo" }).ok, true);

  assert.equal(
    parseRequestArgs({ action: "workspace.add", target: "D:\\x" }).ok,
    false,
    "缺 reason",
  );
  assert.equal(
    parseRequestArgs({ action: "workspace.add", target: "D:\\x", reason: "长".repeat(201) }).ok,
    false,
  );

  assert.equal(parseRequestArgs({ action: "nope", target: "x", reason: "y" }).ok, false);

  for (const mode of ["plan", "bypass-permissions", "default"]) {
    assert.equal(
      parseRequestArgs({ action: "permission.mode", target: mode, reason: "改不动" }).ok,
      false,
      `不应允许申请 ${mode}`,
    );
  }
  for (const mode of ["accept-edit", "auto"]) {
    const parsed = parseRequestArgs({ action: "permission.mode", target: mode, reason: "批量改" });
    assert.equal(parsed.ok, true);
    if (parsed.ok)
      assert.deepEqual(parsed.spec, { action: "permission.mode", target: mode, reason: "批量改" });
  }
});

test("request 把申请交给回调，并把生效说明原样回传", async () => {
  const seen = [];
  const tool = new RequestTool({
    approve: async (spec) => {
      seen.push(spec);
      return { approved: true, detail: `已加入工作区根：${spec.target}` };
    },
  });
  const output = await tool.execute({
    action: "workspace.add",
    target: "D:\\work\\shared",
    reason: "另一个仓库的配置要一起改",
  });
  assert.deepEqual(seen, [
    { action: "workspace.add", target: "D:\\work\\shared", reason: "另一个仓库的配置要一起改" },
  ]);
  assert.equal(output, "已加入工作区根：D:\\work\\shared");
});

test("request 被拒绝后同一目标不再弹卡，换目标仍可重新申请", async () => {
  let calls = 0;
  const tool = new RequestTool({
    approve: async (spec) => {
      calls += 1;
      return { approved: false, detail: `不允许 ${spec.target}` };
    },
  });
  const first = await tool.execute({ action: "workspace.add", target: "D:\\a", reason: "r1" });
  assert.ok(first.startsWith("已拒绝:"));
  assert.ok(first.includes("不允许 D:\\a"));
  assert.equal(calls, 1);

  const again = await tool.execute({ action: "workspace.add", target: "D:\\a", reason: "r2" });
  assert.ok(again.startsWith("已拒绝:"));
  assert.ok(again.includes("不再重复弹卡"));
  assert.equal(calls, 1, "同一目标不应再次询问");

  await tool.execute({ action: "workspace.add", target: "D:\\b", reason: "r3" });
  assert.equal(calls, 2, "不同目标应重新询问");
});

test("request 批准后不记拒绝，下一次仍会重新询问", async () => {
  let calls = 0;
  const tool = new RequestTool({
    approve: async () => {
      calls += 1;
      return { approved: true };
    },
  });
  await tool.execute({ action: "permission.mode", target: "accept-edit", reason: "批量重构" });
  await tool.execute({ action: "permission.mode", target: "accept-edit", reason: "继续重构" });
  assert.equal(calls, 2);
});

test("request 声明不参与工作区快照，非法参数不会触发询问", async () => {
  let calls = 0;
  const tool = new RequestTool({
    approve: async () => {
      calls += 1;
      return { approved: true };
    },
  });
  assert.equal(tool.getMutationScope(), "none");
  const output = await tool.execute({
    action: "permission.mode",
    target: "bypass-permissions",
    reason: "x",
  });
  assert.ok(output.startsWith("错误:"));
  assert.equal(calls, 0);
});

test("CLI 接线：申请走单次卡片、权限档不落盘、变更复用现有命令路径", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(source.includes("new RequestTool("));
  assert.ok(source.includes("approveAgentRequest"));
  assert.ok(source.includes("confirmAgentRequest"));
  // request 自身不再套一层授权卡，真正的批准在 execute 内部完成
  const hookStart = source.indexOf('hookEngine.register("PreToolUse"');
  const requestBypass = source.indexOf('toLowerCase() === "request"', hookStart);
  const persistentCheck = source.indexOf("isToolAllowedPersistently", hookStart);
  assert.ok(
    requestBypass > hookStart && requestBypass < persistentCheck,
    "request 应直接进入 execute",
  );
  // 权限档提级只作用于本会话
  assert.ok(source.includes("applyPermissionMode(nextMode, { persist: false })"));
  // 工作区根复用 /workspace add 的写入与刷新逻辑
  assert.ok(source.includes("workspaceCommandContext.addRoot(spec.target)"));
  // 申请卡只提供单次批准，不提供永久授权
  assert.ok(source.includes('{ value: "approve", label: "批准", hotkey: "y" }'));
  assert.ok(!/REQUEST_TITLES[\s\S]{0,4000}永久允许/.test(source));
});
