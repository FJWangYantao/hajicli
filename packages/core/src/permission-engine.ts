import { HajiError } from './types.js';
import { SecurityClassifier, RiskLevel, SecurityAssessment } from './security-classifier.js';

/**
 * 权限控制模式。
 * - default: 只读自动批，编辑和脚本交互需要审批
 * - accept-edit: 在 default 基础上，文件 write/edit 默认自动通过，bash 需要审批
 * - auto: 分类器结合用户意图与危险阈值自动评估安全性，若不安全则拒绝并输出理由给 Runtime
 * - bypass-permissions: 全信任模式，不做任何审批
 */
export type PermissionMode = 'default' | 'accept-edit' | 'auto' | 'bypass-permissions';

/**
 * 权限模式列表与中文描述。
 */
export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: 'default', label: 'Default', description: '只读命令自动通过，编辑/脚本需要审批' },
  { value: 'accept-edit', label: 'Accept Edit', description: '只读与文件编辑自动通过，bash 脚本需要审批' },
  { value: 'auto', label: 'Auto Classifier', description: 'AI 分类器判定危险等级，不安全命令拒绝并提示修正' },
  { value: 'bypass-permissions', label: 'Bypass Permissions', description: '全信任模式，接受所有命令无需审批' }
];

/**
 * 校验输入字符串是否为有效的权限模式。
 */
export function isPermissionMode(mode: string | undefined): mode is PermissionMode {
  return Boolean(mode && PERMISSION_MODES.some(m => m.value === mode));
}

/**
 * 权限检查动作。
 * - allow: 直接批准执行
 * - prompt: 弹窗/终端询问用户授权
 * - deny: 自动拒绝执行
 */
export type PermissionAction = 'allow' | 'prompt' | 'deny';

/**
 * 权限评估结果接口。
 */
export interface PermissionCheckResult {
  action: PermissionAction;
  reason?: string;
  riskLevel?: RiskLevel;
}

/**
 * 权限评估参数接口。
 */
export interface PermissionEvaluateOptions {
  mode: PermissionMode;
  toolName: string;
  args: Record<string, unknown>;
  userIntent?: string;
  riskThreshold?: RiskLevel;
}

/**
 * 权限引擎错误。
 */
export class PermissionError extends HajiError {
  constructor(message: string) {
    super(message, 'PERMISSION_ERROR');
    this.name = 'PermissionError';
  }
}

/**
 * 核心权限引擎类。
 */
export class PermissionEngine {
  private classifier: SecurityClassifier;

  constructor() {
    this.classifier = new SecurityClassifier();
  }

  /**
   * 判断给定的工具是否属于只读类型。
   */
  public isReadOnlyTool(toolName: string): boolean {
    const readOnlyTools = [
      'read_file',
      'read',
      'grep_search',
      'grep',
      'global_find_files',
      'find_files',
      'web_search',
      'web_fetch'
    ];
    return readOnlyTools.includes(toolName.toLowerCase());
  }

  /**
   * 判断给定的工具是否属于文件编辑类型。
   */
  public isEditTool(toolName: string): boolean {
    const editTools = ['write_file', 'write', 'edit_file', 'edit'];
    return editTools.includes(toolName.toLowerCase());
  }

  /**
   * 根据当前权限模式和工具入参，评估工具调用的处理动作。
   */
  public async evaluate(options: PermissionEvaluateOptions): Promise<PermissionCheckResult> {
    const { mode, toolName, args, userIntent = '', riskThreshold = 'medium' } = options;

    // 1. Bypass Permissions 模式：无条件全部允许
    if (mode === 'bypass-permissions') {
      return { action: 'allow', riskLevel: 'safe' };
    }

    // 2. 只读型工具：在任何模式下均自动允许
    if (this.isReadOnlyTool(toolName)) {
      return { action: 'allow', riskLevel: 'safe' };
    }

    // 3. Accept Edit 模式：编辑工具自动允许，脚本等需要审批
    if (mode === 'accept-edit') {
      if (this.isEditTool(toolName)) {
        return { action: 'allow', riskLevel: 'low' };
      }
      return { action: 'prompt', riskLevel: 'medium', reason: '命令需用户手动确认授权' };
    }

    // 4. Default 模式：编辑和脚本都需要人工审批
    if (mode === 'default') {
      return { action: 'prompt', riskLevel: 'medium', reason: '修改型工具需用户手动确认授权' };
    }

    // 5. Auto 模式：调起 SecurityClassifier 动态分析
    if (mode === 'auto') {
      const assessment: SecurityAssessment = await this.classifier.assess({
        toolName,
        args,
        userIntent,
        riskThreshold
      });

      if (assessment.isSafe) {
        return {
          action: 'allow',
          riskLevel: assessment.riskLevel
        };
      }

      return {
        action: 'deny',
        riskLevel: assessment.riskLevel,
        reason: assessment.reason || '分类器检测到该操作超出允许的安全风险阈值'
      };
    }

    return { action: 'prompt', riskLevel: 'medium' };
  }
}
