import {
  MAX_SUBAGENT_MAX_TOKENS,
  MAX_SUBAGENT_MAX_TOOL_CALLS,
  MAX_SUBAGENT_INSTRUCTIONS_LENGTH,
  MIN_SUBAGENT_MAX_TOKENS,
  MIN_SUBAGENT_MAX_TOOL_CALLS,
  isReasoningEffort,
  ReasoningEffort,
  SubagentRole
} from '@hajicli/core';

export interface ParsedSubagentCommand {
  background: boolean;
  role: SubagentRole;
  taskId?: string;
  model?: string;
  provider?: 'deepseek' | 'volcengine';
  reasoningEffort?: ReasoningEffort;
  instructions?: string;
  timeoutMs?: number;
  maxTokens?: number;
  maxToolCalls?: number;
  description: string;
}

function extractOption(source: string, name: string): { source: string; value?: string } {
  const marker = `--${name}`;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index <= source.length - marker.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (source.slice(index, index + marker.length).toLowerCase() !== marker.toLowerCase()) continue;
    if (index > 0 && !/\s/.test(source[index - 1])) continue;
    const separator = source[index + marker.length];
    if (separator !== '=' && !/\s/.test(separator || '')) continue;

    let valueStart = index + marker.length + 1;
    if (separator !== '=') {
      while (/\s/.test(source[valueStart] || '')) valueStart += 1;
    }
    const valueQuote = source[valueStart] === '"' || source[valueStart] === "'"
      ? source[valueStart] as '"' | "'"
      : undefined;
    if (valueQuote) valueStart += 1;
    let valueEnd = valueStart;
    if (valueQuote) {
      while (valueEnd < source.length && source[valueEnd] !== valueQuote) valueEnd += 1;
    } else {
      while (valueEnd < source.length && !/\s/.test(source[valueEnd])) valueEnd += 1;
    }
    const value = source.slice(valueStart, valueEnd);
    const removalEnd = valueQuote && source[valueEnd] === valueQuote ? valueEnd + 1 : valueEnd;
    return {
      source: `${source.slice(0, index)} ${source.slice(removalEnd)}`.trim(),
      value
    };
  }
  return { source };
}

/** Parses the deterministic /subagent command and its optional resource limits. */
export function parseSubagentCommand(raw: string): ParsedSubagentCommand {
  let remaining = raw.trim();
  let background = false;
  let role: SubagentRole = 'research';
  let taskId: string | undefined;
  let model: string | undefined;
  let provider: 'deepseek' | 'volcengine' | undefined;
  let reasoningEffort: ReasoningEffort | undefined;
  let instructions: string | undefined;
  let timeoutMs: number | undefined;
  let maxTokens: number | undefined;
  let maxToolCalls: number | undefined;

  const bg = remaining.match(/^bg(?:\s+|$)/i);
  if (bg) {
    background = true;
    remaining = remaining.slice(bg[0].length).trim();
  }
  const roleMatch = remaining.match(/^(research|review|implement)(?:\s+|$)/i);
  if (roleMatch) {
    role = roleMatch[1].toLowerCase() as SubagentRole;
    remaining = remaining.slice(roleMatch[0].length).trim();
  }
  const taskMatch = remaining.match(/(?:^|\s)--task(?:=|\s+)([^\s]+)(?:\s|$)/i);
  if (taskMatch) {
    taskId = taskMatch[1].replace(/^['"]|['"]$/g, '');
    remaining = `${remaining.slice(0, taskMatch.index)} ${remaining.slice((taskMatch.index || 0) + taskMatch[0].length)}`.trim();
  }

  const modelOption = extractOption(remaining, 'model');
  remaining = modelOption.source;
  if (modelOption.value !== undefined) {
    model = modelOption.value.trim();
    if (!model) throw new Error('--model 不能为空');
  }

  const providerOption = extractOption(remaining, 'provider');
  remaining = providerOption.source;
  if (providerOption.value !== undefined) {
    const value = providerOption.value.trim().toLowerCase();
    if (!['deepseek', 'volcengine'].includes(value)) {
      throw new Error('--provider 必须是 deepseek 或 volcengine');
    }
    provider = value as 'deepseek' | 'volcengine';
  }

  const effortOption = extractOption(remaining, 'effort');
  remaining = effortOption.source;
  if (effortOption.value !== undefined) {
    const value = effortOption.value.trim().toLowerCase();
    if (!isReasoningEffort(value)) {
      throw new Error('--effort 必须是 low、medium、high、xhigh 或 max');
    }
    reasoningEffort = value;
  }

  const instructionsOption = extractOption(remaining, 'instructions');
  remaining = instructionsOption.source;
  if (instructionsOption.value !== undefined) {
    instructions = instructionsOption.value.trim();
    if (!instructions || instructions.length > MAX_SUBAGENT_INSTRUCTIONS_LENGTH) {
      throw new Error(`--instructions 长度必须是 1 到 ${MAX_SUBAGENT_INSTRUCTIONS_LENGTH} 个字符`);
    }
  }

  const timeoutMatch = remaining.match(/(?:^|\s)--timeout-ms(?:=|\s+)([^\s]+)(?:\s|$)/i);
  if (timeoutMatch) {
    timeoutMs = Number(timeoutMatch[1]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) {
      throw new Error('--timeout-ms 必须是 100 到 3600000 之间的整数');
    }
    remaining = `${remaining.slice(0, timeoutMatch.index)} ${remaining.slice((timeoutMatch.index || 0) + timeoutMatch[0].length)}`.trim();
  }

  const maxTokensMatch = remaining.match(/(?:^|\s)--max-tokens(?:=|\s+)([^\s]+)(?:\s|$)/i);
  if (maxTokensMatch) {
    maxTokens = Number(maxTokensMatch[1]);
    if (!Number.isInteger(maxTokens) || maxTokens < MIN_SUBAGENT_MAX_TOKENS || maxTokens > MAX_SUBAGENT_MAX_TOKENS) {
      throw new Error(`--max-tokens 必须是 ${MIN_SUBAGENT_MAX_TOKENS} 到 ${MAX_SUBAGENT_MAX_TOKENS} 之间的整数`);
    }
    remaining = `${remaining.slice(0, maxTokensMatch.index)} ${remaining.slice((maxTokensMatch.index || 0) + maxTokensMatch[0].length)}`.trim();
  }

  const maxToolCallsMatch = remaining.match(/(?:^|\s)--max-tool-calls(?:=|\s+)([^\s]+)(?:\s|$)/i);
  if (maxToolCallsMatch) {
    maxToolCalls = Number(maxToolCallsMatch[1]);
    if (!Number.isInteger(maxToolCalls) || maxToolCalls < MIN_SUBAGENT_MAX_TOOL_CALLS || maxToolCalls > MAX_SUBAGENT_MAX_TOOL_CALLS) {
      throw new Error(`--max-tool-calls 必须是 ${MIN_SUBAGENT_MAX_TOOL_CALLS} 到 ${MAX_SUBAGENT_MAX_TOOL_CALLS} 之间的整数`);
    }
    remaining = `${remaining.slice(0, maxToolCallsMatch.index)} ${remaining.slice((maxToolCallsMatch.index || 0) + maxToolCallsMatch[0].length)}`.trim();
  }

  return {
    background,
    role,
    taskId,
    timeoutMs,
    maxTokens,
    maxToolCalls,
    description: remaining,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(instructions ? { instructions } : {})
  };
}

export function formatAgentTokens(totalTokens: number): string {
  if (totalTokens < 1000) return `${totalTokens}`;
  return `${(totalTokens / 1000).toFixed(totalTokens < 10000 ? 1 : 0)}k`;
}
