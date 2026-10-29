import type { PermissionMode, ReasoningEffort } from "@hajicli/core";
import type { DriverServer } from "./server.js";
import type { DriverPatch } from "./types.js";

export const MCP_SERVER_NAME = "haji";

/** 支持协商的 MCP 协议版本；客户端请求的版本在列表内就原样回显。 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

const MAX_WAIT_MS = 600_000;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 工具面刻意保持小：每个工具只做一件事，参数少、描述短。
 * 外部 Agent 的模型会看到这些描述，措辞即使用说明。
 */
export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "haji_status",
    description:
      "查询 haji 当前状态：会话 id/标题、模型、思考强度、权限档、工作目录、是否正在跑回合、上下文消息数与本会话费用。每次调整前后都值得调用一次。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "haji_send",
    description:
      "把一条消息发给 haji 执行一个完整回合（读代码、改文件、跑命令）。最多等待 waitMs 毫秒：跑完直接返回最终正文与用量；没跑完返回 status=running 和 taskId，之后用 haji_wait / haji_events 跟进。同一时刻只有一个回合在跑，后续消息会排队。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "发给 haji 的消息正文。" },
        waitMs: {
          type: "number",
          description: "本次调用最多等待多少毫秒（默认 25000，上限 600000）。",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "haji_wait",
    description:
      "阻塞等待 haji 的下一个关键进度（工具执行结束、需要授权的选择请求、回合结束），或超时返回。比反复轮询 haji_events 更省调用。",
    inputSchema: {
      type: "object",
      properties: {
        sinceSeq: {
          type: "number",
          description: "从哪个事件序号之后开始等；省略表示从当前最新事件之后。",
        },
        timeoutMs: { type: "number", description: "最长等待毫秒数（默认 60000，上限 600000）。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "haji_events",
    description:
      "按 sinceSeq 增量拉取事件（transcript 正文增量、tool_start/tool_end、selection_request、turn_end 含最终正文、error）。返回的 lastSeq 用作下次调用的 sinceSeq。",
    inputSchema: {
      type: "object",
      properties: {
        sinceSeq: { type: "number", description: "只返回序号大于它的已发生事件，省略为 0。" },
        limit: { type: "number", description: "本次最多返回多少条（默认 200，上限 500）。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "haji_adjust",
    description:
      "调整 haji 的运行参数，下一个回合开始时生效。可改模型、思考强度、权限档、思维链显示、Plan 模式；只改传入的字段。",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "模型 id，例如 deepseek-chat。" },
        effort: {
          type: "string",
          description: "思考强度：low / medium / high / xhigh / max。",
        },
        permissionMode: {
          type: "string",
          description: "权限档：plan / default / accept-edit / auto / bypass-permissions。",
        },
        plan: {
          type: "boolean",
          description: "true 切到 plan 档（只读调研 + 计划），false 退出 plan 回到 default。",
        },
        thinkingVisible: { type: "boolean", description: "思维链是否常驻对话区。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "haji_cancel",
    description: "中止正在执行的回合（等价于用户按 Esc）。已产生的部分输出会保留。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "haji_approve",
    description:
      "回复一条 selection_request：按 requestId 提交选择。value 取该请求 items 里的某个 value；有 secondary 时一并给出 secondaryValue。超时未回复按默认选项处理。",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "selection_request 事件里的 requestId。" },
        value: { type: "string", description: "选项值（items[].value）。" },
        secondaryValue: { type: "string", description: "次级选项值（secondary.items[].value）。" },
      },
      required: ["requestId", "value"],
      additionalProperties: false,
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function textResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * 处理单条 JSON-RPC 消息。通知类消息返回 undefined（不回包）。
 * 纯编排：所有状态都在 DriverServer 里，便于用假 host 单测。
 */
export async function handleMessage(
  server: DriverServer,
  message: unknown,
): Promise<JsonRpcResponse | undefined> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
  const request = message as JsonRpcRequest;
  const id = request.id ?? null;

  if (typeof request.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  }

  switch (request.method) {
    case "initialize": {
      const requested = (request.params?.protocolVersion as string | undefined) ?? "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
          instructions:
            "haji 是一个终端 AI 编程助手。用 haji_send 派活，用 haji_wait / haji_events 跟进进度，用 haji_adjust 改模型与权限档，需要授权时用 haji_approve 回复。",
        },
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } };
    case "tools/call":
      return { jsonrpc: "2.0", id, result: await callTool(server, request.params) };
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }
}

async function callTool(
  server: DriverServer,
  params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};

  try {
    switch (name) {
      case "haji_status": {
        return textResult({
          ...server.status(),
          running: server.running,
          pendingSelections: server.pendingSelectionIds(),
          lastSeq: server.lastSeq,
          queuedTurns: server.pendingCount,
        });
      }
      case "haji_send": {
        const text = typeof args.text === "string" ? args.text : "";
        if (!text.trim()) return textResult({ error: "text 不能为空" }, true);
        const waitMs = clamp(args.waitMs, server.defaultWaitMs, 100, MAX_WAIT_MS);
        return textResult(await server.send(text, waitMs));
      }
      case "haji_wait": {
        const sinceSeq =
          typeof args.sinceSeq === "number" && Number.isFinite(args.sinceSeq)
            ? Math.floor(args.sinceSeq)
            : server.lastSeq;
        const timeoutMs = clamp(args.timeoutMs, 60_000, 100, MAX_WAIT_MS);
        return textResult(await server.wait(sinceSeq, timeoutMs));
      }
      case "haji_events": {
        const sinceSeq =
          typeof args.sinceSeq === "number" && Number.isFinite(args.sinceSeq)
            ? Math.floor(args.sinceSeq)
            : 0;
        const limit = clamp(args.limit, 200, 1, 500);
        return textResult(server.history(sinceSeq, limit));
      }
      case "haji_adjust": {
        const patch = buildPatch(args);
        if (patch.errors.length > 0) return textResult(patch, true);
        return textResult(await server.adjust(patch.patch));
      }
      case "haji_cancel": {
        return textResult({ cancelled: server.cancel() });
      }
      case "haji_approve": {
        const requestId = typeof args.requestId === "string" ? args.requestId : "";
        const value = typeof args.value === "string" ? args.value : "";
        if (!requestId || !value) return textResult({ error: "requestId 与 value 必填" }, true);
        const secondaryValue =
          typeof args.secondaryValue === "string" ? args.secondaryValue : undefined;
        const accepted = server.answerSelection(requestId, value, secondaryValue);
        return textResult({
          accepted,
          requestId,
          ...(accepted ? {} : { error: "请求不存在或已超时" }),
        });
      }
      default:
        return textResult({ error: `未知工具：${name || "(空)"}` }, true);
    }
  } catch (error) {
    return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

/** 校验并归一化 `haji_adjust` 的参数；非法值收集到 errors 里，不做部分生效。 */
export function buildPatch(args: Record<string, unknown>): {
  patch: DriverPatch;
  errors: string[];
} {
  const patch: DriverPatch = {};
  const errors: string[] = [];

  if (args.model !== undefined) {
    if (typeof args.model !== "string" || !args.model.trim()) errors.push("model 必须是非空字符串");
    else patch.model = args.model.trim();
  }
  if (args.effort !== undefined) {
    const value = String(args.effort);
    if (!isEffort(value)) errors.push(`无效思考强度：${value}（可选 low/medium/high/xhigh/max）`);
    else patch.effort = value;
  }
  if (args.permissionMode !== undefined) {
    const value = String(args.permissionMode);
    if (!isPermissionMode(value)) {
      errors.push(`无效权限档：${value}（可选 plan/default/accept-edit/auto/bypass-permissions）`);
    } else patch.permissionMode = value;
  }
  if (args.plan !== undefined) {
    if (typeof args.plan !== "boolean") errors.push("plan 必须是布尔值");
    else patch.plan = args.plan;
  }
  if (args.thinkingVisible !== undefined) {
    if (typeof args.thinkingVisible !== "boolean") errors.push("thinkingVisible 必须是布尔值");
    else patch.thinkingVisible = args.thinkingVisible;
  }

  return { patch, errors };
}

const EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
function isEffort(value: string): value is ReasoningEffort {
  return (EFFORTS as string[]).includes(value);
}

const PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "default",
  "accept-edit",
  "auto",
  "bypass-permissions",
];
function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as string[]).includes(value);
}
