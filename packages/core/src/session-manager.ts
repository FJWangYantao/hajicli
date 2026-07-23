import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ChatMessage } from './types.js';
import { performanceMonitor } from './performance-monitor.js';

const SESSION_FLUSH_DELAY_MS = 120;

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

interface PendingSessionWrite {
  session?: StoredSession;
  remove?: boolean;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    tool_calls: message.tool_calls?.map(toolCall => ({
      ...toolCall,
      function: { ...toolCall.function }
    }))
  };
}

function sameMessages(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const candidate = right[index];
    if (!candidate
      || message.role !== candidate.role
      || message.content !== candidate.content
      || message.reasoning_content !== candidate.reasoning_content
      || message.snapshotId !== candidate.snapshotId
      || message.tool_call_id !== candidate.tool_call_id) return false;
    const leftCalls = message.tool_calls || [];
    const rightCalls = candidate.tool_calls || [];
    return leftCalls.length === rightCalls.length && leftCalls.every((toolCall, toolIndex) => {
      const other = rightCalls[toolIndex];
      return Boolean(other
        && toolCall.id === other.id
        && toolCall.type === other.type
        && toolCall.function.name === other.function.name
        && toolCall.function.arguments === other.function.arguments);
    });
  });
}

async function replaceFile(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(source, target);
  } catch {
    await fs.promises.copyFile(source, target);
    await fs.promises.rm(source, { force: true });
  }
}

/** In-memory session state with debounced, atomic background persistence. */
export class SessionManager {
  private readonly sessionsDir: string;
  private currentSession: StoredSession;
  private lastQueuedMessages: ChatMessage[] = [];
  private lastQueuedTitle = '';
  private readonly pendingWrites = new Map<string, PendingSessionWrite>();
  private writeChain: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(sessionsDir = path.join(process.cwd(), '.haji', 'sessions')) {
    this.sessionsDir = sessionsDir;
    const now = new Date().toISOString();
    this.currentSession = {
      id: crypto.randomUUID(),
      title: '新对话会话',
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this.ensureDir();
  }

  private ensureDir(): void {
    try { fs.mkdirSync(this.sessionsDir, { recursive: true }); } catch {}
  }

  private getSessionPath(id: string): string {
    return path.join(this.sessionsDir, `session_${id}.json`);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, SESSION_FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  public hasEffectiveMessages(messages: ChatMessage[] = []): boolean {
    return messages.some(message => message.role === 'user' || message.role === 'assistant');
  }

  public getCurrentSession(): StoredSession {
    return this.currentSession;
  }

  /** Updates memory immediately and coalesces disk writes for the same session. */
  public saveCurrentSession(messages: ChatMessage[], title?: string): void {
    if (title) this.currentSession.title = title;

    const unchanged = this.lastQueuedTitle === this.currentSession.title
      && sameMessages(this.lastQueuedMessages, messages);
    if (unchanged) return;

    this.currentSession.messages = messages;
    this.currentSession.updatedAt = new Date().toISOString();
    const filePath = this.getSessionPath(this.currentSession.id);

    if (!this.hasEffectiveMessages(messages)) {
      this.pendingWrites.set(filePath, { remove: true });
    } else {
      this.pendingWrites.set(filePath, {
        session: {
          ...this.currentSession,
          messages: messages.map(cloneMessage)
        }
      });
    }

    this.lastQueuedMessages = messages.map(cloneMessage);
    this.lastQueuedTitle = this.currentSession.title;
    this.scheduleFlush();
  }

  /** Forces all coalesced writes to disk; call before resume/list/exit boundaries. */
  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const operations = [...this.pendingWrites.entries()];
    this.pendingWrites.clear();
    if (operations.length > 0) {
      this.writeChain = this.writeChain.then(async () => {
        const startedAt = performance.now();
        await fs.promises.mkdir(this.sessionsDir, { recursive: true });
        for (const [filePath, operation] of operations) {
          if (operation.remove) {
            await fs.promises.rm(filePath, { force: true });
            continue;
          }
          if (!operation.session) continue;
          const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
          await fs.promises.writeFile(tempPath, JSON.stringify(operation.session, null, 2), 'utf8');
          await replaceFile(tempPath, filePath);
        }
        performanceMonitor.record('session.flush', performance.now() - startedAt);
      }).catch(() => {});
    }
    await this.writeChain;
    if (this.pendingWrites.size > 0) await this.flush();
  }

  public loadSession(id: string): StoredSession | null {
    try {
      const filePath = this.getSessionPath(id);
      if (!fs.existsSync(filePath)) return null;
      const session = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredSession;
      this.currentSession = session;
      this.lastQueuedMessages = session.messages.map(cloneMessage);
      this.lastQueuedTitle = session.title;
      return session;
    } catch {
      return null;
    }
  }

  public listSessions(): StoredSession[] {
    try {
      this.ensureDir();
      const files = fs.readdirSync(this.sessionsDir).filter(file => file.startsWith('session_') && file.endsWith('.json'));
      const sessions: StoredSession[] = [];
      for (const file of files) {
        const filePath = path.join(this.sessionsDir, file);
        try {
          const session = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredSession;
          if (session?.id && this.hasEffectiveMessages(session.messages)) {
            sessions.push(session);
          } else if (session && (!session.messages || !this.hasEffectiveMessages(session.messages))) {
            try { fs.unlinkSync(filePath); } catch {}
          }
        } catch {}
      }
      return sessions.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    } catch {
      return [];
    }
  }

  public startNewSession(): StoredSession {
    const now = new Date().toISOString();
    this.currentSession = {
      id: crypto.randomUUID(),
      title: '新对话会话',
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this.lastQueuedMessages = [];
    this.lastQueuedTitle = '';
    return this.currentSession;
  }

  public async generateTitleAsync(
    firstUserMsg: string,
    titleSummarizer?: (prompt: string) => Promise<string>
  ): Promise<string> {
    const defaultTitle = firstUserMsg.length > 25 ? `${firstUserMsg.slice(0, 25)}...` : firstUserMsg;
    if (!titleSummarizer) {
      this.currentSession.title = defaultTitle;
      this.saveCurrentSession(this.currentSession.messages);
      return defaultTitle;
    }

    try {
      const prompt = `请针对以下用户的第一条需求，总结出一个 10 以内的简短形象标题。注意：直接回答标题本身，不要包含任何标点符号、解释或多余字符。\n\n需求：${firstUserMsg}`;
      const generated = await titleSummarizer(prompt);
      const cleanTitle = generated.trim().replace(/^["'《]+|["'》]+$/g, '').slice(0, 20) || defaultTitle;
      this.currentSession.title = cleanTitle;
      this.saveCurrentSession(this.currentSession.messages);
      return cleanTitle;
    } catch {
      this.currentSession.title = defaultTitle;
      this.saveCurrentSession(this.currentSession.messages);
      return defaultTitle;
    }
  }
}
