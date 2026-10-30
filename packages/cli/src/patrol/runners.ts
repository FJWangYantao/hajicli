/**
 * 巡检 runner：结构化输出的构造 / 解析 / 校验 + 无头进程实现。
 *
 * 约定 runner（review / fix / adjudicate）在最终回复中输出一个带标签的
 * fenced JSON 块；解析失败一律降级为「无法判定 / 失败」，绝不把非法输出
 * 当成通过。findingId 缺省时按 location+summary 哈希生成，保证跨轮次稳定。
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { PatrolFinding, PatrolJob } from "@hajicli/core";
import type {
  AdjudicationRunnerInput,
  AdjudicationRunnerOutput,
  FixRunnerInput,
  FixRunnerOutput,
  PatrolRunners,
  RawFinding,
  ReviewRunnerInput,
  ReviewRunnerOutput,
} from "./types.js";

const execFileAsync = promisify(execFile);

export const PATROL_REVIEW_TAG = "patrol-review";
export const PATROL_FIX_TAG = "patrol-fix";
export const PATROL_ADJUDICATION_TAG = "patrol-adjudication";

/** 从模型回复中提取带标签的 fenced JSON 块；找不到再尝试整段 JSON 对象。 */
export function extractTaggedJson(text: string, tag: string): unknown {
  const fence = "```";
  const fenced = new RegExp(`${fence}${tag}\\s*\\n([\\s\\S]*?)\\n${fence}`, "i").exec(text);
  const candidates = fenced ? [fenced[1]] : [text];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {}
  }
  return null;
}

/** 稳定 findingId：同一 PR 内 location+summary 相同即同 ID。 */
export function stableFindingId(jobId: string, raw: RawFinding): string {
  if (raw.findingId && /^[A-Za-z0-9_-]+$/.test(raw.findingId)) return raw.findingId;
  const digest = crypto
    .createHash("sha256")
    .update(`${jobId}|${raw.location ?? ""}|${raw.summary}`)
    .digest("hex")
    .slice(0, 10);
  return `f-${digest}`;
}

/** 解析审查输出；任何结构性问题都降级为 inconclusive，不允许伪装通过。 */
export function parseReviewOutput(text: string): ReviewRunnerOutput {
  const parsed = extractTaggedJson(text, PATROL_REVIEW_TAG) as {
    verdict?: unknown;
    findings?: unknown;
    summary?: unknown;
  } | null;
  if (!parsed || typeof parsed !== "object") {
    return { verdict: "inconclusive", findings: [], summary: "审查输出无法解析为结构化 JSON" };
  }
  const verdict = parsed.verdict;
  if (
    !Array.isArray(parsed.findings) ||
    !parsed.findings.every(isRawFinding) ||
    (parsed.summary !== undefined && typeof parsed.summary !== "string")
  ) {
    return { verdict: "inconclusive", findings: [], summary: "审查输出不符合 schema" };
  }
  const normalized = parsed.findings;
  if (verdict === "pass") {
    // 「通过」却报告阻塞问题：自相矛盾，按需修改处理。
    if (normalized.some((f) => (f.severity ?? "blocking") === "blocking")) {
      return {
        verdict: "changes_required",
        findings: normalized,
        summary: String(parsed.summary ?? "审查结论自相矛盾（pass 但存在阻塞问题），按需修改处理"),
      };
    }
    return { verdict: "pass", findings: normalized, summary: String(parsed.summary ?? "") };
  }
  if (verdict === "changes_required") {
    if (normalized.length === 0) {
      return {
        verdict: "inconclusive",
        findings: [],
        summary: "changes_required 但没有给出问题清单",
      };
    }
    return {
      verdict: "changes_required",
      findings: normalized,
      summary: String(parsed.summary ?? ""),
    };
  }
  if (verdict === "inconclusive") {
    return { verdict: "inconclusive", findings: [], summary: String(parsed.summary ?? "") };
  }
  return { verdict: "inconclusive", findings: [], summary: `未知审查结论: ${String(verdict)}` };
}

/** 解析修复输出；非法结构按 failed 处理。 */
export function parseFixOutput(text: string): FixRunnerOutput {
  const parsed = extractTaggedJson(text, PATROL_FIX_TAG) as {
    status?: unknown;
    summary?: unknown;
    pushedHeadSha?: unknown;
    disputeReason?: unknown;
  } | null;
  if (!parsed || typeof parsed !== "object") {
    return { status: "failed", summary: "修复输出无法解析为结构化 JSON" };
  }
  const status = parsed.status;
  if (status === "pushed" || status === "disputed" || status === "failed") {
    return {
      status,
      summary: String(parsed.summary ?? ""),
      pushedHeadSha: typeof parsed.pushedHeadSha === "string" ? parsed.pushedHeadSha : undefined,
      disputeReason: typeof parsed.disputeReason === "string" ? parsed.disputeReason : undefined,
    };
  }
  return { status: "failed", summary: `未知修复状态: ${String(status)}` };
}

/** 解析裁决输出；非法结构返回 null，由调用方按「裁决失败」处理（重试或终止）。 */
export function parseAdjudicationOutput(text: string): AdjudicationRunnerOutput | null {
  const parsed = extractTaggedJson(text, PATROL_ADJUDICATION_TAG) as {
    verdict?: unknown;
    reasons?: unknown;
    rejectedFindingIds?: unknown;
    orders?: unknown;
    acceptance?: unknown;
    summary?: unknown;
  } | null;
  if (!parsed || typeof parsed !== "object") return null;
  const verdict = parsed.verdict;
  if (
    verdict !== "overrule" &&
    verdict !== "remediate" &&
    verdict !== "redo" &&
    verdict !== "descope" &&
    verdict !== "terminate"
  ) {
    return null;
  }
  const stringList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    verdict,
    reasons: stringList(parsed.reasons),
    rejectedFindingIds: stringList(parsed.rejectedFindingIds),
    orders: stringList(parsed.orders),
    acceptance: stringList(parsed.acceptance),
    summary: String(parsed.summary ?? ""),
  };
}

function isRawFinding(value: unknown): value is RawFinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RawFinding>;
  return (
    !Array.isArray(value) &&
    typeof candidate.summary === "string" &&
    candidate.summary.trim().length > 0 &&
    (candidate.severity === undefined ||
      candidate.severity === "blocking" ||
      candidate.severity === "nonblocking") &&
    [candidate.findingId, candidate.location, candidate.evidence, candidate.requiredFix].every(
      (field) => field === undefined || typeof field === "string",
    )
  );
}

// ---- 提示词构造 ---------------------------------------------------------

function findingsBlock(findings: PatrolFinding[]): string {
  if (findings.length === 0) return "（无）";
  return findings
    .map((finding) =>
      [
        `- ID: ${finding.findingId} [${finding.severity}]${finding.state !== "open" ? `（${finding.state}）` : ""}`,
        finding.location ? `  位置: ${finding.location}` : "",
        `  问题: ${finding.summary}`,
        `  依据: ${finding.evidence}`,
        finding.requiredFix ? `  验收: ${finding.requiredFix}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

export function buildReviewPrompt(input: ReviewRunnerInput): string {
  const { job } = input;
  return [
    `你是 PR Patrol 的独立审查 agent。审查以下 PR，不要修改任何文件。`,
    ``,
    `仓库: ${job.repo}  PR #${job.prNumber}（${job.branch} → ${job.targetBranch}）`,
    `原始任务: ${job.taskBrief}`,
    `验收条件:\n${job.acceptance.map((item) => `- ${item}`).join("\n") || "-（未提供）"}`,
    `允许修改范围: ${job.scope.join(", ") || "未限定"}`,
    ``,
    `## Diff`,
    "```diff",
    input.diff.slice(0, 200_000),
    "```",
    ``,
    `## 历史问题（必须逐条复核；仍未解决的要重新报告）`,
    findingsBlock(input.priorFindings),
    ``,
    `审查要求：完成度（是否达成原始任务、是否越界）、正确性（边界与错误路径）、`,
    `兼容性、并发/权限/资源风险、测试是否真的证明了预期行为。`,
    `风格偏好与非阻塞建议标记为 nonblocking。`,
    `环境约束（无头模式，务必遵守）：bash 已按命令前缀放行 git / node / npm；每条命令必须单独执行，禁止用 && 或 ; 串联多条命令，否则授权无法匹配会被拒绝；需要换目录时用工具的工作目录参数而不是 cd。`,
    ``,
    `最终回复必须包含如下 JSON 块（verdict 只能是 pass / changes_required / inconclusive）：`,
    `\`\`\`${PATROL_REVIEW_TAG}`,
    `{"verdict":"pass|changes_required|inconclusive","summary":"一句话结论","findings":[{"findingId":"稳定ID","severity":"blocking|nonblocking","location":"文件/符号","summary":"问题","evidence":"依据","requiredFix":"验收条件"}]}`,
    "```",
  ].join("\n");
}

export function buildFixPrompt(input: FixRunnerInput): string {
  const { job } = input;
  return [
    `你是 PR #${job.prNumber} 的执行 agent，在当前工作区修复审查问题并提交（git commit，不要 push）。`,
    `原始任务: ${job.taskBrief}`,
    `允许修改范围: ${job.scope.join(", ") || "未限定"}；不要改动范围外文件。`,
    input.orders.length > 0
      ? `\n## 最终裁决指令（必须遵守）\n${input.orders.map((o) => `- ${o}`).join("\n")}`
      : "",
    ``,
    `## 待修复的阻塞问题`,
    findingsBlock(input.findings),
    ``,
    `要求：修复后运行能证明行为的验证（构建/测试），并在 summary 里给出实际验证结果。`,
    `环境约束（无头模式，务必遵守）：bash 已按命令前缀放行 git / node / npm；每条命令必须单独执行，禁止用 && 或 ; 串联多条命令，否则授权无法匹配会被拒绝；需要换目录时用工具的工作目录参数而不是 cd。`,
    `如果你有充分证据认为某个问题不成立，选择 disputed 并给出 disputeReason 与证据。`,
    `特别注意：若逐条核对后发现所有阻塞问题在当前 HEAD 已经全部解决（无需任何改动、git diff 为空），`,
    `status 必须选 disputed 并逐条给出已解决的证据，绝不要选 failed。`,
    ``,
    `最终回复必须包含如下 JSON 块（status 只能是 pushed / disputed / failed）：`,
    `\`\`\`${PATROL_FIX_TAG}`,
    `{"status":"pushed|disputed|failed","summary":"做了什么、验证结果","pushedHeadSha":"新提交 SHA（pushed 时）","disputeReason":"异议理由与证据（disputed 时）"}`,
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAdjudicationPrompt(input: AdjudicationRunnerInput): string {
  const { job } = input;
  return [
    `你是 PR Patrol 的最终裁决 agent。执行 agent 与审查 agent 存在争议，你必须独立取证后裁决。`,
    `你可以读取仓库与运行验证，但不要修改文件、不要 push。`,
    ``,
    `仓库: ${job.repo}  PR #${job.prNumber}（当前 head ${job.version.headSha.slice(0, 10)}）`,
    `原始任务: ${job.taskBrief}`,
    `验收条件:\n${job.acceptance.map((item) => `- ${item}`).join("\n") || "-（未提供）"}`,
    `引发争议的结论: ${input.contestedDecisionId}`,
    input.disputeReason ? `执行 agent 的异议: ${input.disputeReason}` : "",
    ``,
    `## 争议涉及的问题`,
    findingsBlock(input.findings),
    ``,
    `裁决规则：每个争议问题必须先在当前 head 上独立取证再裁决——代码里逐条验证问题是否仍然成立，`,
    `必要时运行测试；若问题在当前提交已解决或本就不成立，verdict 选 overrule 并把对应 findingId 列入 rejectedFindingIds，`,
    `不要仅因审查结论存在就 remediate。未改变相关代码且无新证据的旧争议不得翻案。`,
    `裁决指令（verdict）：overrule=问题不成立放行；remediate=维持问题并给出必须修复的指令；`,
    `redo=当前方案不可行需要重做；descope=缩减非必要实现；terminate=任务不可行或预算耗尽应终止。`,
    ``,
    `最终回复必须包含如下 JSON 块：`,
    `\`\`\`${PATROL_ADJUDICATION_TAG}`,
    `{"verdict":"overrule|remediate|redo|descope|terminate","reasons":["依据"],"rejectedFindingIds":["被驳回的 findingId"],"orders":["修复指令（remediate/redo/descope 时）"],"acceptance":["验收条件"],"summary":"裁决摘要"}`,
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- 无头进程实现 -------------------------------------------------------

export interface HeadlessRunnersOptions {
  /** 本地主仓库目录（git worktree 的挂载点）。 */
  repoDir: string;
  /** 工作区根目录，默认 <repoDir>/.haji/patrol/work。 */
  workRoot?: string;
  /** haji 可执行命令，默认 "haji"。 */
  hajiCommand?: string;
  /** 可执行命令的前置参数（如通过 node 运行 CLI 脚本）。 */
  hajiCommandArgs?: string[];
  /** 传给无头进程的额外参数（如 --model）。 */
  hajiArgs?: string[];
  /** 无头进程权限档，默认 accept-edit（修复需要写文件）。 */
  permissionMode?: string;
  /** 无头进程放行的 bash 命令前缀，默认 git / node / npm（修复需跑测试与提交）。 */
  allowCommands?: string[];
  runTimeoutMs?: number;
}

interface HeadlessRunResult {
  text: string;
}

/**
 * 生产 runner：每个 run 起一个无头 haji 进程。
 * - 审查 / 裁决在 detached worktree（只读语义靠提示词与权限档约束）；
 * - 修复在绑定 PR 分支的 worktree，结束后由 runner 校验新提交并 push。
 */
export function createHeadlessRunners(options: HeadlessRunnersOptions): PatrolRunners {
  const workRoot = options.workRoot ?? path.join(options.repoDir, ".haji", "patrol", "work");
  const hajiCommand = options.hajiCommand ?? "haji";
  const extraArgs = options.hajiArgs ?? [];
  const permissionMode = options.permissionMode ?? "accept-edit";
  const allowCommands = options.allowCommands ?? ["bash:git", "bash:node", "bash:npm"];
  const allowArgs = allowCommands.flatMap((command) => ["--allow", command]);

  const runHeadless = async (cwd: string, prompt: string): Promise<HeadlessRunResult> => {
    let stdout = "";
    try {
      const executed = await execFileAsync(
        hajiCommand,
        [
          ...(options.hajiCommandArgs ?? []),
          "-p",
          prompt,
          "--output-format",
          "json",
          "--permission-mode",
          permissionMode,
          ...allowArgs,
          ...extraArgs,
        ],
        { cwd, timeout: options.runTimeoutMs ?? 30 * 60_000, maxBuffer: 32 * 1024 * 1024 },
      );
      stdout = executed.stdout;
    } catch (error) {
      // 无头进程的 stderr / stdout 尾部是排查模型失败与授权拦截的唯一线索，必须带上。
      const detail = error as { stderr?: string; stdout?: string; killed?: boolean };
      const tail = (text: unknown) =>
        String(text ?? "")
          .slice(-2000)
          .trim();
      const parts = [
        detail.killed ? "（进程超时被终止）" : "",
        tail(detail.stderr) ? `stderr: ${tail(detail.stderr)}` : "",
        tail(detail.stdout) ? `stdout: ${tail(detail.stdout)}` : "",
      ].filter(Boolean);
      throw new Error(`${(error as Error).message}${parts.length ? `\n${parts.join("\n")}` : ""}`);
    }
    try {
      const parsed = JSON.parse(stdout) as { text?: unknown };
      return { text: typeof parsed.text === "string" ? parsed.text : stdout };
    } catch {
      return { text: stdout };
    }
  };

  const jobWorkspace = (job: PatrolJob, kind: "review" | "fix"): string => {
    const safe = `${job.repo.replace(/[^A-Za-z0-9_-]/g, "-")}-${job.prNumber}-${kind}`;
    return path.join(workRoot, kind === "review" ? `${safe}-${job.version.headSha}` : safe);
  };

  const prepareWorktree = async (job: PatrolJob, kind: "review" | "fix"): Promise<string> => {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(job.version.headSha)) {
      throw new Error("无效的 PR head SHA");
    }
    const dir = jobWorkspace(job, kind);
    await execFileAsync("git", ["-C", options.repoDir, "fetch", "origin", "--quiet"]);
    if (kind === "fix") {
      await execFileAsync("git", [
        "-C",
        options.repoDir,
        "worktree",
        "remove",
        "--force",
        dir,
      ]).catch(() => undefined);
      await execFileAsync("git", [
        "-C",
        options.repoDir,
        "worktree",
        "add",
        "--detach",
        dir,
        `origin/${job.branch}`,
      ]);
    } else if (!exists(dir)) {
      await execFileAsync("git", [
        "-C",
        options.repoDir,
        "worktree",
        "add",
        "--detach",
        dir,
        job.version.headSha,
      ]);
    }
    if (kind === "review") {
      await execFileAsync("git", [
        "-C",
        dir,
        "checkout",
        "--detach",
        "--force",
        job.version.headSha,
      ]);
      await execFileAsync("git", ["-C", dir, "clean", "-fdx"]);
    }
    return dir;
  };

  const head = async (dir: string): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"]);
    return stdout.trim();
  };

  return {
    review: async (input) => {
      const dir = await prepareWorktree(input.job, "review");
      const result = await runHeadless(dir, buildReviewPrompt(input));
      return parseReviewOutput(result.text);
    },
    adjudicate: async (input) => {
      const dir = await prepareWorktree(input.job, "review");
      const result = await runHeadless(dir, buildAdjudicationPrompt(input));
      const parsed = parseAdjudicationOutput(result.text);
      if (!parsed) throw new Error("裁决输出无法解析为结构化 JSON");
      return parsed;
    },
    fix: async (input) => {
      const dir = await prepareWorktree(input.job, "fix");
      const before = await head(dir);
      const result = await runHeadless(dir, buildFixPrompt(input));
      const parsed = parseFixOutput(result.text);
      if (parsed.status !== "pushed") return parsed;
      const after = await head(dir);
      if (after === before) {
        return { ...parsed, status: "failed", summary: `${parsed.summary}；但工作区没有新提交` };
      }
      await execFileAsync("git", [
        "-C",
        dir,
        "push",
        "origin",
        `HEAD:refs/heads/${input.job.branch}`,
      ]);
      return { ...parsed, pushedHeadSha: after };
    },
  };
}

function exists(dir: string): boolean {
  return fs.existsSync(dir);
}
