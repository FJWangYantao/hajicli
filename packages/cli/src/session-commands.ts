/**
 * 会话相关命令族：/clear（新会话）、/resume（恢复历史会话并回显轨迹）、
 * /rewind（消息 + 代码快照回退，并把消息回填输入框）。
 *
 * 从 index.ts 主循环分发抽出；会话状态经 SessionCommandContext 注入。
 */
import {
  type AgentManager,
  type ChatMessage,
  isFailedToolOutput,
  type SessionManager,
  type SkillRegistry,
  type SnapshotEngine,
  type TaskStore,
} from "@hajicli/core";
import { formatToolCell, summarizeToolCall, summarizeToolResult } from "./cli-runtime.js";
import { MarkdownStreamRenderer } from "./markdown-renderer.js";
import { queueRewindRefill, REWIND_CONFIRM_DEFAULT } from "./rewind-flow.js";
import {
  type SlashCommand,
  TerminalInputCancelledError,
  type TerminalUI,
} from "./terminal-input.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { colors } from "./theme.js";

/** 与 index.ts 的 USER_REJECTED_TOOL_OUTPUT 保持同值：用户拒绝执行时回给模型的输出。 */
const USER_REJECTED_TOOL_OUTPUT = "错误: 用户拒绝了此命令的执行请求。";

export interface SessionCommandContext {
  ui: TerminalUI;
  sessionManager: SessionManager;
  taskStore: TaskStore;
  snapshotEngine: SnapshotEngine;
  agentManager: AgentManager;
  skillRegistry: SkillRegistry;
  readSelectionSafely: (
    options: Parameters<TerminalUI["readSelection"]>[0],
    draftHandling?: "queue" | "restore",
  ) => ReturnType<TerminalUI["readSelection"]>;
  getSlashCommands(): SlashCommand[];
  /** 待处理输入队列（const 数组引用，可直接入队）。 */
  pendingInputs: string[];
  getMessages(): ChatMessage[];
  setMessages(messages: ChatMessage[]): void;
  getSystemPrompt(): string;
  /** 重置 Plan 模式的审阅状态（planReadyForReview / planReviewSummaryRequested）。 */
  resetPlanReviewState(): void;
  syncTaskPlanUI(): void;
  refreshSystemPrompt(): Promise<void>;
  refreshAgentVerificationContext(messages: ChatMessage[]): boolean;
  saveSession(): void;
  updateStatusUI(): void;
}

/** 分发 /clear 指令；调用方负责其后的主循环 continue。 */
export async function handleClearCommand(ctx: SessionCommandContext): Promise<void> {
  const { ui, sessionManager, taskStore, snapshotEngine, agentManager, skillRegistry } = ctx;
  sessionManager.startNewSession();
  taskStore.setTaskScope(sessionManager.getCurrentSession().id);
  snapshotEngine.setScope(sessionManager.getCurrentSession().id);
  agentManager.setScope(sessionManager.getCurrentSession().id);
  skillRegistry.clearLoaded("main");
  ctx.resetPlanReviewState();
  ctx.syncTaskPlanUI();
  ctx.setMessages([{ role: "system", content: ctx.getSystemPrompt() }]);
  ctx.refreshAgentVerificationContext(ctx.getMessages());
  ctx.saveSession();
  ctx.updateStatusUI();
  ui.clearChat();
  ui.writeLine(colors.okLine("已开启全新对话并重置上下文。"));
}

/** 加载并回显一个历史会话；/resume 与启动参数 -c/-r 共用。 */
async function loadAndRenderSession(
  ctx: SessionCommandContext,
  sessionId: string,
): Promise<boolean> {
  const { ui, sessionManager, taskStore, snapshotEngine, agentManager, skillRegistry } = ctx;
  const loaded = sessionManager.loadSession(sessionId);
  if (!loaded || loaded.messages.length === 0) {
    ui.writeLine(colors.warnLine("选中的会话为空或加载失败。"));
    return false;
  }
  taskStore.setTaskScope(loaded.id);
  snapshotEngine.setScope(loaded.id);
  agentManager.setScope(loaded.id);
  ctx.resetPlanReviewState();
  ctx.syncTaskPlanUI();
  ctx.setMessages(loaded.messages);
  skillRegistry.restoreScopeFromMessages("main", loaded.messages);
  await ctx.refreshSystemPrompt();
  ctx.refreshAgentVerificationContext(loaded.messages);
  ctx.saveSession();
  ctx.updateStatusUI();
  const historyOutput: string[] = [];
  const appendHistoryLine = (value: string = "") => historyOutput.push(`${value}\n`);
  appendHistoryLine(
    colors.okLine(`已恢复会话：「${loaded.title}」 (${loaded.messages.length} 条上下文)`),
  );
  // 工具结果并入对应调用的工具块显示，这里先按调用 id 建立索引。
  const historyToolOutputs = new Map<string, string>();
  for (const m of loaded.messages) {
    if (m.role === "tool" && m.tool_call_id && typeof m.content === "string") {
      historyToolOutputs.set(m.tool_call_id, m.content);
    }
  }
  // 完整回显历史会话中的全量消息轨迹 (User / Assistant / Tool)
  for (const m of loaded.messages) {
    if (m.role === "system") continue;

    if (m.role === "user" && typeof m.content === "string") {
      appendHistoryLine();
      appendHistoryLine(colors.userMsg(sanitizeTerminalText(m.content)));
      appendHistoryLine();
    } else if (m.role === "assistant") {
      if (m.reasoning_content) {
        appendHistoryLine(colors.gray(`深度思考 (${m.reasoning_content.length} 字)`));
      }
      if (m.content) {
        const mdRenderer = new MarkdownStreamRenderer(() => ui.getContentWidth());
        const rendered = mdRenderer.render(m.content, true);
        appendHistoryLine(rendered);
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          let argsObj: Record<string, unknown> = {};
          try {
            argsObj = JSON.parse(tc.function.arguments);
          } catch {}
          const output = historyToolOutputs.get(tc.id);
          const outcome =
            output === undefined
              ? undefined
              : summarizeToolResult(
                  tc.function.name,
                  output,
                  {
                    blocked: isFailedToolOutput(output),
                    rejected: output === USER_REJECTED_TOOL_OUTPUT,
                  },
                  argsObj,
                );
          for (const row of formatToolCell({
            status: outcome?.status ?? "failed",
            toolName: tc.function.name,
            summary: summarizeToolCall(tc.function.name, argsObj),
            width: ui.getContentWidth(),
            resultText: outcome?.text ?? "无执行结果",
            preview: outcome?.preview,
          })) {
            appendHistoryLine(row);
          }
        }
      }
      appendHistoryLine();
    }
  }
  ui.replaceChat(historyOutput.join(""));
  return true;
}

/** haji -c：恢复最近一个历史会话（不含当前空会话）。 */
export async function resumeLatestSession(ctx: SessionCommandContext): Promise<boolean> {
  const { sessionManager, ui } = ctx;
  await sessionManager.flush();
  const sessions = sessionManager
    .listSessions()
    .filter((session) => session.id !== sessionManager.getCurrentSession().id);
  if (sessions.length === 0) {
    ui.writeLine(colors.warnLine("暂无历史会话可继续。"));
    return false;
  }
  return loadAndRenderSession(ctx, sessions[0].id);
}

/** haji -r [关键词]：唯一命中直接恢复，多个命中进入选择器，无命中提示。 */
export async function resumeByKeyword(
  ctx: SessionCommandContext,
  keyword?: string,
): Promise<boolean> {
  const { sessionManager, ui } = ctx;
  if (!keyword?.trim()) {
    await handleResumeCommand(ctx, "");
    return true;
  }
  await sessionManager.flush();
  const sessions = sessionManager
    .listSessions()
    .filter((session) => session.id !== sessionManager.getCurrentSession().id)
    .filter((session) => fuzzyMatchSession(keyword.trim(), session));
  if (sessions.length === 0) {
    ui.writeLine(colors.warnLine(`没有匹配「${keyword}」的历史会话。`));
    return false;
  }
  if (sessions.length === 1) {
    return loadAndRenderSession(ctx, sessions[0].id);
  }
  await handleResumeCommand(ctx, keyword.trim());
  return true;
}

/** 子序列匹配：keyword 的字符按顺序出现在目标文本中（不区分大小写）。 */
function fuzzyMatchSession(
  keyword: string,
  session: { title: string; messages: ChatMessage[] },
): boolean {
  const needle = keyword.toLowerCase();
  const firstUserMessage =
    session.messages.find(
      (message) => message.role === "user" && typeof message.content === "string",
    )?.content ?? "";
  const haystack = `${session.title}\n${firstUserMessage}`.toLowerCase();
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/** 分发 /resume 指令；keyword 用于按标题/首条用户消息模糊过滤；调用方负责其后的主循环 continue。 */
export async function handleResumeCommand(ctx: SessionCommandContext, keyword = ""): Promise<void> {
  const { ui, sessionManager } = ctx;
  await sessionManager.flush();
  const allSessions = sessionManager.listSessions();
  if (allSessions.length === 0) {
    ui.writeLine(colors.warnLine("暂无存盘的历史对话记录。"));
    return;
  }
  const sessions = keyword
    ? allSessions.filter((session) => fuzzyMatchSession(keyword, session))
    : allSessions;
  if (sessions.length === 0) {
    ui.writeLine(colors.warnLine(`没有匹配「${keyword}」的历史对话（按标题与首条消息模糊搜索）。`));
    return;
  }

  const items = sessions.map((s) => {
    const timeStr = new Date(s.updatedAt).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const msgCount = s.messages.filter((m) => m.role === "user").length;
    return {
      value: s.id,
      label: `[${timeStr}] ${s.title}`,
      description: `(${msgCount} 条消息)`,
    };
  });

  try {
    const selection = await ctx.readSelectionSafely({
      title: keyword
        ? `选择要恢复的历史对话（匹配「${keyword}」，共 ${sessions.length} 个）`
        : "选择要恢复的历史对话 (按最近时间排序)",
      items,
      selectedValue: sessionManager.getCurrentSession().id,
    });
    await loadAndRenderSession(ctx, selection.value);
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) {
      ui.writeLine(colors.gray("已取消会话切换。"));
      return;
    }
    throw error;
  }
}

/** 收集可作为回退节点的用户消息（斜杠命令不算对话节点）。 */
function collectUserMessageNodes(
  messages: ChatMessage[],
): Array<{ index: number; content: string }> {
  const nodes: Array<{ index: number; content: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("/")) {
      nodes.push({ index: i, content: m.content });
    }
  }
  return nodes;
}

/**
 * 回退到指定用户消息节点：回滚本会话拥有的代码改动、截断消息历史，
 * 并把该消息文本回填输入框等待重新编辑。/rewind（选定节点）与 /undo（一键）共用。
 */
async function rewindToNode(ctx: SessionCommandContext, targetMsgIndex: number): Promise<void> {
  const { ui, snapshotEngine, skillRegistry } = ctx;
  const messages = ctx.getMessages();
  const targetMsgNode = messages[targetMsgIndex];
  const targetContent = typeof targetMsgNode?.content === "string" ? targetMsgNode.content : "";

  if (!targetMsgNode?.snapshotId) {
    ui.writeLine(colors.warnLine("该历史节点没有安全代码快照，未执行任何回退。"));
    ui.writeLine(colors.gray("旧会话节点无法精确恢复工作区；请从升级后的新消息开始使用 /rewind。"));
    return;
  }

  const rollbackResult = snapshotEngine.rollbackOwnedChanges(targetMsgNode.snapshotId);
  if (!rollbackResult.ok) {
    ui.writeLine(colors.failLine("代码快照恢复失败，消息历史与工作区均未修改。"));
    ui.writeLine(colors.gray(rollbackResult.reason || "快照缺失，或当前 Git HEAD 已发生变化。"));
    return;
  }

  // 1. 截断消息历史（丢弃该节点之后的所有消息与回复）
  ctx.setMessages(messages.slice(0, targetMsgIndex));
  skillRegistry.restoreScopeFromMessages("main", ctx.getMessages());
  ctx.saveSession();
  ctx.updateStatusUI();

  // 2. 清理聊天重置界面提示
  ui.clearChat();
  const rollbackSummary =
    rollbackResult.revertedPaths.length > 0
      ? `，并撤销了本会话修改的 ${rollbackResult.revertedPaths.length} 个文件`
      : "；未改动工作区文件";
  ui.writeLine(colors.okLine(`已成功退回历史至节点 #${targetMsgIndex}${rollbackSummary}。`));
  if (rollbackResult.preservedPaths.length > 0) {
    ui.writeLine(
      colors.warnLine(
        `已保留 ${rollbackResult.preservedPaths.length} 个后来被外部修改的文件，避免覆盖你的改动。`,
      ),
    );
    ui.writeLine(colors.gray(rollbackResult.preservedPaths.join(", ")));
  }
  ui.writeLine(colors.gray("已将选中消息文本回填至底栏输入框，请修改后发送："));

  // 3. 将选中的用户消息文本回填回底栏输入框
  if (targetContent) {
    const userInput = await ui.readInput({
      slashCommands: ctx.getSlashCommands(),
      initialValue: targetContent,
    });
    if (!queueRewindRefill(ctx.pendingInputs, userInput)) return;
    // 交给下一轮统一处理，避免继续沿用旧的 /rewind 命令。
    ui.setQueue(ctx.pendingInputs);
  }
}

/** 分发 /undo 指令：一键撤销上一轮（最后一个用户消息节点）的代码与消息。 */
export async function handleUndoCommand(ctx: SessionCommandContext): Promise<void> {
  const nodes = collectUserMessageNodes(ctx.getMessages());
  if (nodes.length === 0) {
    ctx.ui.writeLine(colors.warnLine("当前会话中暂无可撤销的用户对话节点。"));
    return;
  }
  const target = nodes[nodes.length - 1];
  try {
    await rewindToNode(ctx, target.index);
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) {
      ctx.ui.writeLine(colors.gray("已取消 /undo 撤销操作。"));
      return;
    }
    throw error;
  }
}

/** 分发 /rewind 指令；调用方负责其后的主循环 continue。 */
export async function handleRewindCommand(ctx: SessionCommandContext): Promise<void> {
  const { ui } = ctx;
  const messages = ctx.getMessages();
  const userMessageNodes = collectUserMessageNodes(messages);

  if (userMessageNodes.length === 0) {
    ui.writeLine(colors.warnLine("当前会话中暂无合法的用户对话节点可供回退。"));
    return;
  }

  const items = [...userMessageNodes].reverse().map((node) => {
    const preview = node.content.length > 40 ? `${node.content.slice(0, 40)}...` : node.content;
    return {
      value: String(node.index),
      label: `#${node.index}: ${preview}`,
      description: node.content,
    };
  });

  try {
    const selection = await ctx.readSelectionSafely({
      title: "选择要退回的用户历史节点",
      items,
      selectedValue: items[0].value,
      secondary: {
        label: "确认退回并重置代码？",
        items: [
          { value: "yes", label: "Yes (确认回退消息与代码)" },
          { value: "no", label: "No (取消)" },
        ],
        selectedValue: REWIND_CONFIRM_DEFAULT,
      },
    });

    if (selection.secondaryValue !== "yes") {
      ui.writeLine(colors.gray("已取消 /rewind 退回操作。"));
      return;
    }

    await rewindToNode(ctx, parseInt(selection.value, 10));
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) {
      ui.writeLine(colors.gray("已取消 /rewind 退回操作。"));
      return;
    }
    throw error;
  }
}
