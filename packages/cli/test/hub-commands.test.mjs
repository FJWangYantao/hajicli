import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHubMenus,
  buildSessionHelpLines,
  buildSlashCommandCatalog,
  COMMAND_SURFACE,
  findSlashArgHint,
  getTopLevelSlashCommands,
  matchSlashCommands,
  suggestSimilarCommand,
} from "../dist/cli-help.js";
import { terminalWidth } from "../dist/terminal-text.js";
import { setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

test("top-level completion list narrows to hubs and high-frequency actions", () => {
  const commands = getTopLevelSlashCommands().map((entry) => entry.command);
  assert.deepEqual(commands, [
    "/help",
    "/model",
    "/config",
    "/agents",
    "/skills",
    "/memory",
    "/diag",
    "/compact",
    "/image",
    "/clear",
    "/resume",
    "/undo",
    "/rewind",
    "/exit",
  ]);
  // 被收纳的子指令不在一层列表里（继续输入后可模糊搜索到，也可直连调用）。
  const nested = [
    "/effort",
    "/permission",
    "/provider",
    "/theme",
    "/agents new",
    "/agents presets",
    "/memory rules",
    "/perf",
    "/cost",
    "/diff",
    "/doctor",
    "/viewer",
    "/mcp",
  ];
  for (const command of nested) {
    assert.ok(!commands.includes(command), `${command} should be hidden from completion`);
  }
});

test("each hub maps its members to menu items without re-entering itself", () => {
  const menus = buildHubMenus();
  assert.deepEqual(Object.keys(menus).sort(), ["agents", "config", "diag", "memory"]);
  // /model 已提升到顶层；/effort 与 /model 的强度轴重复，只保留直连与补全，不进菜单。
  assert.deepEqual(
    menus.config.items.map((item) => item.value),
    ["/permission", "/provider", "/theme", "/sidebar"],
  );
  assert.deepEqual(
    menus.agents.items.map((item) => item.value),
    ["/agents new", "/agents presets"],
  );
  assert.deepEqual(
    menus.diag.items.map((item) => item.value),
    ["/perf", "/cost", "/diff", "/doctor", "/viewer", "/mcp"],
  );
  assert.deepEqual(
    menus.memory.items.map((item) => item.value),
    ["/memory list", "/memory rules"],
  );
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

test("skill hub 已取消：Skill 经补全目录直连，管理入口是 /skills", () => {
  const skills = [
    { name: "review", description: "代码审查", userInvocable: true },
    { name: "internal", description: "模型内部使用", userInvocable: false },
  ];
  const menus = buildHubMenus(skills);
  assert.equal(menus.skill, undefined);
  const catalog = buildSlashCommandCatalog(skills);
  const commands = catalog.map((entry) => entry.command);
  assert.ok(commands.includes("/skill review"));
  assert.ok(!commands.includes("/skill internal"));
  assert.ok(commands.includes("/skills"));
  assert.ok(commands.includes("/skills reload"));
  assert.ok(commands.includes("/skills validate"));
});

test("command surface keeps hubs and nested members in one source", () => {
  const hubs = COMMAND_SURFACE.filter((entry) => entry.members);
  assert.equal(hubs.length, 4);
  for (const hub of hubs) {
    for (const member of hub.members ?? []) {
      assert.ok(member.command.startsWith("/"));
      assert.ok(member.description.length > 0);
    }
  }
});

test("session help lists commands, shortcuts and tool names without tool essays", () => {
  const options = {
    permissionMode: "default",
    reasoningEffort: "medium",
    model: "deepseek-v4-flash",
    toolNames: ["bash", "read", "taskcreate"],
  };
  for (const width of [50, 100]) {
    const lines = buildSessionHelpLines({ ...options, width });
    const text = lines.join("\n");
    for (const line of lines) assert.ok(terminalWidth(line) <= width, `${width}: ${line}`);
    assert.doesNotMatch(text, /⚙/);
    assert.match(text, /^快捷键$/m);
    assert.match(text, /Esc +中止当前回合/);
    assert.match(text, /^ {2}bash {2}read {2}taskcreate$/m);
    if (width >= 100) {
      assert.match(text, /权限 default · 强度 medium · 模型 deepseek-v4-flash/);
    }
    for (const entry of COMMAND_SURFACE) assert.ok(text.includes(entry.command), entry.command);
  }

  // 说明列折行时续行与第一行说明对齐，而不是顶格。
  const narrow = buildSessionHelpLines({ ...options, width: 50 });
  const start = narrow.findIndex((line) => line.includes("PgUp / PgDn"));
  const column = narrow[start].indexOf("翻阅");
  assert.ok(narrow[start + 1].startsWith(" ".repeat(column)), narrow[start + 1]);
});

test("slash completion lists top-level on / and fuzzy-searches every command after", () => {
  const catalog = buildSlashCommandCatalog([
    { name: "review", description: "代码审查", userInvocable: true },
    { name: "internal", description: "模型内部使用", userInvocable: false },
  ]);
  const match = (input) => matchSlashCommands(input, catalog).map((entry) => entry.command);

  assert.deepEqual(
    match("/"),
    getTopLevelSlashCommands().map((entry) => entry.command),
  );
  // 被收纳的指令可以直接搜到：/mo → /model，/perm → /permission。
  assert.equal(match("/mo")[0], "/model");
  assert.equal(match("/perm")[0], "/permission");
  // 子序列模糊匹配。
  assert.ok(match("/mdl").includes("/model"));
  // 子命令与 Skill 可按第二个词搜到；model-only Skill 不出现。
  assert.ok(match("/reload").includes("/skills reload"));
  assert.ok(match("/rev").includes("/skill review"));
  assert.ok(!match("/int").includes("/skill internal"));
  // 敲空格后只补全该指令的子命令。
  assert.deepEqual(match("/provider "), ["/provider add", "/provider set", "/provider unset"]);
  assert.deepEqual(match("/memory c"), ["/memory confirm"]);
  // 完整输入的指令排在首位；已带参数时不再给出会覆盖参数的补全。
  assert.equal(match("/memory")[0], "/memory");
  assert.deepEqual(match("/memory confirm abc"), []);
  assert.equal(findSlashArgHint("/memory confirm abc", catalog)?.argHint, "<id>");
  assert.equal(findSlashArgHint("hello", catalog), undefined);
  // 未标注顶层的简单列表在只输入 “/” 时整体展示。
  assert.equal(matchSlashCommands("/", [{ command: "/a", description: "a" }]).length, 1);
});

test("unknown commands suggest the closest known command", () => {
  const catalog = buildSlashCommandCatalog();
  assert.equal(suggestSimilarCommand("mdoel", catalog), "/model");
  assert.equal(suggestSimilarCommand("comapct", catalog), "/compact");
  assert.equal(suggestSimilarCommand("provder", catalog), "/provider");
  // /instinct 已收敛为 /memory rules 的别名，不再作为纠错建议出现。
  assert.equal(suggestSimilarCommand("instin", catalog), undefined);
  assert.equal(suggestSimilarCommand("zzzzzz", catalog), undefined);
});
