/**
 * 驱动层（`haji mcp-serve`）的公共类型。
 *
 * 分层：index.ts 里的闭包持有全部运行时状态（provider / 工具 / 权限 / 会话），
 * 通过 `DriverHost` 把「跑一个回合 / 调整 / 查询 / 中止」暴露给 `DriverServer`；
 * `DriverServer` 只负责事件日志、选择请求代理与回合串行队列，不碰任何引擎内部。
 */
import type { PermissionMode, ReasoningEffort } from "@hajicli/core";

/** 驱动层事件：`seq` 单调递增，供客户端按 `sinceSeq` 增量拉取。 */
export interface DriverEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/** 需要授权时交给外部决策的选项（对应 TerminalUI.readSelection 的入参）。 */
export interface DriverSelectionItem {
  value: string;
  label: string;
  description?: string;
  hotkey?: string;
}

export interface DriverSelectionRequest {
  title: string;
  preview?: readonly string[];
  items: DriverSelectionItem[];
  selectedValue?: string;
  secondary?: {
    label: string;
    items: DriverSelectionItem[];
    selectedValue?: string;
  };
  /**
   * 无人决策时的取值（`ask` 超时、服务关闭）。授权类卡片必须给拒绝项：
   * 客户端没回复不等于同意。缺省时退回 selectedValue（仅限无副作用的普通选择）。
   */
  fallbackValue?: string;
  /** `--approval auto` 下直接采用的值；缺省时按 fallbackValue 处理（受保护目标、提级申请不自动放行）。 */
  autoValue?: string;
}

export interface DriverSelectionAnswer {
  value: string;
  secondaryValue?: string;
  /** 外部决策方随选择给出的说明（`haji_approve.reason`），驱动模式下恒有值（可能为空串）。 */
  reason?: string;
}

export interface DriverUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostCny: number;
}

export interface DriverTurnResult {
  ok: boolean;
  /** 本回合最后一条非空助手正文。 */
  text: string;
  sessionId: string;
  model: string;
  permissionMode: string;
  toolCalls: number;
  durationMs: number;
  usage?: DriverUsage;
  error?: string;
  /** 被 --max-cost / --max-turns 硬上限叫停时的原因。 */
  stopReason?: "max_cost" | "max_turns";
}

export interface DriverStatus {
  sessionId: string;
  sessionTitle: string;
  model: string;
  provider: string;
  effort: string;
  permissionMode: string;
  cwd: string;
  running: boolean;
  taskId?: string;
  messageCount: number;
  usage?: DriverUsage;
}

/** `haji_adjust` 的补丁：字段可缺省，只改给出的项，回合边界生效。 */
export interface DriverPatch {
  model?: string;
  effort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  thinkingVisible?: boolean;
  /** true 切到 plan 档，false 从 plan 退出到 default。 */
  plan?: boolean;
}

export interface DriverAdjustResult {
  applied: Record<string, unknown>;
  errors: string[];
}

/** index.ts 侧实现，供 DriverServer 调用。 */
export interface DriverHost {
  /** 跑一个完整回合；过程中通过 DriverServer.emit* 上报进度。 */
  runTurn(text: string, taskId: string): Promise<DriverTurnResult>;
  status(): DriverStatus;
  adjust(patch: DriverPatch): Promise<DriverAdjustResult>;
  cancel(): boolean;
  close(): Promise<void>;
}

/** `haji_send` 的返回：跑完给结果，没跑完给 taskId + 轮询提示。 */
export type DriverSendOutcome =
  | { status: "done"; taskId: string; result: DriverTurnResult; lastSeq: number }
  | { status: "running"; taskId: string; lastSeq: number; hint: string };
