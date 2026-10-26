import type { BaseTool, ToolDefinition } from "@hajicli/core";

/**
 * 会话目标工具组：目标的记录与收尾全部由模型驱动，没有面向用户的 /goal 指令。
 *
 * - `setgoal`：模型从用户请求中提炼出跨回合的实质目标后记录一句话原文；
 * - `goalfinish`：完成审计（验收点 → 证据）全部通过后标记达成并留档 evidence。
 *
 * 两个工具都只写会话元数据，不动工作区，因此在权限引擎里与 task* 同类，
 * 全模式自动放行；Plan 模式只放行 setgoal（调研阶段就该记下目标），
 * goalfinish 与 taskfinish 同口径不放行——那是实施后的收尾动作。
 */

/** 目标原文长度上限：侧栏与状态行都要放得下，太长的目标本身也说明该拆解了。 */
export const GOAL_TEXT_MAX_LENGTH = 500;

export interface SetGoalResult {
  ok: boolean;
  message: string;
}

export class SetGoalTool implements BaseTool {
  public readonly name = "setgoal";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "setgoal",
      description: `记录或替换当前会话的目标（一句话，最多 ${GOAL_TEXT_MAX_LENGTH} 字）。当用户的请求构成跨回合的实质目标（多步骤实现、修复、重构等）时尽早调用；琐碎问答、单轮可答的问题不要设定。用户转向新方向时替换旧目标；不确定用户意图时先澄清再设定。`,
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "目标原文：具体、可验收，写做什么与完成标准，不写实现步骤",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  };

  public constructor(private readonly set: (text: string) => SetGoalResult) {}

  public async execute(args: Record<string, unknown>): Promise<string> {
    const text = String(args.text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      return "错误：text 参数不能为空，请用一句话写出目标与完成标准。";
    }
    if (text.length > GOAL_TEXT_MAX_LENGTH) {
      return `错误：目标原文超过 ${GOAL_TEXT_MAX_LENGTH} 字（当前 ${text.length} 字），请压缩为一句可验收的目标。`;
    }
    return this.set(text).message;
  }
}

export interface GoalFinishResult {
  ok: boolean;
  message: string;
}

export class GoalFinishTool implements BaseTool {
  public readonly name = "goalfinish";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "goalfinish",
      description:
        "把当前会话目标标记为达成，此后目标不再注入请求。仅当目标存在且完成审计已通过（每个验收点都有实际证据）时调用一次；目标不存在、审计未通过或只是阶段性进展时不要调用。",
      parameters: {
        type: "object",
        properties: {
          evidence: {
            type: "string",
            description: "完成审计摘要：逐条写「验收点 → 证据」（文件、命令输出、测试结果）",
          },
        },
        required: ["evidence"],
        additionalProperties: false,
      },
    },
  };

  public constructor(private readonly finish: (evidence: string) => GoalFinishResult) {}

  public async execute(args: Record<string, unknown>): Promise<string> {
    const evidence = String(args.evidence ?? "").trim();
    if (!evidence) {
      return "错误：evidence 参数不能为空，请逐条写验收点与对应证据后重试。";
    }
    return this.finish(evidence).message;
  }
}
