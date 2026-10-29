/**
 * 扩展类只读/维护命令：`/mcp`（MCP server 状态）、`/skills [validate|reload]`（Skill 列表与校验）
 * 与 `/hooks [trust|reload]`（用户 Hook 列表与项目级信任）。
 *
 * `/mcp` 的排版是纯函数，便于单测；`/skills` 经 SkillCommandContext 拿注册表与刷新钩子。
 * `/skill <名称>` 会改写主循环的待发送消息，仍留在 index.ts。
 */
import type { SkillRegistry } from "@hajicli/core";
import type { McpServerConfig, McpServerStatus } from "@hajicli/plugins";
import { TerminalInputCancelledError, type TerminalUI } from "./terminal-input.js";
import { colors } from "./theme.js";
import {
  describeHook,
  type LoadedUserHooks,
  projectHooksPath,
  trustProjectHooks,
  type UserHookEntry,
  type UserHookRunner,
  userHooksPath,
} from "./user-hooks.js";

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

const HOOKS_EXAMPLE = {
  PreToolUse: [{ matcher: "bash", command: "./scripts/guard.sh", timeoutMs: 10000 }],
  PostToolUse: [{ matcher: "write|edit", command: 'npx prettier --write "$HAJI_TOOL_PATH"' }],
  Stop: [{ command: 'notify-send haji "回合结束"' }],
};

/** 启动时的 Hook 提示：配置错误，以及存在但还没信任的项目级 hooks。 */
export function describeHookLoadWarnings(loaded: LoadedUserHooks, unattended: boolean): string[] {
  const warnings: string[] = [];
  for (const error of loaded.user.errors) warnings.push(`~/.haji/hooks.json：${error}`);
  const project = loaded.project;
  if (!project) return warnings;
  for (const error of project.errors) warnings.push(`.haji/hooks.json：${error}`);
  if (!project.trusted && project.entries.length > 0) {
    warnings.push(
      unattended
        ? `项目级 hooks（${project.entries.length} 条）未信任，本次不执行。交互会话里 /hooks trust 审阅后启用，或设 HAJI_TRUST_PROJECT_HOOKS=1。`
        : `检测到项目级 hooks（${project.entries.length} 条，.haji/hooks.json）尚未信任，未启用。输入 /hooks trust 审阅后启用。`,
    );
  }
  return warnings;
}

function hookRow(entry: UserHookEntry, enabled: boolean): string {
  const state = enabled ? colors.green("启用") : colors.gray("未信任");
  const timeout = colors.gray(`${Math.round(entry.timeoutMs / 1000)}s`);
  return `  ${state} ${colors.purple(describeHook(entry))} ${timeout}`;
}

export interface HookCommandContext {
  ui: Writer;
  runner: Pick<UserHookRunner, "reload" | "getLoaded">;
  readSelectionSafely: (
    options: Parameters<TerminalUI["readSelection"]>[0],
  ) => ReturnType<TerminalUI["readSelection"]>;
}

function listHooks(ui: Writer, loaded: LoadedUserHooks): void {
  const project = loaded.project;
  if (loaded.user.entries.length === 0 && !project) {
    ui.writeLine(
      colors.gray(`暂无 Hook。在 ${userHooksPath()}（或项目 .haji/hooks.json）里配置：`),
    );
    ui.writeChat(`${colors.gray(JSON.stringify(HOOKS_EXAMPLE, null, 2))}\n`);
    ui.writeLine(
      colors.gray(
        "PreToolUse 退出码 2 拦截工具（stderr 作原因）；PostToolUse 退出码 2 把 stderr 回注给模型；UserPromptSubmit 的 stdout 作补充上下文。",
      ),
    );
    return;
  }
  const lines = [colors.bold("Hooks")];
  lines.push(colors.gray(`用户级 ${userHooksPath()}`));
  if (loaded.user.entries.length === 0) lines.push(colors.gray("  （无）"));
  for (const entry of loaded.user.entries) lines.push(hookRow(entry, true));
  for (const error of loaded.user.errors) lines.push(colors.red(`  ! ${error}`));
  if (project) {
    lines.push(
      colors.gray(
        `项目级 ${project.path}${project.trusted ? "（已信任）" : "（未信任 · /hooks trust）"}`,
      ),
    );
    if (project.entries.length === 0) lines.push(colors.gray("  （无）"));
    for (const entry of project.entries) lines.push(hookRow(entry, project.trusted));
    for (const error of project.errors) lines.push(colors.red(`  ! ${error}`));
  }
  ui.writeChat(`${lines.join("\n")}\n`);
}

/** /hooks trust：先把项目级每条命令原样列出来，确认后按当前内容哈希记住。 */
async function trustHooks(ctx: HookCommandContext): Promise<void> {
  const loaded = ctx.runner.reload();
  const project = loaded.project;
  if (!project) {
    ctx.ui.writeLine(colors.gray(`当前项目没有 ${projectHooksPath()}。`));
    return;
  }
  if (project.trusted) {
    ctx.ui.writeLine(colors.gray("项目级 hooks 已信任，内容未变。"));
    return;
  }
  if (project.entries.length === 0) {
    ctx.ui.writeLine(colors.warnLine("项目级 hooks.json 没有可用条目，先修正配置。"));
    for (const error of project.errors) ctx.ui.writeLine(colors.failLine(error));
    return;
  }
  let selection: Awaited<ReturnType<HookCommandContext["readSelectionSafely"]>>;
  try {
    selection = await ctx.readSelectionSafely({
      title: "信任项目级 hooks？这些命令会在本机以你的身份执行",
      preview: project.entries.map(
        (entry) => `${entry.event}${entry.matcher ? ` [${entry.matcher}]` : ""} → ${entry.command}`,
      ),
      items: [
        {
          value: "trust",
          label: "信任并启用",
          description: "记住这一版内容；文件改动后需要重新信任",
        },
        { value: "cancel", label: "取消", hotkey: "n" },
      ],
      selectedValue: "cancel",
    });
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) return;
    throw error;
  }
  if (selection.value !== "trust") {
    ctx.ui.writeLine(colors.gray("未信任，项目级 hooks 保持停用。"));
    return;
  }
  if (!trustProjectHooks(process.cwd(), project.hash)) {
    ctx.ui.writeLine(
      colors.failLine("信任记录写入失败（~/.haji/hooks-trust.json），请检查目录权限。"),
    );
    return;
  }
  ctx.runner.reload();
  ctx.ui.writeLine(colors.okLine(`已信任并启用 ${project.entries.length} 条项目级 hooks。`));
}

/** `/hooks [trust|reload]`；args 不含指令本身。 */
export async function handleHooksCommand(
  args: readonly string[],
  ctx: HookCommandContext,
): Promise<void> {
  const sub = args[0]?.toLowerCase();
  if (sub === "trust") {
    await trustHooks(ctx);
    return;
  }
  const loaded = sub === "reload" ? ctx.runner.reload() : ctx.runner.getLoaded();
  if (sub === "reload") {
    const count = loaded.active.length;
    ctx.ui.writeLine(colors.okLine(`已重新读取 hooks 配置，生效 ${count} 条。`));
  }
  listHooks(ctx.ui, loaded);
}
