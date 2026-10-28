import { ActivityIndicator, ToolRunView } from "../../dist/activity-indicator.js";
import { runAgentTurn } from "../../dist/turn-runner.js";

/** 故障注入使用真实回合与 SessionManager，只替换终端和外部工具。 */
export function recoveryHarness(
  manager,
  provider,
  execute = async () => ({ output: "ok", duration: 1 }),
) {
  let messages = [...manager.getCurrentSession().messages];
  const chat = [];
  const ui = {
    isInteractive: () => false,
    getContentWidth: () => 80,
    getChatLength: () => chat.length,
    writeLine: (line = "") => chat.push(line),
    writeBlankLine: () => chat.push(""),
    updateChatFrom: (offset, text) => {
      chat.length = offset;
      if (text) chat.push(text);
    },
    markStableChatPrefix() {},
    writeToolCells: (text) => chat.push(text),
    setLiveTail() {},
    beginFoldGroup: () => ({ epoch: 0, start: chat.length }),
    sealFoldGroup: () => 0,
    setStatus() {},
    setQueue() {},
    cancelInput: () => "",
    onEsc() {},
  };
  const tool = { name: "bash", definition: { name: "bash" } };
  const deps = {
    ui,
    activityIndicator: new ActivityIndicator({ render() {} }),
    toolRunView: new ToolRunView({ render() {}, getWidth: () => 80 }),
    tracker: { recordUserInput() {}, recordToolBatch() {} },
    sessionManager: manager,
    skillRegistry: { restoreScopeFromMessages() {} },
    snapshotEngine: { createAnchor: () => "test-anchor" },
    hookEngine: { trigger: async () => {} },
    agentManager: { list: () => [] },
    toolExecutor: { execute },
    toolsMap: new Map([[tool.name, tool]]),
    activeTools: () => [tool],
    getProvider: () => provider,
    getSelectedModel: () => "test-model",
    getReasoningEffort: () => "medium",
    getPermissionMode: () => "auto",
    getRiskThreshold: () => "low",
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
    setLastUserMessageForRecall() {},
    setForegroundAbortSignal() {},
    setLastToolBatchOutputs() {},
    isPlanReadyForReview: () => false,
    setPlanReadyForReview() {},
    isPlanReviewSummaryRequested: () => false,
    setPlanReviewSummaryRequested() {},
    deferredInputDrafts: [],
    pendingInputs: [],
    updateStatusUI() {},
    applyPermissionMode: async () => {},
    readSelectionSafely: async () => ({ value: "auto" }),
    showRuntimeWarning() {},
    refreshAgentVerificationContext: () => false,
    startBackgroundInput() {},
  };
  // 标题请求与本测试的前台网络故障无关。
  manager.generateTitleAsync = async () => {};
  return {
    chat,
    deps,
    messages: () => messages,
    run: (prompt = "继续工作") =>
      runAgentTurn(deps, {
        forwardedPrompt: prompt,
        commandInput: prompt,
        promptDisplayStartOffset: chat.length,
      }),
  };
}

export const recoveryCalls = ["first", "second"].map((id) => ({
  id,
  type: "function",
  function: { name: "bash", arguments: JSON.stringify({ command: id }) },
}));
