import { BaseTool, TaskStatus, TaskStore, ToolDefinition } from '@hajicli/core';

export const PLAN_READY_MARKER = '[PLAN_READY]';
export const ALL_TASKS_COMPLETE_MARKER = '[ALL_TASKS_COMPLETE]';

abstract class StoredTaskTool implements BaseTool {
  abstract readonly name: string;
  abstract readonly definition: ToolDefinition;
  constructor(protected readonly store: TaskStore) {}
  abstract execute(args: Record<string, unknown>): Promise<string>;
  protected error(error: unknown): string {
    return `错误: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export class TaskCreateTool extends StoredTaskTool {
  readonly name = 'taskcreate';
  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'taskcreate',
      description: '逐条创建计划任务。第一条提供简短总标题（优先 4-8 个汉字，最多 12 个字符）；最后一条设置 finalize=true 触发用户审批。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 12, description: '简短总标题，第一条必填；只写核心目标，不加项目名或“计划”等后缀' },
          id: { type: 'string', description: '稳定且唯一的任务 ID' },
          content: { type: 'string', description: '具体、可验证的任务内容' },
          blockedBy: { type: 'array', items: { type: 'string' }, description: '前置任务 ID 列表' },
          finalize: { type: 'boolean', description: '是否已创建最后一条任务并提交审批' }
        },
        required: ['id', 'content']
      }
    }
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const plan = this.store.createTask({
        title: typeof args.title === 'string' ? args.title : undefined,
        id: String(args.id || ''),
        content: String(args.content || ''),
        blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : []
      });
      return `${args.finalize === true ? `${PLAN_READY_MARKER}\n` : ''}已创建任务 ${String(args.id)}（${plan.tasks.length} 条待执行）`;
    } catch (error) { return this.error(error); }
  }
}

export class TaskListTool extends StoredTaskTool {
  readonly name = 'tasklist';
  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'tasklist',
      description: '读取当前会话的计划、活动任务、依赖和已验证任务。',
      parameters: { type: 'object', properties: {} }
    }
  };
  async execute(): Promise<string> {
    return JSON.stringify(this.store.getPlan() || { title: '', tasks: [], completedTasks: [] }, null, 2);
  }
}

export class UpdateTaskTool extends StoredTaskTool {
  readonly name = 'updatetask';
  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'updatetask',
      description: '更新活动任务的内容、依赖或执行状态。执行任务前将其设为 in_progress。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress'] },
          content: { type: 'string' },
          blockedBy: { type: 'array', items: { type: 'string' } }
        },
        required: ['taskId']
      }
    }
  };
  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const plan = this.store.updateTask(String(args.taskId || ''), {
        status: typeof args.status === 'string' ? args.status as TaskStatus : undefined,
        content: typeof args.content === 'string' ? args.content : undefined,
        blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : undefined
      });
      return `任务已更新\n${JSON.stringify(plan, null, 2)}`;
    } catch (error) { return this.error(error); }
  }
}

export class TaskFinishTool extends StoredTaskTool {
  readonly name = 'taskfinish';
  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'taskfinish',
      description: '在完成实际验证后结束并移除一条活动任务。所有任务完成后必须进行一次总验证。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          verification: { type: 'string', description: '已实际执行的验证及结果' }
        },
        required: ['taskId', 'verification']
      }
    }
  };
  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const result = this.store.finishTask(String(args.taskId || ''), String(args.verification || ''));
      const marker = result.allDone
        ? `\n${ALL_TASKS_COMPLETE_MARKER}\n所有任务均已完成。现在执行一次覆盖整个改动的总验证，通过后再总结。`
        : '\n请重新检查剩余任务、依赖和计划是否需要更新。';
      return `任务 ${result.finished.id} 已验证并从活动列表移除。${marker}`;
    } catch (error) { return this.error(error); }
  }
}
