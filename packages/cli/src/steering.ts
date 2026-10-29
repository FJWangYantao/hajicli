import type { ChatMessage, ToolCall } from "@hajicli/core";

/** 点击时核对屏幕上的原文，避免队列移位后引导了另一条消息。 */
export function takeQueuedSteer(
  queue: string[],
  index: number,
  expected: string,
): string | undefined {
  if (queue[index] !== expected || !expected.trim() || expected.trimStart().startsWith("/")) return;
  return queue.splice(index, 1)[0];
}

export function appendSteering(messages: ChatMessage[], inputs: string[]): string[] {
  const taken = inputs.splice(0);
  for (const content of taken) messages.push({ role: "user", content });
  return taken;
}

export function skipSteeredCalls(messages: ChatMessage[], calls: readonly ToolCall[]): void {
  for (const call of calls)
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: "[工具调用已跳过：用户发送了 steer 补充指令，请根据最新用户消息重新决定下一步。]",
    });
}
