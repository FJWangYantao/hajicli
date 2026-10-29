import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";

export interface UserQuestion {
  question: string;
  options?: string[];
}

export type UserAnswer =
  | { status: "answered"; answer: string }
  | { status: "cancelled" | "unavailable" };

/** 用户的答案作为工具结果回传，不替用户推断答案。 */
export class AskQuestionTool implements BaseTool {
  public readonly name = "askquestion";
  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "askquestion",
      description:
        "向用户提出一个问题并等待回答。可提供单选选项，用户也可以自行填写。仅在需要用户补充信息或作决定时使用；取消或无法交互时不要猜测答案。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要向用户提出的问题（最多 2000 字）。" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 10,
            description: "可选的单选答案（2–10 项，每项最多 200 字）。",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  };

  public constructor(
    private readonly ask: (
      question: UserQuestion,
      context?: ToolExecutionContext,
    ) => Promise<UserAnswer>,
  ) {}

  public getMutationScope(): "none" {
    return "none";
  }

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    if (typeof args.question !== "string" || !args.question.trim() || args.question.length > 2000) {
      return "错误: question 必须是 1–2000 字的问题。";
    }
    let options: string[] | undefined;
    if (args.options !== undefined) {
      if (
        !Array.isArray(args.options) ||
        args.options.length < 2 ||
        args.options.length > 10 ||
        args.options.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)
      ) {
        return "错误: options 必须包含 2–10 个非空字符串，每项最多 200 字。";
      }
      options = args.options.map((item: string) => item.trim());
      if (new Set(options).size !== options.length) return "错误: options 不能重复。";
    }
    if (context?.abortSignal?.aborted) return JSON.stringify({ status: "cancelled" });
    const result = await this.ask({ question: args.question.trim(), options }, context);
    return JSON.stringify(result);
  }
}
