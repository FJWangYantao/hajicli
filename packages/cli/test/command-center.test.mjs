import assert from "node:assert/strict";
import test from "node:test";

import { buildHubMenus, getTopLevelSlashCommands } from "../dist/cli-help.js";
import { listThemePresets, setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

test("指令中心：一级列表覆盖全部枢纽，且每个枢纽都有可选项", () => {
  const topLevel = getTopLevelSlashCommands();
  const commands = topLevel.map((entry) => entry.command);
  const menus = buildHubMenus();
  const hubNames = Object.keys(menus).sort();

  assert.deepEqual(hubNames, ["agents", "config", "diag", "memory"]);
  for (const hub of hubNames) {
    assert.ok(commands.includes(`/${hub}`), `枢纽 /${hub} 必须出现在一级列表`);
    assert.ok(menus[hub].items.length > 0, `枢纽 /${hub} 的二级菜单不能为空`);
  }
  // 一级条目必须唯一，否则选择器会出现重复项。
  assert.equal(new Set(commands).size, commands.length);
});

test("指令中心：一级条目可直接作为待分发指令使用", () => {
  for (const entry of getTopLevelSlashCommands()) {
    assert.ok(entry.command.startsWith("/"), `${entry.command} 必须带斜杠`);
    assert.ok(entry.description.length > 0, `${entry.command} 缺少说明`);
  }
});

test("主题选择器：预设名称唯一、说明非空，可直接作为选项", () => {
  const presets = listThemePresets();
  assert.ok(presets.length > 0);
  const names = presets.map((preset) => preset.name);
  assert.equal(new Set(names).size, names.length);
  for (const preset of presets) {
    assert.ok(preset.name.length > 0);
    assert.ok(preset.description.length > 0);
  }
});
