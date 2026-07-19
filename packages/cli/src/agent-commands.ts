import { SubagentRole } from '@hajicli/core';

export interface ParsedSubagentCommand {
  background: boolean;
  role: SubagentRole;
  taskId?: string;
  description: string;
}

/** Parses: /subagent [bg] [research|review|implement] [--task id] <description>. */
export function parseSubagentCommand(raw: string): ParsedSubagentCommand {
  let remaining = raw.trim();
  let background = false;
  let role: SubagentRole = 'research';
  let taskId: string | undefined;

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

  return { background, role, taskId, description: remaining };
}

export function formatAgentTokens(totalTokens: number): string {
  if (totalTokens < 1000) return `${totalTokens}`;
  return `${(totalTokens / 1000).toFixed(totalTokens < 10000 ? 1 : 0)}k`;
}
