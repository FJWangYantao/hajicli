import assert from "node:assert/strict";
import test from "node:test";

import { handleSkillsCommand, showMcpStatus } from "../dist/extension-commands.js";

// 去掉 ANSI 颜色再断言。
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function recorder() {
  const out = { lines: [], chat: [] };
  return {
    out,
    ui: {
      writeLine: (line) => out.lines.push(plain(line)),
      writeChat: (text) => out.chat.push(plain(text)),
    },
  };
}

test("/mcp 未配置时给出配置示例", () => {
  const { ui, out } = recorder();
  showMcpStatus(ui, [], {});
  assert.ok(out.lines[0].includes("未配置 MCP server"));
  assert.ok(out.chat[0].includes('"mcpServers"'));
});

test("/mcp 列出状态、只读标记、工具与截断后的错误", () => {
  const { ui, out } = recorder();
  showMcpStatus(
    ui,
    [
      { name: "fs", state: "running", toolCount: 1, tools: ["mcp_fs_read"] },
      {
        name: "broken",
        state: "failed",
        toolCount: 0,
        tools: [],
        error: `坏了\n${"x".repeat(300)}`,
      },
    ],
    { fs: { command: "npx", readOnly: true } },
  );
  const text = out.chat.join("");
  assert.match(text, /MCP servers（2）/);
  assert.match(text, /fs\s+running · 只读 · 1 个工具/);
  assert.match(text, /mcp_fs_read/);
  const errorLine = text.split("\n").find((line) => line.includes("坏了"));
  assert.ok(errorLine.trim().length <= 160, "错误信息压成一行并截断");
});

function fakeRegistry() {
  const calls = [];
  return {
    calls,
    registry: {
      scan: async () => {
        calls.push("scan");
        return { skills: [{}, {}], warnings: ["有个 Skill 缺 description"] };
      },
      validate: async () => ({
        valid: false,
        checkedSkills: 2,
        checkedResources: 3,
        issues: [{ severity: "error", skill: "deploy", message: "引用的脚本不存在" }],
      }),
      getLoaded: () => [{ name: "review", resident: true }],
      list: () => [
        { name: "review", source: "project", description: "代码评审", userInvocable: true },
        { name: "deploy", source: "user", description: "发布", userInvocable: false },
      ],
    },
  };
}

test("/skills 列出状态；reload 先还输入行、扫描并刷新提示词后再列出", async () => {
  const { ui, out } = recorder();
  const { registry, calls } = fakeRegistry();
  const ctx = {
    ui,
    skillRegistry: registry,
    startBackgroundInput: () => calls.push("background"),
    refreshAfterScan: async () => {
      calls.push("refresh");
    },
  };
  await handleSkillsCommand(["reload"], ctx);
  assert.deepEqual(calls, ["background", "scan", "refresh"]);
  assert.ok(out.lines.some((line) => line.includes("已重新扫描 2 个 Skill")));
  assert.ok(out.lines.some((line) => line.includes("缺 description")));
  const listing = out.chat.join("");
  assert.match(listing, /review\s+\[project\] loaded/);
  assert.match(listing, /deploy\s+\[user\] available · model-only/);
});

test("/skills validate 报告结果与逐条问题，不再列出", async () => {
  const { ui, out } = recorder();
  const { registry } = fakeRegistry();
  await handleSkillsCommand(["validate"], {
    ui,
    skillRegistry: registry,
    startBackgroundInput: () => {},
    refreshAfterScan: async () => {},
  });
  assert.ok(out.lines.some((line) => line.includes("Skill 校验失败：2 个 Skill，3 个资源")));
  assert.ok(out.lines.some((line) => line.includes("[deploy] 引用的脚本不存在")));
  assert.equal(out.chat.length, 0);
});
