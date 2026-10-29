import type { ToolExecutionContext } from "@hajicli/core";
import type { UserAnswer, UserQuestion } from "@hajicli/plugins";
import { TerminalInputCancelledError, type TerminalUI } from "./terminal-input.js";

interface QuestionHost {
  ui: TerminalUI;
  notify(): void;
  blocked(): void;
  resume(draft?: string): void;
}

export async function askUserQuestion(
  host: QuestionHost,
  question: UserQuestion,
  context?: ToolExecutionContext,
): Promise<UserAnswer> {
  const { ui } = host;
  if (!ui.isInteractive() || context?.agentId) return { status: "unavailable" };
  const draft = ui.cancelInput();
  const cancel = () => {
    ui.cancelInput();
    ui.cancelSelection();
  };
  try {
    context?.abortSignal?.throwIfAborted();
    context?.abortSignal?.addEventListener("abort", cancel, { once: true });
    host.notify();
    host.blocked();
    ui.writeLine(question.question);
    if (question.options) {
      const selection = await ui.readSelection({
        title: "回答模型的问题",
        preview: [question.question],
        items: [
          ...question.options.map((label, index) => ({ value: String(index), label })),
          { value: "custom", label: "其他：自行填写…" },
        ],
      });
      if (selection.value !== "custom") {
        return { status: "answered", answer: question.options[Number(selection.value)] };
      }
    }
    const answer = (await ui.readInput({ prompt: "你的回答 › " })).trim();
    return answer ? { status: "answered", answer } : { status: "cancelled" };
  } catch (error) {
    if (error instanceof TerminalInputCancelledError || context?.abortSignal?.aborted) {
      return { status: "cancelled" };
    }
    throw error;
  } finally {
    context?.abortSignal?.removeEventListener("abort", cancel);
    host.resume(draft);
  }
}
