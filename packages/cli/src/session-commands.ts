/**
 * 会话相关命令族：/clear（新会话）、/resume（恢复历史会话并回显轨迹）、
 * /rewind（消息 + 代码快照回退，并把消息回填输入框）。
 *
 * 从 index.ts 主循环分发抽出；会话状态经 SessionCommandContext 注入。
 */
import fs from "node:fs";
import path from "node:path";
import {
  type AgentManager,
  type ChatMessage,
  isFailedToolOutput,
  readCompactedContext,
  type SessionManager,
  type SessionUsage,
  type SkillRegistry,
  type SnapshotEngine,
  stripExperienceRecall,
  type TaskStore,
} from "@hajicli/core";
import {
  DIFF_PREVIEW_LINES,
  formatReasoningBlock,
  formatToolCell,
  summarizeToolResult,
} from "./cli-runtime.js";
import { MarkdownStreamRenderer } from "./markdown-renderer.js";
import { FoldStatsCollector } from "./process-fold.js";
import { queueRewindRefill, REWIND_CONFIRM_DEFAULT } from "./rewind-flow.js";
import {
  type ChatSegmentPiece,
  type SlashCommand,
  TerminalInputCancelledError,
  type TerminalUI,
} from "./terminal-input.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { colors } from "./theme.js";
import {
  TOOL_BLOCK_OUTPUT_MAX_CHARS,
  type ToolBlockRenderInfo,
  type ToolBlockWrite,
} from "./tool-block-fold.js";
import { buildToolDisplay } from "./tool-display.js";
import { stripToolOutputEnvelope } from "./tool-output.js";

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
  /** 思维链是否常驻对话区（/think，缺省展开）。 */
  isThinkingVisible?(): boolean;
  saveSession(): void;
  updateStatusUI(): void;
  /**
   * 把会话用量（费用明细 / 压缩次数 / 上轮耗时）整体应用到侧栏：
   * /resume 用历史会话自己的记录，/clear 传 undefined 归零。
   */
  applySessionUsage(usage: SessionUsage | undefined): void;
  /**
   * 恢复其他 worktree 的会话时把整个进程切到那棵树（chdir + 重定向
   * 会话/任务/快照的存储目录 + 重新注入路径边界）。index.ts 提供。
   */
  enterSessionWorktree?(worktreeCwd: string): void;
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
  // 新会话从零开始：费用、压缩次数、上轮耗时都必须退回 0，否则侧栏还挂着上一个会话的数。
  ctx.applySessionUsage(undefined);
  ctx.setMessages([{ role: "system", content: ctx.getSystemPrompt() }]);
  ctx.refreshAgentVerificationContext(ctx.getMessages());
  ctx.saveSession();
  ctx.updateStatusUI();
  ui.clearChat();
  ui.writeLine(colors.okLine("已开启全新对话并重置上下文。"));
}

/** 压缩记录里的时间戳；与 /resume 选择器用同一套时间格式。 */
function formatCompactionStamp(iso: string): string {
  const time = new Date(iso);
  if (!Number.isFinite(time.getTime())) return "";
  return time.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 回放时的工具块渲染配方：口径对齐 ToolRunView.buildBlockInfo（edit/write 有 diff 预览时
 * 不留原始回执、其余工具剥回执外壳、bash 保尾），只是历史里没有耗时与参数展开行。
 */
function buildReplayBlockInfo(
  toolName: string,
  status: ToolBlockRenderInfo["status"],
  summary: string,
  resultText: string,
  outcome: { stats?: { added: number; removed: number }; preview?: string[] } | undefined,
  output: string | undefined,
): ToolBlockRenderInfo {
  const hideRawReceipt =
    (toolName === "edit" || toolName === "write") && (outcome?.preview?.length ?? 0) > 0;
  const fullOutput =
    hideRawReceipt || output === undefined
      ? undefined
      : stripToolOutputEnvelope(toolName, output.slice(0, TOOL_BLOCK_OUTPUT_MAX_CHARS));
  return {
    status,
    toolName,
    summary,
    resultText,
    stats: outcome?.stats,
    preview: outcome?.preview ? [...outcome.preview] : undefined,
    fullOutput: fullOutput || undefined,
    keep: toolName === "bash" ? "tail" : "head",
  };
}

/** 加载并回显一个历史会话；/resume 与启动参数 -c/-r 共用。 */
async function loadAndRenderSession(
  ctx: SessionCommandContext,
  sessionId: string,
): Promise<boolean> {
  const { ui, sessionManager, taskStore, snapshotEngine, agentManager, skillRegistry } = ctx;
  await sessionManager.flush();
  // 会话可能住在别的 worktree（并行会话各占一棵树）：按文件所在目录把进程切过去，
  // 任务计划、/rewind 快照与后续写盘才和会话待在同一棵树里。
  const storeDir = sessionManager.locateSessionDir(sessionId);
  if (!storeDir) {
    ui.writeLine(colors.warnLine("会话文件已不存在或无法读取。"));
    return false;
  }
  if (sessionManager.isArchivedSession(sessionId)) {
    // 原工作树已移除：会话复制回当前目录续写（loadSession 负责复制），归档副本不动。
    ui.writeLine(
      colors.gray(
        `已从归档取回会话（原工作树 ${path.basename(path.dirname(storeDir))}），在当前目录继续。`,
      ),
    );
  } else if (path.resolve(storeDir) !== path.resolve(sessionManager.getSessionsDir())) {
    const worktreeRoot = path.resolve(storeDir, "..", "..");
    if (ctx.enterSessionWorktree && fs.existsSync(path.join(worktreeRoot, ".git"))) {
      ctx.enterSessionWorktree(worktreeRoot);
      ui.writeLine(colors.gray(`已切换到会话所在的工作树：${worktreeRoot}`));
    }
  }
  const thinkingVisible = ctx.isThinkingVisible?.() !== false;
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
  // 侧栏恢复到被恢复会话自己的用量：费用、压缩次数、上轮耗时都跟着换，不留上一个会话的数。
  ctx.applySessionUsage(loaded.usage);
  ctx.saveSession();
  ctx.updateStatusUI();
  const pieces: ChatSegmentPiece[] = [];
  let plain = "";
  let group = "";
  // 工具块在当前缓冲（group / plain）里的字符区间，随缓冲一起封口成段。
  let plainBlocks: ToolBlockWrite[] = [];
  let groupBlocks: ToolBlockWrite[] = [];
  let groupOpen = false;
  let collector = new FoldStatsCollector();
  const flushPlain = () => {
    if (!plain) return;
    pieces.push({
      kind: "plain",
      raw: plain,
      ...(plainBlocks.length ? { blocks: plainBlocks } : {}),
    });
    plain = "";
    plainBlocks = [];
  };
  const openGroup = () => {
    if (groupOpen) return;
    flushPlain();
    groupOpen = true;
  };
  const sealGroup = () => {
    if (!groupOpen) return;
    pieces.push({
      kind: "fold",
      raw: group,
      stats: collector.snapshot(),
      ...(groupBlocks.length ? { blocks: groupBlocks } : {}),
    });
    group = "";
    groupBlocks = [];
    groupOpen = false;
    collector = new FoldStatsCollector();
  };
  // 没等到正文的过程段（回合结束 / 用户插话）：保持展开，直接并回普通内容。
  const abandonGroup = () => {
    if (!groupOpen) return;
    const offset = plain.length;
    for (const block of groupBlocks) {
      plainBlocks.push({ ...block, start: block.start + offset, end: block.end + offset });
    }
    plain += group;
    group = "";
    groupBlocks = [];
    groupOpen = false;
    collector = new FoldStatsCollector();
  };
  const appendHistoryLine = (value: string = "") => {
    if (groupOpen) group += `${value}\n`;
    else plain += `${value}\n`;
  };
  appendHistoryLine(
    colors.okLine(`已恢复会话：「${loaded.title}」 (${loaded.messages.length} 条上下文)`),
  );
  // 压缩记录：摘要与「压缩前完整记录」路径只写在 system 消息里，而下面的渲染会跳过
  // system；不显式回放的话，恢复后看起来就像历史莫名少了一截（压缩提示原本也只写终端缓冲）。
  const compactionSystemContent = loaded.messages.find(
    (message) => message.role === "system",
  )?.content;
  const compacted =
    typeof compactionSystemContent === "string"
      ? readCompactedContext(compactionSystemContent)
      : undefined;
  const compaction = loaded.usage?.lastCompaction;
  const compactionCount = loaded.usage?.compactionCount ?? 0;
  const transcriptPath = compaction?.transcriptPath ?? compacted?.transcriptPath;
  if (compacted || compaction || compactionCount > 0) {
    appendHistoryLine();
    const stamp = compaction ? formatCompactionStamp(compaction.at) : "";
    const countText = compactionCount > 0 ? `共 ${compactionCount} 次` : "";
    const detailText = [countText, stamp].filter(Boolean).join(" · ");
    appendHistoryLine(colors.okLine(`⟳ 上下文压缩完成${detailText ? `（${detailText}）` : ""}`));
    if (compaction && compaction.layers.length > 0) {
      appendHistoryLine(colors.gray(`  压缩层: ${compaction.layers.join(" -> ")}`));
    }
    if (compaction && compaction.beforeChars !== undefined && compaction.afterChars !== undefined) {
      const freed = Math.max(
        0,
        Math.round(
          ((compaction.beforeChars - compaction.afterChars) / Math.max(1, compaction.beforeChars)) *
            1000,
        ) / 10,
      );
      appendHistoryLine(
        colors.gray(
          `  字符占用: ${compaction.beforeChars.toLocaleString()} ➔ ${compaction.afterChars.toLocaleString()} (释放了 ${freed}% 空间)`,
        ),
      );
    }
    if (compaction) {
      appendHistoryLine(
        colors.gray(
          `  Token 估算: ${compaction.beforeTokens.toLocaleString()} ➔ ${compaction.afterTokens.toLocaleString()}`,
        ),
      );
    }
    if (compaction?.summaryMode === "fallback") {
      appendHistoryLine(
        colors.warnLine("  上次压缩使用的是本地降级摘要（模型摘要调用失败），完整记录仍已落盘。"),
      );
    }
    if (transcriptPath) {
      appendHistoryLine(
        colors.gray(`  压缩前完整记录：${transcriptPath}（可用 history 工具按「压缩前」检索）`),
      );
    }
    if (compacted?.summary) {
      appendHistoryLine();
      appendHistoryLine(colors.gray("压缩摘要（已并入系统提示词）："));
      const summaryRenderer = new MarkdownStreamRenderer(() => ui.getContentWidth());
      appendHistoryLine(summaryRenderer.render(compacted.summary, true));
    }
  }
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
      abandonGroup();
      appendHistoryLine();
      appendHistoryLine(colors.userMsg(sanitizeTerminalText(stripExperienceRecall(m.content))));
      appendHistoryLine();
    } else if (m.role === "assistant") {
      const hasToolCalls = Boolean(m.tool_calls && m.tool_calls.length > 0);
      if (m.reasoning_content && thinkingVisible) {
        // 思维链默认不折叠：整段推理写进正文，且不属于过程段（折叠时也不收起）。
        sealGroup();
        plain += formatReasoningBlock(m.reasoning_content, ui.getContentWidth());
      } else if (hasToolCalls && !m.content) {
        // 纯工具迭代：先开段，思考行与工具块都属于这一段。
        openGroup();
        if (m.reasoning_content) {
          appendHistoryLine(colors.gray(`深度思考 (${m.reasoning_content.length} 字)`));
          collector.addThinking();
        }
      } else if (m.reasoning_content) {
        // 有正文的迭代：思考行属于上一段过程（已开段时），随后正文把它封口。
        appendHistoryLine(colors.gray(`深度思考 (${m.reasoning_content.length} 字)`));
      }
      if (hasToolCalls && !m.content) {
        // 推理块 / 思考摘要与工具块之间留一个空行，对齐实时回合里工具块前的 writeBlankLine。
        if (m.reasoning_content) appendHistoryLine();
        openGroup();
      }
      if (m.content) {
        sealGroup();
        // 推理正文块与助手正文之间留一个空行，对齐实时回合。
        if (m.reasoning_content && thinkingVisible) appendHistoryLine();
        const mdRenderer = new MarkdownStreamRenderer(() => ui.getContentWidth());
        const rendered = mdRenderer.render(m.content, true);
        appendHistoryLine(rendered);
      }
      if (hasToolCalls && m.content) {
        // 同一条消息里既有正文又有工具调用：正文先写（封口前一段），
        // 与实时回合一致，正文和工具块之间留一个空行，再让工具块开新段。
        appendHistoryLine();
        openGroup();
      }
      if (hasToolCalls && m.tool_calls) {
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
                  undefined,
                  ui.getContentWidth(),
                );
          const status = outcome?.status ?? "failed";
          const summary = buildToolDisplay({ toolName: tc.function.name, args: argsObj }).title;
          const resultText = outcome?.text ?? "无执行结果";
          const start = groupOpen ? group.length : plain.length;
          for (const row of formatToolCell({
            status,
            toolName: tc.function.name,
            summary,
            width: ui.getContentWidth(),
            resultText,
            stats: outcome?.stats,
            preview: outcome?.preview,
            maxPreviewLines:
              tc.function.name === "edit" || tc.function.name === "write"
                ? DIFF_PREVIEW_LINES
                : undefined,
          })) {
            appendHistoryLine(row);
          }
          // 回放同样留一份渲染配方：恢复的会话里工具块也能点开/收起，与实时回合一致。
          const block: ToolBlockWrite = {
            start,
            end: groupOpen ? group.length : plain.length,
            info: buildReplayBlockInfo(
              tc.function.name,
              status,
              summary,
              resultText,
              outcome,
              output,
            ),
          };
          (groupOpen ? groupBlocks : plainBlocks).push(block);
          collector.addTool(tc.function.name, argsObj, outcome?.status ?? "failed");
        }
      }
      appendHistoryLine();
    }
  }
  abandonGroup();
  flushPlain();
  ui.replaceChatSegments(pieces);
  ui.dismissStartupHeader();
  return true;
}

/** 首屏按稳定 ID 恢复，标题相同的会话也不会串选。 */
export async function resumeSessionById(
  ctx: SessionCommandContext,
  sessionId: string,
): Promise<boolean> {
  return loadAndRenderSession(ctx, sessionId);
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

  const primaryStoreDir = path.resolve(sessionManager.getSessionsDir());
  const items = sessions.map((s) => {
    const timeStr = new Date(s.updatedAt).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const msgCount = s.messages.filter((m) => m.role === "user").length;
    // 跨工作树的会话标注所属树名，恢复时会切换过去。
    const storeDir = sessionManager.locateSessionDir(s.id);
    // 归档会话（工作树已移除）同样标出原树名，恢复时取回到当前目录继续。
    const worktreeTag =
      storeDir && path.resolve(storeDir) !== primaryStoreDir
        ? ` · ${sessionManager.isArchivedSession(s.id) ? "已归档 · " : ""}工作树 ${path.basename(path.dirname(path.dirname(storeDir)))}`
        : "";
    return {
      value: s.id,
      label: `[${timeStr}] ${s.title}`,
      description: `(${msgCount} 条消息${worktreeTag})`,
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
