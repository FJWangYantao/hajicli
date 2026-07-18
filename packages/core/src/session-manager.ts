import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChatMessage } from './types.js';

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/**
 * 会话持久化与管理模块。
 * 支持会话存盘、离线读取、降序排列及并行异步标题生成。
 */
export class SessionManager {
  private readonly sessionsDir: string;
  private currentSession: StoredSession;

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
    try {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    } catch {}
  }

  /**
   * 判断会话中是否包含有效对话消息（包含至少一条 user 或 assistant 消息）
   */
  public hasEffectiveMessages(messages: ChatMessage[] = []): boolean {
    return messages.some(m => m.role === 'user' || m.role === 'assistant');
  }

  /**
   * 获取当前会话信息
   */
  public getCurrentSession(): StoredSession {
    return this.currentSession;
  }

  /**
   * 更新并持久化当前会话（仅在包含有效消息时存盘，0 条有效消息时清理磁盘空文件）
   */
  public saveCurrentSession(messages: ChatMessage[], title?: string): void {
    this.currentSession.messages = messages;
    this.currentSession.updatedAt = new Date().toISOString();
    if (title) {
      this.currentSession.title = title;
    }

    const filePath = path.join(this.sessionsDir, `session_${this.currentSession.id}.json`);

    // 若无有效对话内容（0 条用户/模型消息），拦截落盘，并清理可能存在的对应磁盘空文件
    if (!this.hasEffectiveMessages(messages)) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {}
      return;
    }

    try {
      this.ensureDir();
      fs.writeFileSync(filePath, JSON.stringify(this.currentSession, null, 2), 'utf-8');
    } catch {}
  }

  /**
   * 恢复并载入指定 ID 的会话
   */
  public loadSession(id: string): StoredSession | null {
    try {
      const filePath = path.join(this.sessionsDir, `session_${id}.json`);
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      const session = JSON.parse(raw) as StoredSession;
      this.currentSession = session;
      return session;
    } catch {
      return null;
    }
  }

  /**
   * 获取所有存盘的有效会话列表，按 updatedAt 最近修改时间降序排列。
   * 自动过滤并清理 0 条有效消息的空会话文件。
   */
  public listSessions(): StoredSession[] {
    try {
      this.ensureDir();
      const files = fs.readdirSync(this.sessionsDir).filter(f => f.startsWith('session_') && f.endsWith('.json'));
      const sessions: StoredSession[] = [];

      for (const file of files) {
        const filePath = path.join(this.sessionsDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const session = JSON.parse(raw) as StoredSession;
          if (session && session.id && this.hasEffectiveMessages(session.messages)) {
            sessions.push(session);
          } else if (session && (!session.messages || !this.hasEffectiveMessages(session.messages))) {
            // 自动清理盘面上残留的 0 条消息的空会话文件
            try {
              fs.unlinkSync(filePath);
            } catch {}
          }
        } catch {}
      }

      // 按 updatedAt 倒序排列（最新修改的在最前）
      return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } catch {
      return [];
    }
  }

  /**
   * 切换至一个全新初始化的会话
   */
  public startNewSession(): StoredSession {
    const now = new Date().toISOString();
    this.currentSession = {
      id: crypto.randomUUID(),
      title: '新对话会话',
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    return this.currentSession;
  }

  /**
   * 并行后台异步生成简短标题
   */
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
