import {
  MAX_SUBAGENT_INSTRUCTIONS_LENGTH,
  MAX_SUBAGENT_MAX_TOKENS,
  MAX_SUBAGENT_MAX_TOOL_CALLS,
  MIN_SUBAGENT_MAX_TOKENS,
  MIN_SUBAGENT_MAX_TOOL_CALLS,
  type ReasoningEffort,
  type SubagentRole,
  type TaskStore,
} from "@hajicli/core";
import { MODEL_REGISTRY } from "@hajicli/plugins";
import type { ParsedSubagentCommand } from "./agent-commands.js";
import {
  budgetPrompt,
  parseOptionalInteger,
  textPrompt,
  validateDescription,
  validateInstructionsInput,
} from "./agent-wizard.js";
import {
  findSubagentPreset,
  loadSubagentPresets,
  type SubagentPreset,
  saveSubagentPresets,
} from "./subagent-presets.js";
import type { TerminalUI } from "./terminal-input.js";
import { colors } from "./theme.js";

/**
 * 向导运行期依赖：由 index.ts 的会话状态注入，
 * 使交互向导可以在不持有 main() 闭包的情况下复用。
 */
export interface WizardDeps {
  ui: TerminalUI;
  readSelectionSafely: (
    options: Parameters<TerminalUI["readSelection"]>[0],
  ) => ReturnType<TerminalUI["readSelection"]>;
  taskStore: TaskStore;
  /** 当前会话思考强度（作为向导的回退默认值）。 */
  currentEffort: () => ReasoningEffort;
  /** /model 与向导共享的 Effort 选项列表。 */
  effortOptions: { value: string; label: string; description: string }[];
}

// ---- subagent 预设辅助函数 ----
export const formatPresetSummary = (preset: SubagentPreset): string => {
  const parts = [
    preset.role || "research",
    preset.model || "默认模型",
    preset.reasoningEffort ? `effort:${preset.reasoningEffort}` : "",
    preset.maxTokens !== undefined ? `max-tokens:${preset.maxTokens}` : "",
    preset.maxToolCalls !== undefined ? `max-tool-calls:${preset.maxToolCalls}` : "",
    preset.timeoutMs !== undefined ? `timeout:${Math.round(preset.timeoutMs / 1000)}s` : "",
  ].filter(Boolean);
  return parts.join(" · ");
};

export const formatPresetDetail = (preset: SubagentPreset): string => {
  const rows: string[] = [colors.bold(`预设：${preset.name}`)];
  const label = (key: string, value: string | undefined, fallback = "默认"): string =>
    `  ${colors.gray(key.padEnd(14))}${value ?? fallback}`;
  rows.push(label("role", preset.role));
  rows.push(label("model", preset.model));
  rows.push(label("provider", preset.provider));
  rows.push(label("effort", preset.reasoningEffort));
  rows.push(label("instructions", preset.instructions, "（无）"));
  rows.push(
    label("timeout-ms", preset.timeoutMs !== undefined ? String(preset.timeoutMs) : undefined),
  );
  rows.push(
    label("max-tokens", preset.maxTokens !== undefined ? String(preset.maxTokens) : undefined),
  );
  rows.push(
    label(
      "max-tool-calls",
      preset.maxToolCalls !== undefined ? String(preset.maxToolCalls) : undefined,
    ),
  );
  return rows.join("\n");
};

export const persistPreset = (preset: SubagentPreset): boolean => {
  const current = loadSubagentPresets();
  const existing = findSubagentPreset(current, preset.name);
  const next = existing
    ? current.map((item) => (item.name.toLowerCase() === preset.name.toLowerCase() ? preset : item))
    : [...current, preset];
  return saveSubagentPresets(next);
};

export const buildPresetFromParsed = (
  name: string,
  parsed: Pick<
    ParsedSubagentCommand,
    | "role"
    | "model"
    | "provider"
    | "reasoningEffort"
    | "instructions"
    | "timeoutMs"
    | "maxTokens"
    | "maxToolCalls"
  >,
): SubagentPreset => ({
  name,
  ...(parsed.role ? { role: parsed.role } : {}),
  ...(parsed.model ? { model: parsed.model } : {}),
  ...(parsed.provider ? { provider: parsed.provider } : {}),
  ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
  ...(parsed.instructions ? { instructions: parsed.instructions } : {}),
  ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
  ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
  ...(parsed.maxToolCalls !== undefined ? { maxToolCalls: parsed.maxToolCalls } : {}),
});

// ---- 可导航配置向导（支持上一步 / 容错重问 / 确认页）----
const WIZARD_BACK = "__wizard_back__";
const WIZARD_RESTART = "__wizard_restart__";

const isBackInput = (input: string): boolean => {
  const lower = input.trim().toLowerCase();
  return lower === "b" || lower === "back";
};

const withBackItem = (
  items: { value: string; label: string; description: string }[],
): { value: string; label: string; description: string }[] => [
  ...items,
  { value: WIZARD_BACK, label: "← 上一步", description: "返回上一步重新选择" },
];

type WizardStepResult<T> = { kind: "next"; value: T } | { kind: "back" };

function createWizardHelpers(deps: WizardDeps) {
  /** 单选步骤（选择器 + 末尾 Back 项）。返回 next(value) 或 back。 */
  const askSelectionStep = async <T extends string>(
    title: string,
    items: { value: string; label: string; description: string }[],
    selectedValue: string,
  ): Promise<WizardStepResult<T>> => {
    const selection = await deps.readSelectionSafely({
      title,
      items: withBackItem(items),
      selectedValue,
    });
    if (selection.value === WIZARD_BACK) return { kind: "back" };
    return { kind: "next", value: selection.value as T };
  };

  /** 模型 + 思考强度选择步骤（secondary 联动；extraModels 用于保留不在注册表里的自定义当前值）。 */
  const askModelEffortStep = async (
    title: string,
    currentModel: string | undefined,
    currentEffort: ReasoningEffort | undefined,
    extraModels: string[] = [],
  ): Promise<
    WizardStepResult<{ model: string; provider?: string; reasoningEffort: ReasoningEffort }>
  > => {
    const items: { value: string; label: string; description: string }[] = MODEL_REGISTRY.map(
      (item) => ({
        value: item.value,
        label: item.label,
        description: `${item.provider} · ${item.description}`,
      }),
    );
    for (const extra of extraModels) {
      if (extra && !items.some((item) => item.value === extra)) {
        items.push({ value: extra, label: extra, description: "自定义模型（当前值）" });
      }
    }
    const selection = await deps.readSelectionSafely({
      title,
      items: withBackItem(items),
      selectedValue:
        currentModel && items.some((item) => item.value === currentModel)
          ? currentModel
          : MODEL_REGISTRY[0].value,
      secondary: {
        label: "Effort",
        items: deps.effortOptions,
        selectedValue: currentEffort || deps.currentEffort(),
      },
    });
    if (selection.value === WIZARD_BACK) return { kind: "back" };
    const descriptor = MODEL_REGISTRY.find((item) => item.value === selection.value);
    return {
      kind: "next",
      value: {
        model: selection.value,
        provider: descriptor?.provider,
        reasoningEffort: selection.secondaryValue as ReasoningEffort,
      },
    };
  };

  /** token 预算三步输入：非法重问、b 返回上一子步/上一配置步、回车跳过。返回是否完成（false=中途返回）。 */
  const askBudgetFlow = async (
    state: { maxTokens?: number; maxToolCalls?: number; timeoutMs?: number },
    onFirstBack: () => void,
  ): Promise<boolean> => {
    const fields = [
      {
        key: "maxTokens" as const,
        label: "max-tokens",
        min: MIN_SUBAGENT_MAX_TOKENS,
        max: MAX_SUBAGENT_MAX_TOKENS,
      },
      {
        key: "maxToolCalls" as const,
        label: "max-tool-calls",
        min: MIN_SUBAGENT_MAX_TOOL_CALLS,
        max: MAX_SUBAGENT_MAX_TOOL_CALLS,
      },
      { key: "timeoutMs" as const, label: "timeout-ms", min: 100, max: 3_600_000 },
    ];
    let index = 0;
    while (index < fields.length) {
      const field = fields[index];
      const input = (
        await deps.ui.readInput({
          prompt: budgetPrompt(field.label, state[field.key], field.min, field.max),
        })
      ).trim();
      if (isBackInput(input)) {
        if (index > 0) {
          index -= 1;
        } else {
          onFirstBack();
          return false;
        }
        continue;
      }
      const result = parseOptionalInteger(input, field.min, field.max);
      if (!result.ok) {
        deps.ui.writeLine(colors.red(`✗ ${result.message}，请重新输入。`));
        continue;
      }
      // 留空（undefined）时保持当前值：add 向导初始为空 -> undefined；edit 向导初始为现值 -> 保持
      state[field.key] = result.value ?? state[field.key];
      index += 1;
    }
    return true;
  };

  /** 文本输入步骤：非法重问、b 返回。 */
  const askTextFlow = async (
    prompt: string,
    validate: (input: string) => string | null,
    onBack: () => void,
  ): Promise<string | undefined> => {
    while (true) {
      const input = (await deps.ui.readInput({ prompt })).trim();
      if (isBackInput(input)) {
        onBack();
        return undefined;
      }
      const error = validate(input);
      if (error) {
        deps.ui.writeLine(colors.red(`✗ ${error}，请重新输入（输入 b 返回上一步）。`));
        continue;
      }
      return input;
    }
  };

  return { askSelectionStep, askModelEffortStep, askBudgetFlow, askTextFlow };
}

export interface SubagentWizardState {
  preset?: SubagentPreset;
  background: boolean;
  role?: SubagentRole;
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  taskId?: string;
  description?: string;
  instructions?: string;
}
type SubagentWizardStep =
  | "preset"
  | "mode"
  | "role"
  | "model"
  | "budget"
  | "task"
  | "description"
  | "instructions"
  | "confirm";

/** /subagent 交互式向导：支持上一步、容错重问与最终确认页。取消时抛 TerminalInputCancelledError。 */
export const runSubagentWizard = async (
  presets: SubagentPreset[],
  initialPresetName: string | undefined,
  deps: WizardDeps,
): Promise<SubagentWizardState> => {
  const { askSelectionStep, askModelEffortStep, askBudgetFlow, askTextFlow } =
    createWizardHelpers(deps);
  const state: SubagentWizardState = { background: false };
  let step: SubagentWizardStep = "preset";
  while (true) {
    if (step === "preset") {
      if (presets.length === 0) {
        step = "mode";
        continue;
      }
      const result = await askSelectionStep<"custom" | "preset">(
        "Use preset or customize",
        [
          { value: "custom", label: "Customize", description: "手动配置所有参数" },
          ...presets.map((preset) => ({
            value: preset.name,
            label: preset.name,
            description: formatPresetSummary(preset),
          })),
        ],
        state.preset?.name || initialPresetName || "custom",
      );
      if (result.kind === "back") continue; // 第一步无上一步
      state.preset =
        result.value === "custom" ? undefined : findSubagentPreset(presets, result.value);
      step = "mode";
      continue;
    }
    if (step === "mode") {
      const result = await askSelectionStep<"foreground" | "background">(
        "Choose execution mode",
        [
          { value: "foreground", label: "Foreground", description: "等待该 Agent 完成后再继续" },
          { value: "background", label: "Background", description: "后台只读运行，完成后通知" },
        ],
        state.background ? "background" : "foreground",
      );
      if (result.kind === "back") {
        step = "preset";
        continue;
      }
      state.background = result.value === "background";
      step = state.preset ? "task" : "role";
      continue;
    }
    if (step === "role") {
      const result = await askSelectionStep<"research" | "review" | "implement">(
        "Choose subagent role",
        [
          { value: "research", label: "Research", description: "只读调研、定位调用链和收集证据" },
          { value: "review", label: "Review", description: "只读审查代码、差异和风险" },
          {
            value: "implement",
            label: "Implement",
            description: "前台执行；按当前权限修改和验证",
          },
        ],
        state.role || "research",
      );
      if (result.kind === "back") {
        step = "mode";
        continue;
      }
      state.role = result.value;
      step = "model";
      continue;
    }
    if (step === "model") {
      const result = await askModelEffortStep(
        "Choose subagent model and effort",
        state.model,
        state.reasoningEffort,
      );
      if (result.kind === "back") {
        step = "role";
        continue;
      }
      state.model = result.value.model;
      state.provider = result.value.provider;
      state.reasoningEffort = result.value.reasoningEffort;
      step = "budget";
      continue;
    }
    if (step === "budget") {
      deps.ui.writeLine(colors.gray("- token 预算（回车跳过 = 使用默认，输入 b 返回上一步）-"));
      const completed = await askBudgetFlow(state, () => {
        step = "model";
      });
      if (!completed) continue;
      step = "task";
      continue;
    }
    if (step === "task") {
      const activeTasks = deps.taskStore.getPlan()?.tasks || [];
      if (activeTasks.length === 0) {
        step = "description";
        continue;
      }
      const result = await askSelectionStep<"none" | "task">(
        "Link to Todo",
        [
          { value: "none", label: "No Todo", description: "不关联任务" },
          ...activeTasks.map((task) => ({
            value: task.id,
            label: task.id,
            description: task.content,
          })),
        ],
        state.taskId || "none",
      );
      if (result.kind === "back") {
        step = state.preset ? "mode" : "budget";
        continue;
      }
      state.taskId = result.value === "none" ? undefined : result.value;
      step = "description";
      continue;
    }
    if (step === "description") {
      const description = await askTextFlow(
        textPrompt("任务描述", "必填"),
        validateDescription,
        () => {
          step = "task";
        },
      );
      if (description === undefined) continue;
      state.description = description;
      step = state.preset?.instructions || state.instructions ? "confirm" : "instructions";
      continue;
    }
    if (step === "instructions") {
      const instructions = await askTextFlow(
        textPrompt("附加指令", "可留空"),
        (input) => validateInstructionsInput(input, MAX_SUBAGENT_INSTRUCTIONS_LENGTH),
        () => {
          step = "description";
        },
      );
      if (instructions === undefined) continue;
      state.instructions = instructions || undefined;
      step = "confirm";
      continue;
    }
    if (step === "confirm") {
      const role = state.role ?? state.preset?.role ?? "research";
      const model = state.model ?? state.preset?.model ?? "默认模型";
      const effort = state.reasoningEffort ?? state.preset?.reasoningEffort ?? deps.currentEffort();
      const finalMaxTokens = state.maxTokens ?? state.preset?.maxTokens;
      const finalMaxToolCalls = state.maxToolCalls ?? state.preset?.maxToolCalls;
      const finalTimeoutMs = state.timeoutMs ?? state.preset?.timeoutMs;
      const budgetParts =
        [
          finalMaxTokens !== undefined ? `max-tokens:${finalMaxTokens}` : "",
          finalMaxToolCalls !== undefined ? `max-tool-calls:${finalMaxToolCalls}` : "",
          finalTimeoutMs !== undefined ? `timeout:${Math.round(finalTimeoutMs / 1000)}s` : "",
        ]
          .filter(Boolean)
          .join(" ") || "默认预算";
      deps.ui.writeLine(
        colors.gray(
          `配置摘要：${state.preset ? `预设 ${state.preset.name} · ` : ""}${role} · ${model} · effort:${effort} · ${budgetParts}${state.taskId ? ` · todo:${state.taskId}` : ""}`,
        ),
      );
      const result = await askSelectionStep<"confirm" | typeof WIZARD_RESTART>(
        "确认配置",
        [
          { value: "confirm", label: "✓ 确认启动", description: "按当前配置启动子代理" },
          { value: WIZARD_RESTART, label: "↺ 重新配置", description: "从头开始配置" },
        ],
        "confirm",
      );
      if (result.kind === "back") {
        step = state.preset?.instructions || state.instructions ? "instructions" : "description";
        continue;
      }
      if (result.value === WIZARD_RESTART) {
        step = "preset";
        continue;
      }
      return state;
    }
  }
};

export interface PresetWizardState {
  role?: SubagentRole;
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  instructions?: string;
}
type PresetWizardStep = "role" | "model" | "budget" | "instructions" | "confirm";

/**
 * /preset add / edit 交互式向导。initial 为现有预设值（edit 模式），
 * 留空/回车保持当前值；支持上一步、容错重问与确认页。
 */
export const runPresetWizard = async (
  initial: Partial<PresetWizardState>,
  deps: WizardDeps,
): Promise<PresetWizardState> => {
  const { askSelectionStep, askModelEffortStep, askBudgetFlow, askTextFlow } =
    createWizardHelpers(deps);
  const state: PresetWizardState = { ...initial };
  let step: PresetWizardStep = "role";
  while (true) {
    if (step === "role") {
      const result = await askSelectionStep<"research" | "review" | "implement">(
        "Preset role",
        [
          { value: "research", label: "Research", description: "只读调研、定位调用链和收集证据" },
          { value: "review", label: "Review", description: "只读审查代码、差异和风险" },
          {
            value: "implement",
            label: "Implement",
            description: "前台执行；按当前权限修改和验证",
          },
        ],
        state.role || "research",
      );
      if (result.kind === "back") continue; // 第一步无上一步
      state.role = result.value;
      step = "model";
      continue;
    }
    if (step === "model") {
      const result = await askModelEffortStep(
        "Preset model and effort",
        state.model,
        state.reasoningEffort,
        state.model ? [state.model] : [],
      );
      if (result.kind === "back") {
        step = "role";
        continue;
      }
      state.model = result.value.model;
      state.provider = result.value.provider;
      state.reasoningEffort = result.value.reasoningEffort;
      step = "budget";
      continue;
    }
    if (step === "budget") {
      deps.ui.writeLine(colors.gray("- token 预算（回车跳过 = 使用默认，输入 b 返回上一步）-"));
      const completed = await askBudgetFlow(state, () => {
        step = "model";
      });
      if (!completed) continue;
      step = "instructions";
      continue;
    }
    if (step === "instructions") {
      const instructions = await askTextFlow(
        textPrompt("附加指令", "可留空"),
        (input) => validateInstructionsInput(input, MAX_SUBAGENT_INSTRUCTIONS_LENGTH),
        () => {
          step = "budget";
        },
      );
      if (instructions === undefined) continue;
      state.instructions = instructions || state.instructions;
      step = "confirm";
      continue;
    }
    if (step === "confirm") {
      const finalMaxTokens = state.maxTokens;
      const finalMaxToolCalls = state.maxToolCalls;
      const finalTimeoutMs = state.timeoutMs;
      const budgetParts =
        [
          finalMaxTokens !== undefined ? `max-tokens:${finalMaxTokens}` : "",
          finalMaxToolCalls !== undefined ? `max-tool-calls:${finalMaxToolCalls}` : "",
          finalTimeoutMs !== undefined ? `timeout:${Math.round(finalTimeoutMs / 1000)}s` : "",
        ]
          .filter(Boolean)
          .join(" ") || "默认预算";
      deps.ui.writeLine(
        colors.gray(
          `配置摘要：${state.role || "research"} · ${state.model || "默认模型"} · effort:${state.reasoningEffort || deps.currentEffort()} · ${budgetParts}${state.instructions ? " · 含附加指令" : ""}`,
        ),
      );
      const result = await askSelectionStep<"confirm" | typeof WIZARD_RESTART>(
        "确认配置",
        [
          { value: "confirm", label: "✓ 确认保存", description: "保存该预设" },
          { value: WIZARD_RESTART, label: "↺ 重新配置", description: "从头开始配置" },
        ],
        "confirm",
      );
      if (result.kind === "back") {
        step = "instructions";
        continue;
      }
      if (result.value === WIZARD_RESTART) {
        step = "role";
        continue;
      }
      return state;
    }
  }
};
