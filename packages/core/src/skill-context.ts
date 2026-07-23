import { ChatMessage } from './types.js';
import { SkillActivation, SkillSource } from './skill-types.js';

export const SKILL_LOAD_MARKER = '[HAJI_SKILL_LOADED]';
export const SKILL_ALREADY_LOADED_MARKER = '[HAJI_SKILL_ALREADY_LOADED]';
export const SKILL_CONTEXT_START = '[HAJI_ACTIVE_SKILLS_START]';
export const SKILL_CONTEXT_END = '[HAJI_ACTIVE_SKILLS_END]';

function parseActivation(value: string): SkillActivation | null {
  try {
    const parsed = JSON.parse(value) as Partial<SkillActivation>;
    if (!parsed.name || !parsed.contentHash || !['user', 'project'].includes(String(parsed.source))) return null;
    return {
      name: String(parsed.name),
      source: parsed.source as SkillSource,
      contentHash: String(parsed.contentHash),
      loadedAt: typeof parsed.loadedAt === 'string' ? parsed.loadedAt : new Date(0).toISOString()
    };
  } catch {
    return null;
  }
}

export function stripSkillActivationContext(content: string): string {
  const start = content.indexOf(SKILL_CONTEXT_START);
  if (start < 0) return content;
  const end = content.indexOf(SKILL_CONTEXT_END, start);
  const before = content.slice(0, start).trimEnd();
  const after = end < 0 ? '' : content.slice(end + SKILL_CONTEXT_END.length).trimStart();
  return [before, after].filter(Boolean).join('\n\n');
}

export function extractSkillActivations(messages: ChatMessage[]): Array<SkillActivation & { resident: boolean }> {
  const found = new Map<string, SkillActivation & { resident: boolean }>();
  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    if (message.role === 'system') {
      let cursor = 0;
      while (true) {
        const start = message.content.indexOf(SKILL_CONTEXT_START, cursor);
        if (start < 0) break;
        const end = message.content.indexOf(SKILL_CONTEXT_END, start);
        if (end < 0) break;
        const body = message.content.slice(start + SKILL_CONTEXT_START.length, end);
        for (const line of body.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
          const activation = parseActivation(line);
          if (activation) found.set(activation.name, { ...activation, resident: false });
        }
        cursor = end + SKILL_CONTEXT_END.length;
      }
    }
    if (message.role === 'tool' && message.content.startsWith(`${SKILL_LOAD_MARKER} `)) {
      const firstLine = message.content.split(/\r?\n/, 1)[0];
      const activation = parseActivation(firstLine.slice(SKILL_LOAD_MARKER.length).trim());
      if (activation) found.set(activation.name, { ...activation, resident: true });
    }
  }
  return [...found.values()];
}

export function formatSkillActivationContext(messages: ChatMessage[]): string {
  const activations = extractSkillActivations(messages);
  if (activations.length === 0) return '';
  return [
    SKILL_CONTEXT_START,
    ...activations.map(({ resident: _resident, ...activation }) => JSON.stringify(activation)),
    '以上技能内容若已被压缩移除，当前任务仍需要时请重新调用 loadskill。',
    SKILL_CONTEXT_END
  ].join('\n');
}
