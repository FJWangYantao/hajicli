import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommandAliasIndex,
  buildSessionHelpLines,
  buildSlashCommandCatalog,
  COMMAND_SURFACE,
  findAliasSkillConflicts,
  getCommandAliases,
  getTopLevelSlashCommands,
  resolveCanonicalCommand,
  suggestSimilarCommand,
} from "../dist/cli-help.js";
import { setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

test("别名解析到规范指令，大小写与前导斜杠均容错", () => {
  assert.equal(resolveCanonicalCommand("new"), "clear");
  assert.equal(resolveCanonicalCommand("NEW"), "clear");
  assert.equal(resolveCanonicalCommand("/new"), "clear");
  assert.equal(resolveCanonicalCommand("history"), "resume");
  assert.equal(resolveCanonicalCommand("sessions"), "resume");
  assert.equal(resolveCanonicalCommand("quit"), "exit");
  assert.equal(resolveCanonicalCommand("q"), "exit");
  assert.equal(resolveCanonicalCommand("presets"), "preset");
  assert.equal(resolveCanonicalCommand("providers"), "provider");
  assert.equal(resolveCanonicalCommand("perm"), "permission");
});

test("规范指令与非指令输入原样返回", () => {
  for (const name of ["clear", "exit", "skill", "model", "help"]) {
    assert.equal(resolveCanonicalCommand(name), name);
  }
  assert.equal(resolveCanonicalCommand("zzzzzz"), "zzzzzz");
  assert.equal(resolveCanonicalCommand(""), "");
});

test("别名表全部指向真实指令，且键值不相等", () => {
  const aliases = getCommandAliases();
  const canonicalNames = new Set(
    COMMAND_SURFACE.flatMap((entry) => [
      entry.command.slice(1),
      ...(entry.members ?? []).map((member) => member.command.slice(1)),
    ]),
  );
  assert.ok(aliases.size > 0);
  for (const [alias, canonical] of aliases) {
    assert.notEqual(alias, canonical, `别名 ${alias} 不应与规范名相同`);
    assert.equal(alias, alias.toLowerCase());
    assert.ok(!alias.includes("/") && !alias.includes(" "));
    assert.ok(canonicalNames.has(canonical), `别名 ${alias} → ${canonical} 不是已知指令`);
  }
});

test("别名不出现在补全目录、顶层列表与 /help", () => {
  const catalogCommands = buildSlashCommandCatalog().map((entry) => entry.command);
  const topLevelCommands = getTopLevelSlashCommands().map((entry) => entry.command);
  const helpText = buildSessionHelpLines({
    width: 120,
    permissionMode: "default",
    reasoningEffort: "medium",
    model: "test-model",
    toolNames: [],
  }).join("\n");

  for (const alias of getCommandAliases().keys()) {
    for (const surface of [catalogCommands, topLevelCommands]) {
      assert.ok(!surface.includes(`/${alias}`), `/${alias} 不应出现在补全里`);
    }
    assert.ok(!helpText.includes(`/${alias} `), `/${alias} 不应出现在 /help 里`);
  }

  // 规范指令仍可见且只出现一次。
  assert.equal(catalogCommands.filter((command) => command === "/clear").length, 1);
  assert.equal(topLevelCommands.filter((command) => command === "/clear").length, 1);
  assert.ok(helpText.includes("/clear"));
});

test("未知指令纠错只给规范名，不暴露别名", () => {
  const catalog = buildSlashCommandCatalog();
  const aliases = new Set([...getCommandAliases().keys()].map((alias) => `/${alias}`));
  for (const typo of ["neww", "clera", "exi", "presett", "permz"]) {
    const suggestion = suggestSimilarCommand(typo, catalog);
    assert.ok(!suggestion || !aliases.has(suggestion), `纠错不应建议别名：${suggestion}`);
  }
});

test("建表时拒绝与现有指令重名、重复登记和多词指令", () => {
  assert.throws(
    () =>
      buildCommandAliasIndex([
        { command: "/model", description: "m" },
        { command: "/clear", description: "a", aliases: ["model"] },
      ]),
    /冲突/,
  );
  assert.throws(
    () =>
      buildCommandAliasIndex([
        { command: "/clear", description: "a", aliases: ["fresh"] },
        { command: "/resume", description: "b", aliases: ["fresh"] },
      ]),
    /重复登记/,
  );
  assert.throws(
    () =>
      buildCommandAliasIndex([
        {
          command: "/memory",
          description: "a",
          subcommands: [{ command: "/memory list", description: "l", aliases: ["ls"] }],
        },
      ]),
    /多词指令/,
  );
  assert.deepEqual(
    buildCommandAliasIndex([{ command: "/clear", description: "a", aliases: ["New"] }]),
    new Map([["new", "clear"]]),
  );
});

test("别名与 Skill 同名时给出可见告警", () => {
  assert.equal(findAliasSkillConflicts(["other-skill"]).length, 0);
  const conflicts = findAliasSkillConflicts(["new", "unrelated"]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /\/new/);
  assert.match(conflicts[0], /\/clear/);
});
