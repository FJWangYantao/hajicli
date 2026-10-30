/**
 * 「事件唤醒」契约：让巡检不必等到下一个轮询周期才发现状态变了。
 *
 * 分工（重要）：**轮询始终是对账来源**，唤醒只负责把延迟从「一个轮询间隔」压到「秒级」。
 * webhook 会丢、会乱序、会在进程重启期间到达，所以 `runLoop` 收不到事件时照常按退避复查；
 * 唤醒源故障也必须退化成纯轮询，不能变成「不唤醒就不干活」。
 *
 * 通道形态：GitHub → 中继（smee.io / 自建 Worker）→ 本地进程**出站**订阅 SSE。
 * 本地不需要公网入站，这正是选它而不是直接暴露 HTTP 端口的原因。
 */

export interface PatrolWakeEvent {
  /** `x-github-event`：pull_request / check_suite / … */
  event: string;
  /** payload 顶层 `action`：opened / synchronize / completed / submitted … */
  action?: string;
  /** `x-github-delivery`：同一次投递重投时不变，可作幂等键。 */
  deliveryId?: string;
  /** `owner/name`。 */
  repo?: string;
  /** 事件对应的 PR 编号（能从 payload 推出来时）。 */
  prNumber?: number;
  /** 本地收到的时刻（ISO）。 */
  receivedAt: string;
}

export interface PatrolWakeSource {
  /** 通道地址，仅用于日志。 */
  readonly url: string;
  /** 等下一条**相关**事件；超时 / 中止 / 通道关闭时返回 null。 */
  wait(signal: AbortSignal, timeoutMs: number): Promise<PatrolWakeEvent | null>;
  close(): void;
}

/**
 * 会改变巡检结论的事件白名单。
 * 其余事件（star / push / release…）即使推过来也不唤醒，避免把 GitHub API 打爆。
 */
export const PATROL_WAKE_EVENTS = [
  "pull_request",
  "pull_request_review",
  "check_suite",
  "workflow_run",
  "issue_comment",
] as const;

export function isPatrolWakeEventName(event: string): boolean {
  return (PATROL_WAKE_EVENTS as readonly string[]).includes(event);
}

/**
 * 解析中继 SSE 的 `data:` 载荷。
 *
 * 两种信封都认：
 * - smee.io 把 header **平铺在顶层**：`{query, body, "x-github-event": …}`；
 * - 也有中继包成 `{headers, body}`。
 * 事件类型不在白名单里时返回 undefined（等于「这次唤醒与我无关」）。
 */
export function parseWakePayload(
  raw: string,
  receivedAt: string = new Date().toISOString(),
): PatrolWakeEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const headers = isRecord(parsed.headers) ? parsed.headers : parsed;
  const body = isRecord(parsed.body) ? parsed.body : parsed;
  const event = readHeader(headers, "x-github-event");
  if (!event || !isPatrolWakeEventName(event)) return undefined;
  const deliveryId = readHeader(headers, "x-github-delivery");
  const action = typeof body.action === "string" ? body.action : undefined;
  const repo =
    isRecord(body.repository) && typeof body.repository.full_name === "string"
      ? body.repository.full_name
      : undefined;
  const prNumber = prNumberOf(body);
  return {
    event,
    ...(action ? { action } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(repo ? { repo } : {}),
    ...(prNumber === undefined ? {} : { prNumber }),
    receivedAt,
  };
}

/** PR 编号在各类 payload 里位置不同：PR 事件、issue 评论、check suite、workflow run。 */
function prNumberOf(body: Record<string, unknown>): number | undefined {
  const candidates = [
    isRecord(body.pull_request) ? body.pull_request.number : undefined,
    isRecord(body.issue) ? body.issue.number : undefined,
    body.number,
    firstPullRequestNumber(body.check_suite),
    firstPullRequestNumber(body.workflow_run),
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

function firstPullRequestNumber(value: unknown): number | undefined {
  if (!isRecord(value) || !Array.isArray(value.pull_requests)) return undefined;
  const first: unknown = value.pull_requests[0];
  return isRecord(first) && typeof first.number === "number" ? first.number : undefined;
}

/** header 名大小写不敏感：中继透传时可能已被小写化。 */
function readHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string" && direct) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string" && value) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
