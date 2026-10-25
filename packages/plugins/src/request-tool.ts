import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";

/**
 * `request`：Agent 的「申请」通道。
 *
 * 边界只能由用户改，Agent 只能申请。工具本身不做任何变更：它把请求交给
 * CLI 侧弹一张单次卡片，用户批准后再调用与斜杠命令完全相同的落盘函数
 * （`/workspace add` → `addWorkspaceRoot` + `syncPathScope`）。
 *
 * 三条硬约束：
 * - 一次只申请**一个具体目标**，不接受 `*` / `all` / 根目录 / 磁盘根；
 * - 权限档只能申请 `accept-edit` 或 `auto`，永远不能申请 `bypass-permissions`，
 *   也不能把申请变成永久配置；
 * - 被拒绝后本次会话不再为同一目标弹卡，避免模型换参数反复骚扰。
 */

export const REQUEST_ACTIONS = ["workspace.add", "permission.mode"] as const;
export type RequestAction = (typeof REQUEST_ACTIONS)[number];

/** 允许申请的权限档：不包含 plan（走计划审批）与 bypass（等于免确认）。 */
export const ESCALATABLE_MODES = ["accept-edit", "auto"] as const;
export type EscalatableMode = (typeof ESCALATABLE_MODES)[number];

export interface RequestSpec {
  action: RequestAction;
  target: string;
  reason: string;
  /** 由工具从执行上下文补上，用于卡片区分主 Agent 与子代理。 */
  agentId?: string;
}

export interface RequestDecision {
  approved: boolean;
  /** 批准后的生效说明，或拒绝原因；会原样回传给模型。 */
  detail?: string;
}

export interface RequestToolOptions {
  approve: (spec: RequestSpec) => Promise<RequestDecision>;
}

const MAX_REASON_CHARS = 200;
const MAX_REMEMBERED_DENIALS = 20;

function looksLikeRootPath(target: string): boolean {
  return (
    target === "/" ||
    target === "\\" ||
    target === "~" ||
    /^[a-zA-Z]:[\\/]?$/.test(target) ||
    target === "."
  );
}

/** 解析并校验入参；导出以便单测直接覆盖拒绝分支。 */
export function parseRequestArgs(
  args: Record<string, unknown>,
): { ok: true; spec: RequestSpec } | { ok: false; error: string } {
  const action = String(args.action ?? "").trim();
  if (!(REQUEST_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: `action 必须是 ${REQUEST_ACTIONS.join(" 或 ")}。` };
  }
  const target = String(args.target ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!target) return { ok: false, error: "target 不能为空：必须给出一个具体目标。" };
  if (/[*?]/.test(target)) {
    return { ok: false, error: "target 不能包含通配符：一次只能申请一个具体目标。" };
  }
  const reason = String(args.reason ?? "").trim();
  if (!reason) return { ok: false, error: "reason 不能为空：需要说明为什么现在必须这么做。" };
  if (reason.length > MAX_REASON_CHARS) {
    return { ok: false, error: `reason 最多 ${MAX_REASON_CHARS} 个字符。` };
  }

  if (action === "permission.mode") {
    if (!(ESCALATABLE_MODES as readonly string[]).includes(target)) {
      return {
        ok: false,
        error: `权限档只能申请 ${ESCALATABLE_MODES.join(" 或 ")}；plan 走计划审批，bypass-permissions 等于免确认，不能申请。`,
      };
    }
    return { ok: true, spec: { action, target, reason } };
  }

  if (looksLikeRootPath(target)) {
    return {
      ok: false,
      error: "不能把根目录、家目录或整个磁盘加入工作区；请给出具体项目目录。",
    };
  }
  return { ok: true, spec: { action: "workspace.add", target, reason } };
}

export class RequestTool implements BaseTool {
  public readonly name = "request";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "request",
      description:
        "向用户发起一次受控申请（一次只申请一个具体目标）。workspace.add：把某个目录加入工作区根；permission.mode：把权限档临时提到 accept-edit 或 auto。工具本身不改变任何状态，必须等用户批准。仅在任务确实被边界挡住时使用；被拒绝后不要换参数重复申请。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [...REQUEST_ACTIONS],
            description: "workspace.add=加入工作区根；permission.mode=临时提级权限档。",
          },
          target: {
            type: "string",
            description:
              "具体目标：workspace.add 填目录（可写 ~ 或绝对路径）；permission.mode 填 accept-edit 或 auto。",
          },
          reason: {
            type: "string",
            description: `为什么现在需要这次申请（最多 ${MAX_REASON_CHARS} 字）。会显示在授权卡上。`,
          },
        },
        required: ["action", "target", "reason"],
        additionalProperties: false,
      },
    },
  };

  /** 本次会话内已被拒绝的申请：同一目标不再弹卡。 */
  private readonly denied = new Set<string>();

  public constructor(private readonly options: RequestToolOptions) {}

  /** 申请只改动配置或会话状态，不触碰工作区文件，因此不参与快照。 */
  public getMutationScope(): "none" {
    return "none";
  }

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const parsed = parseRequestArgs(args);
    if (!parsed.ok) return `错误: ${parsed.error}`;
    const spec: RequestSpec = context?.agentId
      ? { ...parsed.spec, agentId: context.agentId }
      : parsed.spec;
    const key = `${spec.action}:${spec.target}`;

    if (this.denied.has(key)) {
      return `已拒绝: 用户此前拒绝过同一申请（${key}），本次会话不再重复弹卡。不要换参数或换写法重复申请；改用范围更小的目标，或向用户说明阻塞点。`;
    }

    const decision = await this.options.approve(spec);
    if (!decision.approved) {
      this.rememberDenial(key);
      const detail = decision.detail?.trim() || "用户没有批准该申请。";
      return `已拒绝: ${detail} 不要换参数或换写法重复申请同一目标。`;
    }
    return decision.detail?.trim() || `已批准：${key}。`;
  }

  private rememberDenial(key: string): void {
    this.denied.add(key);
    if (this.denied.size <= MAX_REMEMBERED_DENIALS) return;
    const oldest = this.denied.values().next().value;
    if (oldest) this.denied.delete(oldest);
  }
}
