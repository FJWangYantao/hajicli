import { SubagentRole } from '@hajicli/core';

export interface ParsedSubagentCommand {
  background: boolean;
  role: SubagentRole;
  taskId?: string;
  timeoutMs?: number;
  description: string;
}

/** Parses: /subagent [bg] [research|review|implement] [--task id] [--timeout-ms n] <description>. */
export function parseSubagentCommand(raw: string): ParsedSubagentCommand {
  let remaining = raw.trim();
  let background = false;
  let role: SubagentRole = 'research';
  let taskId: string | undefined;
  let timeoutMs: number | undefined;

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

  const timeoutMatch = remaining.match(/(?:^|\s)--timeout-ms(?:=|\s+)([^\s]+)(?:\s|$)/i);
  if (timeoutMatch) {
    timeoutMs = Number(timeoutMatch[1]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) {
      throw new Error('--timeout-ms 必须是 100 到 3600000 之间的整数');
    }
    remaining = `${remaining.slice(0, timeoutMatch.index)} ${remaining.slice((timeoutMatch.index || 0) + timeoutMatch[0].length)}`.trim();
  }

  return { background, role, taskId, timeoutMs, description: remaining };
}

export function formatAgentTokens(totalTokens: number): string {
  if (totalTokens < 1000) return `${totalTokens}`;
  return `${(totalTokens / 1000).toFixed(totalTokens < 10000 ? 1 : 0)}k`;
}
