/**
 * 子代理相关命令族：/subagent（含交互式向导与预设复用）、
 * /preset（list / show / edit / remove / add）、/agents（查看与中止）。
 *
 * 从 index.ts 主循环分发抽出；会话状态经 SubagentCommandContext 注入。
 */
import type { AgentManager, ChatMessage, SubagentRequest } from "@hajicli/core";
import { MODEL_REGISTRY } from "@hajicli/plugins";
import { parsePresetCommand, parseSubagentCommand } from "./agent-commands.js";
import {
  applySubagentPreset,
  findSubagentPreset,
  loadSubagentPresets,
  type SubagentPreset,
  saveSubagentPresets,
  updateSubagentPreset,
} from "./subagent-presets.js";
import {
  buildPresetFromParsed,
  formatPresetDetail,
  formatPresetSummary,
  persistPreset,
  runPresetWizard,
  runSubagentWizard,
  type WizardDeps,
} from "./subagent-wizard.js";
import { TerminalInputCancelledError, type TerminalUI } from "./terminal-input.js";
import { colors } from "./theme.js";

/** AgentManager.launch 的返回类型（保持与 core 的真实类型一致，避免结构体猜测）。 */
export type AgentLaunchHandle = ReturnType<AgentManager["launch"]>;

export interface SubagentCommandContext {
  ui: TerminalUI;
  agentManager: AgentManager;
  wizardDeps: WizardDeps;
  launchManualAgent(request: SubagentRequest, background: boolean): AgentLaunchHandle;
  readSelectionSafely: (
    options: Parameters<TerminalUI["readSelection"]>[0],
    draftHandling?: "queue" | "restore",
  ) => ReturnType<TerminalUI["readSelection"]>;
  getSelectedModel(): string;
  getMessages(): ChatMessage[];
  /** 把当前消息写回会话存储（sessionManager.saveCurrentSession）。 */
  saveSession(): void;
  refreshAgentVerificationContext(messages: ChatMessage[]): boolean;
  updateStatusUI(): void;
}

/** 分发 /subagent 指令；调用方负责其后的主循环 continue。 */
export async function handleSubagentCommand(
  ctx: SubagentCommandContext,
  input: { trimmedInput: string },
): Promise<void> {
  const { ui, agentManager } = ctx;
  try {
    let parsed = parseSubagentCommand(input.trimmedInput.slice("/subagent".length));
    if (!parsed.description) {
      // ---- 交互式向导：预设选择 → 模式 → 角色/模型/预算 → Todo → 描述 → 确认 ----
      const presets = loadSubagentPresets();
      let initialPresetName: string | undefined;
      if (parsed.preset) {
        const found = findSubagentPreset(presets, parsed.preset);
        if (!found) {
          ui.writeLine(colors.failLine(`预设不存在: ${parsed.preset}。使用 /preset 查看或添加。`));
          return;
        }
        initialPresetName = found.name;
      }
      const wizardState = await runSubagentWizard(presets, initialPresetName, ctx.wizardDeps);
      parsed = {
        background: wizardState.background,
        taskId: wizardState.taskId,
        role: wizardState.role ?? wizardState.preset?.role,
        model: wizardState.model ?? wizardState.preset?.model,
        provider: wizardState.provider ?? wizardState.preset?.provider,
        reasoningEffort: wizardState.reasoningEffort ?? wizardState.preset?.reasoningEffort,
        instructions: wizardState.instructions ?? wizardState.preset?.instructions,
        timeoutMs: wizardState.timeoutMs ?? wizardState.preset?.timeoutMs,
        maxTokens: wizardState.maxTokens ?? wizardState.preset?.maxTokens,
        maxToolCalls: wizardState.maxToolCalls ?? wizardState.preset?.maxToolCalls,
        description: wizardState.description!,
      };
      // ---- 保存为预设（可选）----
      const saveName = (
        await ui.readInput({
          prompt: `${colors.gray("保存为预设 (输入名称或回车跳过)")} › `,
        })
      ).trim();
      if (saveName) {
        if (persistPreset(buildPresetFromParsed(saveName, parsed))) {
          ui.writeLine(
            colors.okLine(`已保存预设：${saveName}（下次可用 /subagent preset:${saveName} 复用）`),
          );
        } else {
          ui.writeLine(colors.warnLine("预设保存失败（请检查磁盘权限）。"));
        }
      }
    } else if (parsed.preset) {
      // ---- 非交互式：应用预设（命令行显式参数优先）----
      const preset = findSubagentPreset(loadSubagentPresets(), parsed.preset);
      if (!preset) {
        ui.writeLine(colors.failLine(`预设不存在: ${parsed.preset}。使用 /preset 查看或添加。`));
        return;
      }
      parsed = applySubagentPreset(parsed, preset);
      ui.writeLine(colors.gray(`已应用预设：${preset.name}（${formatPresetSummary(preset)}）`));
    }
    if (!parsed.description) {
      ui.writeLine(colors.failLine("子代理任务描述不能为空。"));
      return;
    }
    const launch = ctx.launchManualAgent(
      {
        description: parsed.description,
        role: parsed.role,
        taskId: parsed.taskId,
        model: parsed.model,
        provider: parsed.provider,
        reasoningEffort: parsed.reasoningEffort,
        instructions: parsed.instructions,
        timeoutMs: parsed.timeoutMs,
        maxTokens: parsed.maxTokens,
        maxToolCalls: parsed.maxToolCalls,
      },
      parsed.background,
    );
    ui.writeLine(
      colors.cyan(
        `🤖 ${launch.agent.id} ${parsed.background ? "已在后台排队/启动" : "已在前台启动"}。`,
      ),
    );
    if (parsed.background) return;
    ui.onEsc(() => {
      agentManager.abort(launch.agent.id);
    });
    const finished = await launch.completion;
    ui.onEsc();
    if (finished.result) {
      ui.writeLine(finished.result.summary);
      ui.writeLine(colors.warnLine(`结果状态：${finished.status}，需要父 Agent 独立验证。`));
      ctx.refreshAgentVerificationContext(ctx.getMessages());
      ctx.saveSession();
      ctx.updateStatusUI();
    }
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) {
      ui.writeLine(colors.gray("已取消创建子代理。"));
    } else {
      ui.writeLine(
        colors.failLine(
          `启动子代理失败: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}

/**
 * 缺参数时列出预设供选择：能枚举的数据不要求用户手抄名字。
 * 没有预设或用户按 Esc 取消时返回 undefined，调用方回退到原有的用法提示。
 */
async function pickPresetName(
  ctx: SubagentCommandContext,
  presets: ReturnType<typeof loadSubagentPresets>,
): Promise<string | undefined> {
  if (presets.length === 0) return undefined;
  try {
    const selection = await ctx.readSelectionSafely({
      title: "选择 subagent 预设",
      items: presets.map((preset) => ({
        value: preset.name,
        label: preset.name,
        description: formatPresetSummary(preset),
      })),
      selectedValue: presets[0].name,
    });
    return selection.value;
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) return undefined;
    throw error;
  }
}

/** 分发 /preset 与 /presets 指令；调用方负责其后的主循环 continue。 */
export async function handlePresetCommand(
  ctx: SubagentCommandContext,
  input: { trimmedInput: string; parts: string[] },
): Promise<void> {
  const { ui, wizardDeps } = ctx;
  const parts = input.parts;
  const trimmedInput = input.trimmedInput;
  const action = parts[1]?.toLowerCase();
  const presets = loadSubagentPresets();
  if (!action || action === "list") {
    if (presets.length === 0) {
      ui.writeLine(
        colors.gray("暂无 subagent 预设。使用 /preset add 添加，或在 /subagent 交互式流程中保存。"),
      );
    } else {
      ui.writeLine(colors.bold(`Subagent 预设 (${presets.length})`));
      for (const preset of presets) {
        ui.writeLine(`  ${colors.purple(preset.name)} ${colors.gray(formatPresetSummary(preset))}`);
      }
    }
    return;
  }
  if (action === "show") {
    // 无名称时直接列预设供选，避免手抄名字。
    const name = parts[2] ?? (await pickPresetName(ctx, presets));
    if (!name) {
      ui.writeLine(colors.warnLine("用法: /preset show <name>"));
      return;
    }
    const preset = findSubagentPreset(presets, name);
    if (!preset) {
      ui.writeLine(colors.failLine(`预设不存在: ${name}`));
      return;
    }
    ui.writeLine(formatPresetDetail(preset));
    return;
  }
  if (action === "edit" || action === "update") {
    const rawArgs = trimmedInput.replace(/^\/presets?\s+edit\s*/i, "");
    if (!rawArgs) {
      ui.writeLine(
        colors.warnLine(
          "用法: /preset edit <name> [--effort ...] [--max-tokens ...] ...（不带选项时交互式修改）",
        ),
      );
      return;
    }
    try {
      const parsedPreset = parsePresetCommand(rawArgs);
      const target = findSubagentPreset(presets, parsedPreset.name);
      if (!target) {
        ui.writeLine(colors.failLine(`预设不存在: ${parsedPreset.name}`));
        return;
      }
      const patch: Partial<Omit<SubagentPreset, "name">> = {
        ...(parsedPreset.role ? { role: parsedPreset.role } : {}),
        ...(parsedPreset.model ? { model: parsedPreset.model } : {}),
        ...(parsedPreset.provider ? { provider: parsedPreset.provider } : {}),
        ...(parsedPreset.reasoningEffort ? { reasoningEffort: parsedPreset.reasoningEffort } : {}),
        ...(parsedPreset.instructions !== undefined
          ? { instructions: parsedPreset.instructions }
          : {}),
        ...(parsedPreset.timeoutMs !== undefined ? { timeoutMs: parsedPreset.timeoutMs } : {}),
        ...(parsedPreset.maxTokens !== undefined ? { maxTokens: parsedPreset.maxTokens } : {}),
        ...(parsedPreset.maxToolCalls !== undefined
          ? { maxToolCalls: parsedPreset.maxToolCalls }
          : {}),
      };
      if (parsedPreset.model && parsedPreset.model !== target.model) {
        const descriptor = MODEL_REGISTRY.find((item) => item.value === parsedPreset.model);
        if (descriptor) patch.provider = descriptor.provider;
      }
      if (Object.keys(patch).length === 0) {
        // 未指定任何字段 → 交互式修改（现有值作为初始默认，留空/回车保持原值）
        const wizardState = await runPresetWizard(
          {
            role: target.role,
            model: target.model,
            provider: target.provider,
            reasoningEffort: target.reasoningEffort,
            instructions: target.instructions,
            maxTokens: target.maxTokens,
            maxToolCalls: target.maxToolCalls,
            timeoutMs: target.timeoutMs,
          },
          wizardDeps,
        );
        patch.role = wizardState.role;
        patch.model = wizardState.model;
        patch.provider = wizardState.provider;
        patch.reasoningEffort = wizardState.reasoningEffort;
        if (wizardState.instructions !== undefined) patch.instructions = wizardState.instructions;
        patch.maxTokens = wizardState.maxTokens;
        patch.maxToolCalls = wizardState.maxToolCalls;
        patch.timeoutMs = wizardState.timeoutMs;
      }
      if (saveSubagentPresets(updateSubagentPreset(presets, target.name, patch))) {
        ui.writeLine(
          colors.okLine(`已更新预设：${target.name}（/preset show ${target.name} 查看详情）`),
        );
      } else {
        ui.writeLine(colors.warnLine("预设保存失败（请检查磁盘权限）。"));
      }
    } catch (error) {
      if (error instanceof TerminalInputCancelledError) {
        ui.writeLine(colors.gray("已取消编辑预设。"));
      } else {
        ui.writeLine(
          colors.failLine(
            `编辑预设失败: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
    return;
  }
  if (action === "remove" || action === "rm" || action === "delete") {
    const name = parts[2] ?? (await pickPresetName(ctx, presets));
    if (!name) {
      ui.writeLine(colors.warnLine("用法: /preset remove <name>"));
      return;
    }
    const existing = findSubagentPreset(presets, name);
    if (!existing) {
      ui.writeLine(colors.failLine(`预设不存在: ${name}`));
      return;
    }
    const next = presets.filter((item) => item.name.toLowerCase() !== existing.name.toLowerCase());
    if (saveSubagentPresets(next)) {
      ui.writeLine(colors.okLine(`已删除预设：${existing.name}`));
    } else {
      ui.writeLine(colors.warnLine("删除失败（请检查磁盘权限）。"));
    }
    return;
  }
  if (action === "add") {
    const rawArgs = trimmedInput.replace(/^\/presets?\s+add\s*/i, "");
    try {
      let presetToAdd: SubagentPreset | undefined;
      if (rawArgs) {
        // 参数模式：/preset add <name> [--role ...] [--model ...] [--effort ...] [token 预算...]
        const parsedPreset = parsePresetCommand(rawArgs);
        presetToAdd = buildPresetFromParsed(parsedPreset.name, parsedPreset);
      } else {
        // 交互式引导（可导航向导：支持上一步 / 容错 / 确认页）
        const nameInput = (await ui.readInput({ prompt: "预设名称（留空取消）" })).trim();
        if (!nameInput) {
          ui.writeLine(colors.gray("已取消添加预设。"));
          return;
        }
        const wizardState = await runPresetWizard({}, wizardDeps);
        presetToAdd = buildPresetFromParsed(nameInput, {
          role: wizardState.role,
          model: wizardState.model,
          provider: wizardState.provider,
          reasoningEffort: wizardState.reasoningEffort,
          instructions: wizardState.instructions,
          timeoutMs: wizardState.timeoutMs,
          maxTokens: wizardState.maxTokens,
          maxToolCalls: wizardState.maxToolCalls,
        });
      }
      if (!presetToAdd) return;
      if (persistPreset(presetToAdd)) {
        ui.writeLine(
          colors.okLine(
            `已保存预设：${presetToAdd.name}（/preset show ${presetToAdd.name} 查看详情）`,
          ),
        );
      } else {
        ui.writeLine(colors.warnLine("预设保存失败（请检查磁盘权限）。"));
      }
    } catch (error) {
      if (error instanceof TerminalInputCancelledError) {
        ui.writeLine(colors.gray("已取消添加预设。"));
      } else {
        ui.writeLine(
          colors.failLine(
            `添加预设失败: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
    return;
  }
  ui.writeLine(colors.failLine(`未知操作: ${action}。支持 list / show / add / remove。`));
}

/** 分发 /agents 指令（列表选择、查看详情与中止）；调用方负责其后的主循环 continue。 */
export async function handleAgentsCommand(
  ctx: SubagentCommandContext,
  input: { parts: string[] },
): Promise<void> {
  const { ui, agentManager } = ctx;
  const action = input.parts[1]?.toLowerCase();
  if (action === "stop") {
    // 无参时列出 Agent 供选（含 all），省掉手抄 id。
    let target = input.parts[2];
    if (!target) {
      const candidates = agentManager.list();
      if (candidates.length === 0) {
        ui.writeLine(colors.gray("当前没有 Agent 记录。"));
        return;
      }
      try {
        const selection = await ctx.readSelectionSafely({
          title: "选择要中止的 Agent",
          items: [
            { value: "all", label: "all", description: "中止全部运行中的 Agent" },
            ...candidates.map((agent) => ({
              value: agent.id,
              label: `${agent.id} ${agent.status}`,
              description: `${agent.role} · ${agent.description}`,
            })),
          ],
          selectedValue: candidates[0].id,
        });
        target = selection.value;
      } catch (error) {
        if (!(error instanceof TerminalInputCancelledError)) throw error;
        return;
      }
    }
    if (target.toLowerCase() === "all") {
      ui.writeLine(colors.okLine(`已请求中止 ${agentManager.abortAll()} 个 Agent。`));
    } else {
      ui.writeLine(
        agentManager.abort(target)
          ? colors.okLine(`已请求中止 ${target}。`)
          : colors.failLine(`Agent 不存在或当前不可中止: ${target}`),
      );
    }
    return;
  }
  if (action === "clear") {
    ui.writeLine(colors.gray(`已清理 ${agentManager.clearFinished()} 条已结束 Agent 记录。`));
    return;
  }
  const agents = agentManager.list();
  if (agents.length === 0) {
    ui.writeLine(colors.gray("当前没有 Agent 记录。"));
    return;
  }
  try {
    const selection = await ctx.readSelectionSafely({
      title: "Agents — choose one and an action",
      items: agents.map((agent) => ({
        value: agent.id,
        label: `${agent.id} ${agent.status}`,
        description: `${agent.role} · ${agent.model || ctx.getSelectedModel()}${agent.provider ? ` · ${agent.provider}` : ""} · ${agent.description}`,
      })),
      selectedValue: agents[0].id,
      secondary: {
        label: "Action",
        items: [
          { value: "view", label: "View", description: "查看状态和结果" },
          { value: "stop", label: "Stop", description: "中止运行或排队中的 Agent" },
        ],
        selectedValue: "view",
      },
    });
    const selected = agentManager.get(selection.value);
    if (selection.secondaryValue === "stop") {
      ui.writeLine(
        agentManager.abort(selection.value)
          ? colors.okLine(`已请求中止 ${selection.value}。`)
          : colors.failLine(`Agent ${selection.value} 当前不可中止。`),
      );
    } else if (selected) {
      ui.writeChat(JSON.stringify(selected, null, 2));
    }
  } catch (error) {
    if (!(error instanceof TerminalInputCancelledError)) throw error;
  }
}
