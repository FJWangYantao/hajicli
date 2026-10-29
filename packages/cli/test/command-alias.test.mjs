import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommandAliasIndex,
  buildSessionHelpLines,
  buildSlashCommandCatalog,
  COMMAND_SURFACE,
  classifyCommandTiming,
  expandCommandInput,
  findAliasSkillConflicts,
  findSlashArgHint,
  getCommandAliases,
  getTopLevelSlashCommands,
  matchSlashCommands,
  resolveCanonicalCommand,
  suggestSimilarCommand,
} from "../dist/cli-help.js";
import { setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

/** 展平指令面的全部规范指令（含成员与子命令），别名目标必须能在这里找到。 */
function collectCanonicalNames(surface = COMMAND_SURFACE) {
  const names = new Set();
  const collect = (entry) => {
    names.add(entry.command.slice(1).toLowerCase());
    for (const member of entry.members ?? []) collect(member);
    for (const sub of entry.subcommands ?? []) collect(sub);
  };
  for (const entry of surface) collect(entry);
  return names;
}

test("别名解析到规范指令，大小写与前导斜杠均容错", () => {
  assert.equal(resolveCanonicalCommand("new"), "clear");
  assert.equal(resolveCanonicalCommand("NEW"), "clear");
  assert.equal(resolveCanonicalCommand("/new"), "clear");
  assert.equal(resolveCanonicalCommand("history"), "resume");
  assert.equal(resolveCanonicalCommand("sessions"), "resume");
  assert.equal(resolveCanonicalCommand("quit"), "exit");
  assert.equal(resolveCanonicalCommand("q"), "exit");
  assert.equal(resolveCanonicalCommand("presets"), "agents presets");
  assert.equal(resolveCanonicalCommand("providers"), "provider");
  assert.equal(resolveCanonicalCommand("perm"), "permission");
  // 指令收敛后的多词别名目标。
  assert.equal(resolveCanonicalCommand("permissions"), "permission rules");
  assert.equal(resolveCanonicalCommand("instinct"), "memory rules");
  assert.equal(resolveCanonicalCommand("subagent"), "agents new");
  assert.equal(resolveCanonicalCommand("preset"), "agents presets");
  assert.equal(resolveCanonicalCommand("agent"), "agents");
});

test("规范指令与非指令输入原样返回", () => {
  for (const name of ["clear", "exit", "skill", "model", "help", "agents", "skills"]) {
    assert.equal(resolveCanonicalCommand(name), name);
  }
  assert.equal(resolveCanonicalCommand("zzzzzz"), "zzzzzz");
  assert.equal(resolveCanonicalCommand(""), "");
});

test("expandCommandInput 重写整条输入并保留剩余参数", () => {
  assert.equal(expandCommandInput("/instinct distill"), "/memory rules distill");
  assert.equal(
    expandCommandInput("/subagent --role research 修复测试"),
    "/agents new --role research 修复测试",
  );
  assert.equal(expandCommandInput("/permissions"), "/permission rules");
  assert.equal(
    expandCommandInput("/preset add fast --effort high"),
    "/agents presets add fast --effort high",
  );
  assert.equal(expandCommandInput("/new"), "/clear");
  assert.equal(expandCommandInput("/clear"), "/clear");
  assert.equal(expandCommandInput("普通消息"), "普通消息");
});

test("别名表全部指向真实指令，且键值头词不相等", () => {
  const aliases = getCommandAliases();
  const canonicalNames = collectCanonicalNames();
  assert.ok(aliases.size > 0);
  for (const [alias, canonical] of aliases) {
    assert.notEqual(alias, canonical, `别名 ${alias} 不应与规范名相同`);
    assert.equal(alias, alias.toLowerCase());
    assert.ok(!alias.includes("/") && !alias.includes(" "));
    assert.ok(canonicalNames.has(canonical), `别名 ${alias} → ${canonical} 不是已知指令`);
    assert.notEqual(alias, canonical.split(" ")[0], `别名 ${alias} 不应与规范指令头词相同`);
  }
});

test("别名搜索命中规范指令，不生成重复条目或覆盖参数", () => {
  const catalog = buildSlashCommandCatalog();
  for (const input of ["/ne", "/new", "/NEW"]) {
    const result = matchSlashCommands(input, catalog);
    assert.equal(result[0].command, "/clear");
    assert.match(result[0].description, /别名 \/new/);
    assert.equal(result.filter((entry) => entry.command === "/clear").length, 1);
  }
  for (const [alias, canonical] of getCommandAliases()) {
    assert.equal(matchSlashCommands(`/${alias}`, catalog)[0]?.command, `/${canonical}`);
  }
  assert.deepEqual(matchSlashCommands("/new some text", catalog), []);
  assert.equal(
    matchSlashCommands("/", catalog).filter((entry) => entry.command === "/clear").length,
    1,
  );
});

test("所有别名的子命令补全、参数提示和执行时机与规范指令一致", () => {
  const catalog = buildSlashCommandCatalog();
  for (const [alias, canonical] of getCommandAliases()) {
    for (const suffix of [" ", " r", " add", " search", " --role research"]) {
      const input = `/${alias}${suffix}`;
      const expanded = `/${canonical}${suffix}`;
      assert.deepEqual(
        matchSlashCommands(input, catalog),
        matchSlashCommands(expanded, catalog),
        input,
      );
      assert.deepEqual(
        findSlashArgHint(input, catalog),
        findSlashArgHint(expanded, catalog),
        input,
      );
      assert.equal(classifyCommandTiming(input), classifyCommandTiming(expanded), input);
    }
  }
  assert.ok(
    matchSlashCommands("/perm r", catalog).some((entry) => entry.command === "/permission rules"),
  );
  assert.equal(findSlashArgHint("/history search", catalog)?.command, "/resume");
  assert.ok(
    matchSlashCommands("/instinct ", catalog).some(
      (entry) => entry.command === "/memory rules distill",
    ),
  );
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
  for (const typo of ["neww", "clera", "exi", "presett", "permz", "subagentt", "instict"]) {
    const suggestion = suggestSimilarCommand(typo, catalog);
    assert.ok(!suggestion || !aliases.has(suggestion), `纠错不应建议别名：${suggestion}`);
  }
});

test("建表时拒绝与现有指令重名、重复登记和带空格的别名", () => {
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
  // 多词目标合法（指令收敛的平滑迁移路径）；别名本身仍必须是单词。
  assert.throws(
    () =>
      buildCommandAliasIndex([
        {
          command: "/memory",
          description: "a",
          subcommands: [{ command: "/memory list", description: "l", aliases: ["list all"] }],
        },
      ]),
    /不含空白的单个单词/,
  );
  assert.deepEqual(
    buildCommandAliasIndex([{ command: "/clear", description: "a", aliases: ["New"] }]),
    new Map([["new", "clear"]]),
  );
  assert.deepEqual(
    buildCommandAliasIndex([
      {
        command: "/permission",
        description: "a",
        subcommands: [{ command: "/permission rules", description: "r", aliases: ["permissions"] }],
      },
    ]),
    new Map([["permissions", "permission rules"]]),
  );
});

test("别名与 Skill 同名时给出可见告警", () => {
  assert.equal(findAliasSkillConflicts(["other-skill"]).length, 0);
  const conflicts = findAliasSkillConflicts(["new", "unrelated"]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /\/new/);
  assert.match(conflicts[0], /\/clear/);
});
