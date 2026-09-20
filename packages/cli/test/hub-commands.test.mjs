import assert from "node:assert/strict";
import test from "node:test";

import { buildHubMenus, COMMAND_SURFACE, getTopLevelSlashCommands } from "../dist/cli-help.js";

test("top-level completion list narrows to hubs and high-frequency actions", () => {
  const commands = getTopLevelSlashCommands().map((entry) => entry.command);
  assert.deepEqual(commands, [
    "/help",
    "/config",
    "/agent",
    "/skill",
    "/memory",
    "/diag",
    "/compact",
    "/clear",
    "/resume",
    "/rewind",
    "/exit",
  ]);
  // 被收纳的子指令不再出现在补全列表里（仍可直连调用）。
  const nested = [
    "/model",
    "/effort",
    "/permission",
    "/provider",
    "/subagent",
    "/preset",
    "/agents",
    "/skills",
    "/instinct",
    "/perf",
    "/viewer",
    "/mcp",
  ];
  for (const command of nested) {
    assert.ok(!commands.includes(command), `${command} should be hidden from completion`);
  }
});

test("each hub maps its members to menu items without re-entering itself", () => {
  const menus = buildHubMenus();
  assert.deepEqual(Object.keys(menus).sort(), ["agent", "config", "diag", "memory", "skill"]);
  assert.deepEqual(
    menus.config.items.map((item) => item.value),
    ["/model", "/effort", "/permission", "/provider"],
  );
  assert.deepEqual(
    menus.agent.items.map((item) => item.value),
    ["/subagent", "/preset", "/agents"],
  );
  assert.deepEqual(
    menus.diag.items.map((item) => item.value),
    ["/perf", "/viewer", "/mcp"],
  );
  assert.ok(menus.memory.items.some((item) => item.value === "/memory list"));
  for (const [name, menu] of Object.entries(menus)) {
    assert.ok(menu.title.length > 0, `${name} menu should have a title`);
    assert.ok(menu.items.length > 0, `${name} menu should not be empty`);
    for (const item of menu.items) {
      assert.match(item.value, /^\/\S/);
      assert.ok(item.description.length > 0);
      // 选中项不能是不带参数的枢纽自身，否则会再次进入同一菜单形成死循环。
      assert.notEqual(item.value, `/${name}`);
    }
  }
});

test("skill hub injects loadable skills and filters model-only entries", () => {
  const menus = buildHubMenus([
    { name: "review", description: "代码审查", userInvocable: true },
    { name: "internal", description: "模型内部使用", userInvocable: false },
  ]);
  const values = menus.skill.items.map((item) => item.value);
  assert.ok(values.includes("/skill review"));
  assert.ok(!values.includes("/skill internal"));
  assert.ok(values.includes("/skills"));
  assert.ok(values.includes("/skills reload"));
  assert.ok(values.includes("/skills validate"));
  // 动态技能项排在管理子命令之前，便于直接选择。
  assert.equal(values[0], "/skill review");
});

test("command surface keeps hubs and nested members in one source", () => {
  const hubs = COMMAND_SURFACE.filter((entry) => entry.members);
  assert.equal(hubs.length, 5);
  for (const hub of hubs) {
    for (const member of hub.members ?? []) {
      assert.ok(member.command.startsWith("/"));
      assert.ok(member.description.length > 0);
    }
  }
});
