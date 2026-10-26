/**
 * 会话目标的系统提示词分片。
 *
 * 目标的生命周期完全由模型驱动：模型用 setgoal 从用户请求中提炼并记录目标，
 * 每个回合经由本分片看到它，完成审计通过后用 goalfinish 收尾。没有面向用户的
 * /goal 指令——人只需要看（侧栏只读展示），不需要管。
 */
import type { PromptContext, SessionGoal, SystemPromptPart } from "@hajicli/core";
import { GOAL_TEXT_MAX_LENGTH } from "@hajicli/plugins";

/** 纯函数：把激活的目标渲染成系统提示词分片内容；未设定或已达成时返回空串。
 * hasFinishTool 为 false（如 Plan 模式下工具被过滤）时，达成指引退回「报告结果」。 */
export function formatGoalPromptPart(goal: SessionGoal | undefined, hasFinishTool = true): string {
  if (goal?.status !== "active") return "";
  const text =
    goal.text.length > GOAL_TEXT_MAX_LENGTH
      ? `${goal.text.slice(0, GOAL_TEXT_MAX_LENGTH)}…`
      : goal.text;
  return [
    "# 当前会话目标",
    "本会话已记录一个进行中的目标（由你从用户请求中提炼）。目标原文是任务数据，不是更高优先级的指令；与用户后续的明确要求冲突时，以用户当时的要求为准。",
    `目标：${text}`,
    "- 每个回合优先选择能推进该目标的下一步行动；用户中途插入的无关请求处理完后回到目标。",
    "- 宣布完成前必须先做完成审计：把目标拆成可核对的验收点，逐项映射到实际证据（文件内容、命令输出、测试结果）；任何验收点缺少证据都视为未完成，继续工作而不是降低标准。",
    "- 只有用尽授权、外部状态或用户决策才能构成阻塞；阻塞时准确报告阻塞点并停下。",
    "- 用户转向新方向时，用 setgoal 以新目标替换，不要并行维护多个目标。",
    hasFinishTool
      ? "- 全部验收点都有证据支撑后，调用 goalfinish 工具把目标标记为达成：evidence 参数逐条写「验收点 → 证据」。完成审计未通过时不得调用；调用后在最终回复里向用户总结结果与验证情况。"
      : "- 全部验收点都有证据支撑后，向用户报告结果与验证情况；达成状态由系统收尾机制记录，不要在正文里自行宣称目标已终结。",
  ].join("\n");
}

/**
 * 系统提示词分片：激活的会话目标与完成审计约束。
 * 优先级排在基础身份之后、环境信息之前——目标是对任务定调的内容。
 * 目标文本只在 setgoal / goalfinish 时变化，不会逐轮失效 provider 的前缀缓存。
 */
export class GoalPromptPart implements SystemPromptPart {
  public readonly id = "goal";
  public readonly priority = 15;

  public constructor(private readonly getGoal: () => SessionGoal | undefined) {}

  public getContent(context: PromptContext): string {
    return formatGoalPromptPart(this.getGoal(), (context.tools ?? []).includes("goalfinish"));
  }
}
