/**
 * 扩展类只读/维护命令：`/mcp`（MCP server 状态）与 `/skills [validate|reload]`（Skill 列表与校验）。
 *
 * `/mcp` 的排版是纯函数，便于单测；`/skills` 经 SkillCommandContext 拿注册表与刷新钩子。
 * `/skill <名称>` 会改写主循环的待发送消息，仍留在 index.ts。
 */
import type { SkillRegistry } from "@hajicli/core";
import type { McpServerConfig, McpServerStatus } from "@hajicli/plugins";
import type { TerminalUI } from "./terminal-input.js";
import { colors } from "./theme.js";

type Writer = Pick<TerminalUI, "writeLine" | "writeChat">;

const MCP_CONFIG_EXAMPLE = {
  mcpServers: {
    example: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    },
  },
};

/** /mcp：没有 server 时给配置示例，否则逐个列出状态、工具与错误。 */
export function showMcpStatus(
  ui: Writer,
  statuses: readonly McpServerStatus[],
  configs: Readonly<Record<string, McpServerConfig>>,
): void {
  if (statuses.length === 0) {
    ui.writeLine(
      colors.gray(
        "未配置 MCP server。在 .haji/config.json（用户级 ~/.haji/ 或项目级）添加 mcpServers 字段：",
      ),
    );
    ui.writeChat(`${colors.gray(JSON.stringify(MCP_CONFIG_EXAMPLE, null, 2))}\n`);
    ui.writeLine(
      colors.gray(
        "可选字段：env（环境变量）、readOnly: true（工具视为只读，免审批）、enabled: false（禁用）、callTimeoutMs。",
      ),
    );
    return;
  }
  const stateLabel = (status: McpServerStatus) =>
    status.state === "running"
      ? colors.green("running")
      : status.state === "disabled"
        ? colors.gray("disabled")
        : colors.red("failed");
  const lines = [colors.bold(`MCP servers（${statuses.length}）`)];
  for (const status of statuses) {
    const readOnly =
      status.state === "running" && configs[status.name]?.readOnly ? colors.gray(" · 只读") : "";
    lines.push(
      `  ${colors.purple(status.name.padEnd(20))} ${stateLabel(status)}${readOnly} · ${status.toolCount} 个工具`,
    );
    if (status.state === "failed" && status.error)
      lines.push(colors.muted(`    ${status.error.replace(/\s+/g, " ").slice(0, 160)}`));
    for (const tool of status.tools) lines.push(colors.gray(`    ${tool}`));
  }
  ui.writeChat(`${lines.join("\n")}\n`);
}

export interface SkillCommandContext {
  ui: Writer;
  skillRegistry: SkillRegistry;
  /** 扫描要读整个 Skill 目录：先把输入行还给用户，避免看起来卡死。 */
  startBackgroundInput(): void;
  /** Skill 集合变化后重建 system prompt（保留对话上下文）并保存会话。 */
  refreshAfterScan(): Promise<void>;
}

async function validateSkills(ctx: SkillCommandContext): Promise<void> {
  ctx.startBackgroundInput();
  await ctx.skillRegistry.scan();
  const result = await ctx.skillRegistry.validate();
  await ctx.refreshAfterScan();
  const summary = `${result.checkedSkills} 个 Skill，${result.checkedResources} 个资源`;
  ctx.ui.writeLine(
    result.valid
      ? colors.okLine(`Skill 校验通过：${summary}。`)
      : colors.failLine(`Skill 校验失败：${summary}。`),
  );
  for (const issue of result.issues) {
    const scope = issue.skill ? `[${issue.skill}] ` : "";
    ctx.ui.writeLine(
      issue.severity === "error"
        ? colors.failLine(`${scope}${issue.message}`)
        : colors.warnLine(`${scope}${issue.message}`),
    );
  }
}

function listSkills(ctx: SkillCommandContext): void {
  const loaded = new Map(ctx.skillRegistry.getLoaded("main").map((skill) => [skill.name, skill]));
  const skills = ctx.skillRegistry.list();
  if (skills.length === 0) {
    ctx.ui.writeLine(
      colors.gray("暂无 Skill。项目目录：.haji/skills；用户目录：%USERPROFILE%/.haji/skills。"),
    );
    return;
  }
  ctx.ui.writeChat(
    `${[
      colors.bold(`Skills (${skills.length})`),
      ...skills.map((skill) => {
        const state = loaded.get(skill.name);
        const status = state ? (state.resident ? "loaded" : "reload needed") : "available";
        const invocation = skill.userInvocable ? "" : " · model-only";
        return `  ${colors.purple(skill.name.padEnd(22))} ${colors.gray(`[${skill.source}] ${status}${invocation}`)}\n    ${skill.description}`;
      }),
    ].join("\n")}\n`,
  );
}

/** `/skills [validate|reload]`；args 不含指令本身。reload 之后照常列出。 */
export async function handleSkillsCommand(
  args: readonly string[],
  ctx: SkillCommandContext,
): Promise<void> {
  const sub = args[0]?.toLowerCase();
  if (sub === "validate") {
    await validateSkills(ctx);
    return;
  }
  if (sub === "reload") {
    ctx.startBackgroundInput();
    const result = await ctx.skillRegistry.scan();
    await ctx.refreshAfterScan();
    ctx.ui.writeLine(colors.okLine(`已重新扫描 ${result.skills.length} 个 Skill。`));
    for (const warning of result.warnings) ctx.ui.writeLine(colors.warnLine(warning));
  }
  listSkills(ctx);
}
