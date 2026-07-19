import fs from 'node:fs';
import path from 'node:path';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type TaskAgentStatus = 'running' | 'awaiting_verification' | 'verified' | 'rejected' | 'failed' | 'aborted';

export interface TaskAgentState {
  id: string;
  role: string;
  status: TaskAgentStatus;
  summary?: string;
}

export interface TaskItem {
  id: string;
  content: string;
  status: TaskStatus;
  blockedBy: string[];
  verification?: string;
  agent?: TaskAgentState;
}

export interface TaskPlan {
  title: string;
  tasks: TaskItem[];
  completedTasks: TaskItem[];
  updatedAt: string;
}

/** 按会话隔离持久化任务计划。 */
export class TaskStore {
  private scope = 'default';

  constructor(private readonly tasksDir = path.join(process.cwd(), '.haji', 'tasks')) {}

  setTaskScope(scope: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new Error('无效的任务作用域');
    this.scope = scope;
  }

  getPlan(): TaskPlan | null {
    try {
      const filePath = this.getFilePath();
      if (!fs.existsSync(filePath)) return null;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<TaskPlan> & { summary?: string };
      const migrated: TaskPlan = {
        title: String(raw.title || raw.summary || ''),
        tasks: Array.isArray(raw.tasks) ? raw.tasks.map(task => this.normalizeTask(task as TaskItem)) : [],
        completedTasks: Array.isArray(raw.completedTasks)
          ? raw.completedTasks.map(task => this.normalizeTask(task as TaskItem))
          : [],
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
      };
      return migrated.title ? migrated : null;
    } catch {
      return null;
    }
  }

  createTask(input: { id: string; content: string; title?: string; blockedBy?: string[] }): TaskPlan {
    const id = input.id.trim();
    const content = input.content.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`无效任务 ID: ${id}`);
    if (!content) throw new Error('任务内容不能为空');

    const current = this.getPlan();
    const title = input.title?.trim() || current?.title || '';
    if (!title) throw new Error('创建第一条任务时必须提供计划总标题 title');
    if (title.length > 12) throw new Error('计划标题最多 12 个字符，请只保留核心目标');
    const tasks = current?.tasks || [];
    const completedTasks = current?.completedTasks || [];
    if ([...tasks, ...completedTasks].some(task => task.id === id)) throw new Error(`任务 ID 重复: ${id}`);

    const blockedBy = [...new Set((input.blockedBy || []).map(value => value.trim()).filter(Boolean))];
    for (const dependency of blockedBy) {
      if (![...tasks, ...completedTasks].some(task => task.id === dependency)) {
        throw new Error(`依赖任务不存在: ${dependency}`);
      }
    }
    const plan: TaskPlan = {
      title,
      tasks: [...tasks, { id, content, status: 'pending', blockedBy }],
      completedTasks,
      updatedAt: new Date().toISOString()
    };
    this.writePlan(plan);
    return plan;
  }

  updateTask(taskId: string, updates: { status?: TaskStatus; content?: string; blockedBy?: string[] }): TaskPlan {
    const plan = this.requirePlan();
    const task = plan.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`活动任务不存在: ${taskId}`);
    if (updates.content !== undefined) {
      const content = updates.content.trim();
      if (!content) throw new Error('任务内容不能为空');
      task.content = content;
    }
    if (updates.blockedBy !== undefined) {
      task.blockedBy = [...new Set(updates.blockedBy.map(value => value.trim()).filter(Boolean))];
    }
    if (updates.status !== undefined) {
      if (!['pending', 'in_progress'].includes(updates.status)) {
        throw new Error('完成任务必须调用 taskfinish 并提供验证结果');
      }
      if (updates.status === 'in_progress') {
        const activeIds = new Set(plan.tasks.map(item => item.id));
        const blockers = task.blockedBy.filter(id => activeIds.has(id));
        if (blockers.length > 0) throw new Error(`任务仍被阻塞: ${blockers.join(', ')}`);
      }
      task.status = updates.status;
    }
    plan.updatedAt = new Date().toISOString();
    this.writePlan(plan);
    return plan;
  }

  finishTask(taskId: string, verification: string): { plan: TaskPlan; finished: TaskItem; allDone: boolean } {
    const verified = verification.trim();
    if (!verified) throw new Error('taskfinish 必须提供实际验证结果');
    const plan = this.requirePlan();
    const index = plan.tasks.findIndex(item => item.id === taskId);
    if (index < 0) throw new Error(`活动任务不存在: ${taskId}`);
    const task = plan.tasks[index];
    if (task.status !== 'in_progress') throw new Error('任务必须先更新为 in_progress');
    if (task.agent && task.agent.status !== 'verified') {
      throw new Error(`关联子代理 ${task.agent.id} 尚未通过父 Agent 独立验证`);
    }
    const dependents = plan.tasks.filter(item => item.blockedBy.includes(taskId));
    const finished: TaskItem = { ...task, status: 'completed', verification: verified };
    plan.tasks.splice(index, 1);
    for (const dependent of dependents) {
      dependent.blockedBy = dependent.blockedBy.filter(id => id !== taskId);
    }
    plan.completedTasks.push(finished);
    plan.updatedAt = new Date().toISOString();
    this.writePlan(plan);
    return { plan, finished, allDone: plan.tasks.length === 0 };
  }

  setTaskAgent(taskId: string, agent?: TaskAgentState): TaskPlan {
    const plan = this.requirePlan();
    const task = plan.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`活动任务不存在: ${taskId}`);
    task.agent = agent ? { ...agent } : undefined;
    plan.updatedAt = new Date().toISOString();
    this.writePlan(plan);
    return plan;
  }

  clearTasks(): void {
    try { fs.rmSync(this.getFilePath(), { force: true }); } catch {}
  }

  private requirePlan(): TaskPlan {
    const plan = this.getPlan();
    if (!plan) throw new Error('当前会话没有计划');
    return plan;
  }

  private normalizeTask(task: TaskItem): TaskItem {
    return {
      id: String(task.id || ''),
      content: String(task.content || ''),
      status: ['pending', 'in_progress', 'completed'].includes(task.status) ? task.status : 'pending',
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
      verification: typeof task.verification === 'string' ? task.verification : undefined,
      agent: task.agent && typeof task.agent === 'object'
        ? {
            id: String(task.agent.id || ''),
            role: String(task.agent.role || 'general'),
            status: ['running', 'awaiting_verification', 'verified', 'rejected', 'failed', 'aborted'].includes(task.agent.status)
              ? task.agent.status
              : 'failed',
            summary: typeof task.agent.summary === 'string' ? task.agent.summary : undefined
          }
        : undefined
    };
  }

  private writePlan(plan: TaskPlan): void {
    fs.mkdirSync(this.tasksDir, { recursive: true });
    fs.writeFileSync(this.getFilePath(), JSON.stringify(plan, null, 2), 'utf8');
  }

  private getFilePath(): string {
    return path.join(this.tasksDir, `${this.scope}.json`);
  }
}
