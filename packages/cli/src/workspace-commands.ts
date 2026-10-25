/**
 * /workspace 命令族：查看 / 追加 / 移除工作区根，管理工作区外的路径放行规则。
 *
 * 工作区根 = 启动目录 + `--add-dir`（本次会话）+ `/workspace add`（持久化到
 * `~/.haji/workspaces.json`）。路径规则写用户级 `permissions.json` 的 `paths` 段，
 * 项目级文件不参与，避免克隆仓库自带扩权配置。
 */
import type { PermissionPathRuleKind, PermissionPathRules } from "./permission-rules.js";
import { TerminalInputCancelledError, type TerminalUI } from "./terminal-input.js";
import { colors } from "./theme.js";

export interface WorkspaceMutationResult {
  ok: boolean;
  root?: string;
  error?: string;
}

export interface WorkspaceCommandContext {
  ui: TerminalUI;
  cwd: string;
  /** 当前生效的追加根（不含 cwd）。 */
  listRoots(): string[];
  addRoot(input: string): WorkspaceMutationResult;
  removeRoot(input: string): WorkspaceMutationResult;
  /** 根或规则变化后重新注入权限引擎。 */
  refreshPathScope(): void;
  listPathRules(): PermissionPathRules;
  savePathRule(kind: PermissionPathRuleKind, pattern: string): boolean;
  removePathRule(kind: PermissionPathRuleKind, pattern: string): boolean;
  readSelectionSafely: (
    options: Parameters<TerminalUI["readSelection"]>[0],
    draftHandling?: "queue" | "restore",
  ) => ReturnType<TerminalUI["readSelection"]>;
}

function usage(ui: TerminalUI): void {
  ui.writeLine(colors.gray("用法："));
  ui.writeLine(colors.gray("  /workspace                   查看工作区根与路径规则"));
  ui.writeLine(colors.gray("  /workspace add <目录>        追加工作区根（持久化，跨会话生效）"));
  ui.writeLine(
    colors.gray("  /workspace remove [目录]     移除追加的工作区根（无参数时进入选择）"),
  );
  ui.writeLine(colors.gray("  /workspace allow <glob>      放行工作区外路径，如 ~/scratch/**"));
  ui.writeLine(colors.gray("  /workspace deny <glob>       禁止路径（优先级高于放行）"));
  ui.writeLine(colors.gray("  /workspace rules             查看 / 删除路径规则"));
}

function printOverview(ctx: WorkspaceCommandContext): void {
  const { ui } = ctx;
  const roots = ctx.listRoots();
  const rules = ctx.listPathRules();
  ui.writeLine(colors.bold("工作区根"));
  ui.writeLine(colors.gray(`  基准（启动目录）：${ctx.cwd}`));
  if (roots.length === 0) {
    ui.writeLine(colors.gray("  追加目录：无（工作区外读写会请求授权）"));
  } else {
    for (const root of roots) ui.writeLine(colors.gray(`  追加目录：${root}`));
  }
  ui.writeLine(colors.bold("路径规则（用户级 permissions.json）"));
  if (rules.allow.length === 0 && rules.deny.length === 0) {
    ui.writeLine(colors.gray("  暂无路径规则"));
  } else {
    for (const pattern of rules.allow) ui.writeLine(colors.gray(`  允许：${pattern}`));
    for (const pattern of rules.deny) ui.writeLine(colors.gray(`  禁止：${pattern}`));
  }
  ui.writeLine(
    colors.gray("提示：--add-dir <目录> 只对本次进程生效；/workspace add 会写入用户配置。"),
  );
}

async function removeInteractive(ctx: WorkspaceCommandContext): Promise<void> {
  const { ui } = ctx;
  const roots = ctx.listRoots();
  if (roots.length === 0) {
    ui.writeLine(colors.gray("当前没有追加的工作区根。"));
    return;
  }
  try {
    const selection = await ctx.readSelectionSafely(
      {
        title: "选择要移除的工作区根（Esc 退出）",
        items: [
          ...roots.map((root) => ({ value: root, label: root })),
          { value: "__done__", label: "完成（不删除）", hotkey: "q" },
        ],
        selectedValue: "__done__",
      },
      "restore",
    );
    if (selection.value === "__done__") return;
    const result = ctx.removeRoot(selection.value);
    ctx.refreshPathScope();
    if (result.ok) ui.writeLine(colors.okLine(`已移除工作区根：${result.root ?? selection.value}`));
    else ui.writeLine(colors.warnLine(result.error ?? "移除失败"));
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) return;
    throw error;
  }
}

async function manageRulesInteractive(ctx: WorkspaceCommandContext): Promise<void> {
  const { ui } = ctx;
  const rules = ctx.listPathRules();
  const entries = [
    ...rules.allow.map((pattern) => ({ kind: "allow" as const, pattern })),
    ...rules.deny.map((pattern) => ({ kind: "deny" as const, pattern })),
  ];
  if (entries.length === 0) {
    ui.writeLine(colors.gray("暂无路径规则。用 /workspace allow <glob> 添加。"));
    return;
  }
  try {
    const selection = await ctx.readSelectionSafely(
      {
        title: "路径规则（选中即删除，Esc 退出）",
        items: [
          ...entries.map(({ kind, pattern }) => ({
            value: `${kind}::${pattern}`,
            label: pattern,
            description: kind === "allow" ? "允许" : "禁止",
          })),
          { value: "__done__", label: "完成（不删除）", hotkey: "q" },
        ],
        selectedValue: "__done__",
      },
      "restore",
    );
    if (selection.value === "__done__") return;
    const separator = selection.value.indexOf("::");
    const kind = selection.value.slice(0, separator) as PermissionPathRuleKind;
    const pattern = selection.value.slice(separator + 2);
    const removed = ctx.removePathRule(kind, pattern);
    ctx.refreshPathScope();
    ui.writeLine(
      removed
        ? colors.okLine(`已删除路径规则：${pattern}（${kind === "allow" ? "允许" : "禁止"}）`)
        : colors.warnLine(`未找到路径规则：${pattern}`),
    );
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) return;
    throw error;
  }
}

/** 分发 /workspace 指令；调用方负责其后的主循环 continue。 */
export async function handleWorkspaceCommand(
  ctx: WorkspaceCommandContext,
  input: { parts: readonly string[] },
): Promise<void> {
  const { ui } = ctx;
  const action = (input.parts[1] ?? "").toLowerCase();
  const rest = input.parts.slice(2).join(" ").trim();

  if (!action || action === "list") {
    printOverview(ctx);
    return;
  }

  if (action === "add") {
    if (!rest) {
      usage(ui);
      return;
    }
    const result = ctx.addRoot(rest);
    if (!result.ok) {
      ui.writeLine(colors.failLine(result.error ?? "添加失败"));
      return;
    }
    ui.writeLine(colors.okLine(`已加入工作区根：${result.root}`));
    ui.writeLine(colors.gray("该目录内的文件工具调用不再需要额外授权，/workspace 可查看。"));
    return;
  }

  if (action === "remove") {
    if (!rest) {
      await removeInteractive(ctx);
      return;
    }
    const result = ctx.removeRoot(rest);
    if (!result.ok) {
      ui.writeLine(colors.failLine(result.error ?? "移除失败"));
      return;
    }
    ui.writeLine(colors.okLine(`已移除工作区根：${result.root ?? rest}`));
    return;
  }

  if (action === "allow" || action === "deny") {
    if (!rest) {
      usage(ui);
      return;
    }
    const saved = ctx.savePathRule(action, rest);
    ctx.refreshPathScope();
    ui.writeLine(
      saved
        ? colors.okLine(
            `已${action === "allow" ? "放行" : "禁止"}路径：${rest}（用户级，跨会话生效）`,
          )
        : colors.failLine("规则写入失败，请检查 ~/.haji/permissions.json 是否可写。"),
    );
    return;
  }

  if (action === "rules") {
    await manageRulesInteractive(ctx);
    return;
  }

  usage(ui);
}
