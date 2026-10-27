/**
 * 本地 A/B 实验注册表：把「并行批处理 / 子代理调度」这类行为做成可对照的开关。
 *
 * 分配单位是**一次进程的 trace session id**（`SessionTracker.getSessionId()`），
 * 同一进程内所有回合保持一致；`/clear`、`/resume` 不会让行为半途翻转。
 *
 * 三种取值来源，优先级从高到低：
 * 1. `HAJI_EXPERIMENTS="name=arm,name=arm"`（`all=control` 可一次全设控制组）；
 * 2. `HAJI_AB=1`：按 `sha256(salt:unitId:name)` 稳定分流，默认五五开；
 * 3. 内置默认值（当前推荐值，便于不做实验时直接吃到改进）。
 *
 * 结果写入 trace 的 `experiment_assignment` 事件，`pnpm ab:report` 按 arm 汇总。
 */

import { createHash } from "node:crypto";

export const EXPERIMENT_NAMES = [
  "parallel_prompt",
  "parallel_allowlist",
  "parallel_max",
  "subagent_access",
  "subagent_batch",
  "tool_batching",
  "scope_discipline",
  "read_budget",
] as const;

export type ExperimentName = (typeof EXPERIMENT_NAMES)[number];

export interface ExperimentSpec {
  readonly arms: readonly string[];
  /** 对照组 arm（关闭改动时的行为）。 */
  readonly control: string;
  /** 推荐默认 arm（不做实验时生效）。 */
  readonly defaultValue: string;
}

export const EXPERIMENTS: Readonly<Record<ExperimentName, ExperimentSpec>> = {
  // 提示词是否要求「互不依赖的只读调用放同一条回复」。
  parallel_prompt: { arms: ["control", "batch"], control: "control", defaultValue: "batch" },
  // 只读 bash / 只读 MCP 是否进入并行白名单。
  parallel_allowlist: {
    arms: ["static", "dynamic"],
    control: "static",
    defaultValue: "dynamic",
  },
  // 同一并行批最多几个调用：3（旧）或 5（新）。
  parallel_max: { arms: ["3", "5"], control: "3", defaultValue: "5" },
  // 工具触发的子代理：workspace-write（旧）或按 role 决定（research/review 只读）。
  subagent_access: { arms: ["write", "role"], control: "write", defaultValue: "role" },
  // 子代理内部是否复用连续只读批处理。
  subagent_batch: { arms: ["serial", "batched"], control: "serial", defaultValue: "batched" },
  // 是否在提示词里要求优先用工具自带批量参数（read.paths / grep.queries / global.patterns）合并调用。
  tool_batching: {
    arms: ["baseline", "batch_first"],
    control: "baseline",
    defaultValue: "batch_first",
  },
  // 搜索/读取范围收敛：先定位再搜、一次读完目标区块、叠读提示。
  // 实测 converge 反而更啰嗦（调用 +38%），默认回退到 baseline，保留代码供后续变体实验。
  scope_discipline: {
    arms: ["baseline", "converge"],
    control: "baseline",
    defaultValue: "baseline",
  },
  // read 的输出预算：shared=总量 8k 按文件数平分（旧行为）；per_file=单文件 16k、总量 32k；
  // batch_only=只修「批量读多个文件时按文件数平分」（单文件维持 8k/200 行）。
  // 实测 per_file 墙钟无改善且任务 7 质量退化；batch_only 墙钟中性、请求/费用 −9%、质量更好，采纳为默认。
  read_budget: {
    arms: ["shared", "per_file", "batch_only"],
    control: "shared",
    defaultValue: "batch_only",
  },
};

export type ExperimentSource = "env" | "hash" | "default";

export interface ExperimentAssignment {
  name: ExperimentName;
  arm: string;
  source: ExperimentSource;
}

export interface ExperimentRegistryOptions {
  env?: NodeJS.ProcessEnv;
  /** 分流盐；默认 `HAJI_AB_SALT` 或 `haji`。 */
  salt?: string;
  /** 覆盖 `HAJI_AB` 判定，便于测试。 */
  randomize?: boolean;
}

const TRUTHY = new Set(["1", "true", "on", "yes"]);

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

function parseOverrides(raw: string | undefined): Map<ExperimentName, string> {
  const overrides = new Map<ExperimentName, string>();
  if (!raw?.trim()) return overrides;
  for (const token of raw.split(/[\s,]+/)) {
    const [rawName, rawArm] = token.split("=", 2);
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    if (name === "all") {
      const arm = rawArm?.trim();
      if (!arm) continue;
      for (const experiment of EXPERIMENT_NAMES) {
        const spec = EXPERIMENTS[experiment];
        if (arm === "control") {
          overrides.set(experiment, spec.control);
        } else if (arm === "default") {
          overrides.set(experiment, spec.defaultValue);
        } else if (spec.arms.includes(arm)) {
          overrides.set(experiment, arm);
        }
      }
      continue;
    }
    if (!EXPERIMENT_NAMES.includes(name as ExperimentName)) continue;
    const experiment = name as ExperimentName;
    const arm = rawArm?.trim();
    if (arm && EXPERIMENTS[experiment].arms.includes(arm)) {
      overrides.set(experiment, arm);
    }
  }
  return overrides;
}

function hashArm(
  salt: string,
  unitId: string,
  name: ExperimentName,
  arms: readonly string[],
): string {
  const digest = createHash("sha256").update(`${salt}:${unitId}:${name}`).digest();
  const arm = arms[digest[0] % arms.length];
  if (!arm) throw new Error(`实验 ${name} 没有可用的 arm`);
  return arm;
}

export class ExperimentRegistry {
  private readonly env: NodeJS.ProcessEnv;
  private readonly salt: string;
  private readonly randomize: boolean;
  private readonly overrides: Map<ExperimentName, string>;
  private readonly cache = new Map<ExperimentName, ExperimentAssignment>();

  constructor(
    private readonly unitId: string,
    options: ExperimentRegistryOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.salt = options.salt ?? this.env.HAJI_AB_SALT?.trim() ?? "haji";
    this.randomize = options.randomize ?? isTruthy(this.env.HAJI_AB);
    this.overrides = parseOverrides(this.env.HAJI_EXPERIMENTS);
  }

  assignment(name: ExperimentName): ExperimentAssignment {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const spec = EXPERIMENTS[name];
    const override = this.overrides.get(name);
    const assignment: ExperimentAssignment = override
      ? { name, arm: override, source: "env" }
      : this.randomize
        ? { name, arm: hashArm(this.salt, this.unitId, name, spec.arms), source: "hash" }
        : { name, arm: spec.defaultValue, source: "default" };
    this.cache.set(name, assignment);
    return assignment;
  }

  arm(name: ExperimentName): string {
    return this.assignment(name).arm;
  }

  is(name: ExperimentName, arm: string): boolean {
    return this.arm(name) === arm;
  }

  all(): ExperimentAssignment[] {
    return EXPERIMENT_NAMES.map((name) => this.assignment(name));
  }

  /** trace 里落一份快照：`{ parallel_prompt: "batch", ... }`。 */
  record(): Record<string, string> {
    return Object.fromEntries(this.all().map((item) => [item.name, item.arm]));
  }

  /** 当前进程的分配单位（trace session id）。 */
  getUnitId(): string {
    return this.unitId;
  }
}

/** 并行上限：`HAJI_MAX_PARALLEL_TOOLS`（1–8）优先，否则按 `parallel_max` 实验 arm。 */
export function resolveMaxParallelTools(
  registry: ExperimentRegistry,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.HAJI_MAX_PARALLEL_TOOLS);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 8) return raw;
  const arm = Number(registry.arm("parallel_max"));
  return Number.isInteger(arm) && arm >= 1 && arm <= 8 ? arm : 5;
}
