import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSlashCommandCatalog,
  builtinCommandHeads,
  matchSlashCommands,
} from "../dist/cli-help.js";
import {
  expandCustomCommand,
  loadCustomCommands,
  matchCustomCommand,
  parseCommandFile,
} from "../dist/custom-commands.js";

/** 自定义斜杠命令：.haji/commands/<名称>.md 的扫描、展开、补全，以及 -p 里真的展开后发给模型。 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function withIsolatedHome(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-commands-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  fs.mkdirSync(path.join(home, ".haji", "commands"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".haji", "commands"), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return run({ root, home, cwd });
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

test("frontmatter is optional and only simple key: value pairs are read", () => {
  assert.deepEqual(
    parseCommandFile(
      '---\ndescription: "按清单 review"\nargument-hint: <文件>\n---\n检查 $ARGUMENTS\n',
    ),
    { description: "按清单 review", argumentHint: "<文件>", body: "检查 $ARGUMENTS" },
  );
  assert.deepEqual(parseCommandFile("  直接是正文\n"), { body: "直接是正文" });
});

test("templates expand $ARGUMENTS and $1…$9, and never silently drop arguments", () => {
  const command = (template) => ({ name: "x", description: "", template, scope: "user", path: "" });
  assert.equal(
    expandCustomCommand(command("看 $ARGUMENTS 的问题"), " a.ts b.ts "),
    "看 a.ts b.ts 的问题",
  );
  assert.equal(
    expandCustomCommand(command("从 $1 到 $2，$3 留空"), "main dev"),
    "从 main 到 dev， 留空",
  );
  // $10 不是 $1 + "0"。
  assert.equal(expandCustomCommand(command("$10"), "a"), "$10\n\na");
  assert.equal(
    expandCustomCommand(command("写提交说明"), "只看暂存区"),
    "写提交说明\n\n只看暂存区",
  );
  assert.equal(expandCustomCommand(command("写提交说明"), ""), "写提交说明");
});

test("project commands override user ones; builtin names and bad names are skipped", () => {
  withIsolatedHome(({ home, cwd }) => {
    const userDir = path.join(home, ".haji", "commands");
    const projectDir = path.join(cwd, ".haji", "commands");
    fs.writeFileSync(path.join(userDir, "review.md"), "用户级 review");
    fs.writeFileSync(path.join(userDir, "commit-msg.md"), "# 写提交说明\n按约定式提交写");
    fs.writeFileSync(
      path.join(projectDir, "review.md"),
      "---\ndescription: 项目 review\n---\n项目级 review $1",
    );
    fs.writeFileSync(path.join(projectDir, "model.md"), "想覆盖内置 /model");
    fs.writeFileSync(path.join(projectDir, "permissions.md"), "想覆盖别名 /permissions");
    fs.writeFileSync(path.join(projectDir, "Bad Name.md"), "x");
    fs.writeFileSync(path.join(projectDir, "notes.txt"), "不是 md");

    const scan = loadCustomCommands(builtinCommandHeads(), cwd);
    assert.deepEqual(
      scan.commands.map((command) => [command.name, command.scope, command.description]),
      [
        ["commit-msg", "user", "写提交说明"],
        ["review", "project", "项目 review"],
      ],
    );
    const warnings = scan.warnings.join("\n");
    assert.match(warnings, /model\.md：与内置指令 \/model 重名/);
    assert.match(warnings, /permissions\.md：与内置指令 \/permissions 重名/);
    assert.match(warnings, /Bad Name\.md：命令名只能用/);

    assert.deepEqual(
      matchCustomCommand("/review src/a.ts", scan.commands)?.prompt,
      "项目级 review src/a.ts",
    );
    assert.equal(matchCustomCommand("/REVIEW", scan.commands)?.command.name, "review");
    assert.equal(matchCustomCommand("/unknown", scan.commands), undefined);
    assert.equal(matchCustomCommand("review", scan.commands), undefined);

    // 进补全：模糊搜索能找到，分组标「自定义命令」。
    const catalog = buildSlashCommandCatalog([], scan.commands);
    const entry = catalog.find((item) => item.command === "/review");
    assert.equal(entry?.group, "自定义命令");
    assert.equal(entry?.topLevel, false);
    assert.ok(matchSlashCommands("/revi", catalog).some((item) => item.command === "/review"));
  });
});

test("e2e: haji -p expands a custom command before sending it to the model", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    if (payload.tools) {
      const lastUser = [...payload.messages].reverse().find((message) => message.role === "user");
      seen.push(String(lastUser?.content));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = { choices: [{ index: 0, delta: { content: "好的。" }, finish_reason: "stop" }] };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-commands-e2e-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "work");
    fs.mkdirSync(path.join(cwd, ".haji", "commands"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".haji", "commands", "review.md"),
      "按团队清单审查 $ARGUMENTS，只报问题。",
    );
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DEEPSEEK_API_KEY: "sk-fake-for-test",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      HAJI_POST_EDIT_VERIFY: "0",
    };
    delete env.VOLC_API_KEY;
    delete env.ARK_API_KEY;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliEntry, "-p", "/review src/a.ts"], { cwd, env });
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^按团队清单审查 src\/a\.ts，只报问题。/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
