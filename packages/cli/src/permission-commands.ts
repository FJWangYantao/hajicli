/**
 * /permission 命令族：切换权限档（含规则回退阈值），以及 `/permission rules` 管理永久放行规则。
 *
 * 权限档、阈值与会话授权都由 index.ts 的闭包持有，这里经 PermissionCommandContext 的
 * 访问器读写（可变状态走 getter/setter，不拷贝值）。
 */
import {
  isPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
  type RiskLevel,
} from "@hajicli/core";
import {
  loadAllPermissionRules,
  type PermissionRuleEntry,
  type PermissionRuleScope,
  removePermissionRule,
} from "./permission-rules.js";
import { TerminalInputCancelledError, type TerminalUI } from "./terminal-input.js";
import { colors } from "./theme.js";

export interface PermissionCommandContext {
  ui: Pick<TerminalUI, "writeLine">;
  readSelectionSafely: (
    options: Parameters<TerminalUI["readSelection"]>[0],
  ) => ReturnType<TerminalUI["readSelection"]>;
  getPermissionMode(): PermissionMode;
  getRiskThreshold(): RiskLevel;
  setRiskThreshold(level: RiskLevel): void;
  applyPermissionMode(mode: PermissionMode): Promise<void>;
  /** 手动切档后丢掉未完成的计划审批状态。 */
  resetPlanReview(): void;
  /** 删除规则后刷新内存视图（含 --allow 键），并撤掉本会话里同名的授权。 */
  onRuleRemoved(key: string): void;
}

const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];

const scopeLabel = (scope: PermissionRuleScope): string =>
  scope === "project" ? "本项目" : "全局";

/** /permission rules：列出永久放行规则，选中即删除。 */
async function manageRules(ctx: PermissionCommandContext): Promise<void> {
  const rules = loadAllPermissionRules();
  const entries: Array<{ scopeLevel: PermissionRuleScope; entry: PermissionRuleEntry }> = [
    ...rules.project.map((entry) => ({ scopeLevel: "project" as const, entry })),
    ...rules.user.map((entry) => ({ scopeLevel: "user" as const, entry })),
  ];
  if (entries.length === 0) {
    ctx.ui.writeLine(colors.gray("暂无永久放行规则。授权卡片中选择「永久允许」即可添加。"));
    return;
  }
  let selection: Awaited<ReturnType<PermissionCommandContext["readSelectionSafely"]>>;
  try {
    selection = await ctx.readSelectionSafely({
      title: "永久放行规则（选中即删除，Esc 退出）",
      items: [
        ...entries.map(({ scopeLevel, entry }) => ({
          value: `${scopeLevel}::${entry.key}`,
          label: entry.key,
          description: `${scopeLabel(scopeLevel)} · ${entry.scope}`,
        })),
        { value: "__done__", label: "完成（不删除）", hotkey: "q" },
      ],
      selectedValue: "__done__",
    });
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) return;
    throw error;
  }
  if (selection.value === "__done__") return;
  const separatorIndex = selection.value.indexOf("::");
  const scopeLevel = selection.value.slice(0, separatorIndex) as PermissionRuleScope;
  const ruleKey = selection.value.slice(separatorIndex + 2);
  if (removePermissionRule(ruleKey, scopeLevel)) {
    ctx.onRuleRemoved(ruleKey);
    ctx.ui.writeLine(
      colors.okLine(`已删除永久放行规则：${ruleKey}（${scopeLabel(scopeLevel)}）。`),
    );
  } else {
    ctx.ui.writeLine(colors.warnLine(`未找到规则：${ruleKey}（可能已被其他会话删除）。`));
  }
}

/** 无参数时弹选择器：权限档 + 规则回退阈值；取消返回 undefined。 */
async function pickMode(ctx: PermissionCommandContext): Promise<string | undefined> {
  try {
    const selection = await ctx.readSelectionSafely({
      title: "选择权限档次",
      items: PERMISSION_MODES,
      selectedValue: ctx.getPermissionMode(),
      secondary: {
        label: "规则回退阈值（分类器不可用时）",
        items: [
          { value: "low", label: "LOW", description: "严苛（允许无副作用命令）" },
          { value: "medium", label: "MEDIUM", description: "标准（推荐，阻止高危操作）" },
          { value: "high", label: "HIGH", description: "宽松（仅阻止极危险破坏命令）" },
        ],
        selectedValue: ctx.getRiskThreshold(),
      },
    });
    const secondary = selection.secondaryValue as RiskLevel | undefined;
    if (secondary && RISK_LEVELS.includes(secondary)) ctx.setRiskThreshold(secondary);
    return selection.value;
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) {
      ctx.ui.writeLine(colors.gray("已取消切换权限模式。"));
      return undefined;
    }
    throw error;
  }
}

/** `/permission [rules | <档位>]`；args 不含指令本身。 */
export async function handlePermissionCommand(
  args: readonly string[],
  ctx: PermissionCommandContext,
): Promise<void> {
  if (args[0]?.toLowerCase() === "rules") {
    await manageRules(ctx);
    return;
  }
  const requested = args[0]?.toLowerCase() || (await pickMode(ctx));
  if (requested === undefined) return;
  if (!isPermissionMode(requested)) {
    ctx.ui.writeLine(colors.failLine(`无效权限模式：${requested}`));
    ctx.ui.writeLine(colors.gray("可选：plan、default、accept-edit、auto、bypass-permissions"));
    return;
  }

  await ctx.applyPermissionMode(requested);
  ctx.resetPlanReview();
  const mode = ctx.getPermissionMode();
  ctx.ui.writeLine(
    colors.okLine(
      mode === "auto"
        ? "系统权限已设置为 [auto]（LLM 安全分类器；判定失败或超时一律拒绝）"
        : `系统权限已设置为 [${mode}] (规则回退阈值: ${ctx.getRiskThreshold()})`,
    ),
  );
  if (mode === "plan") {
    ctx.ui.writeLine(colors.gray("Plan 模式只允许只读调研；计划提交后会等待你的批准。"));
  }
}
