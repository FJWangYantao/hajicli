/**
 * 危险等级分类。
 * safe: 无风险
 * low: 低风险（常见构建/常规代码修改）
 * medium: 中风险（批量修改或有潜在副作用命令）
 * high: 高风险（破坏性文件删除/破坏配置/提权）
 * critical: 极危险（删系统/隐蔽远程注入脚本）
 */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/**
 * 危险等级的数值权重映射，用于与阈值做对比。
 */
export const RISK_WEIGHTS: Record<RiskLevel, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

/**
 * 安全评估请求参数。
 */
export interface SecurityAssessOptions {
  toolName: string;
  args: Record<string, unknown>;
  userIntent?: string;
  riskThreshold?: RiskLevel;
}

/**
 * 安全评估输出结果。
 */
export interface SecurityAssessment {
  isSafe: boolean;
  riskLevel: RiskLevel;
  reason?: string;
}

/**
 * 安全分类器类。
 * 结合内置风险规则与参数意图分析，评估当前工具调用的危险等级。
 */
export class SecurityClassifier {
  /**
   * 评估给定工具调用的安全性。
   */
  public async assess(options: SecurityAssessOptions): Promise<SecurityAssessment> {
    const { toolName, args, riskThreshold = 'medium' } = options;
    const normTool = toolName.toLowerCase();

    let riskLevel: RiskLevel = 'low';
    let reason = '';

    if (normTool === 'bash') {
      const command = String(args.command || '');
      const bashResult = this.analyzeBashCommand(command);
      riskLevel = bashResult.riskLevel;
      reason = bashResult.reason;
    } else if (normTool === 'write_file' || normTool === 'write' || normTool === 'edit_file' || normTool === 'edit') {
      const filePath = String(args.path || args.targetFile || '');
      const editResult = this.analyzeFileEdit(filePath);
      riskLevel = editResult.riskLevel;
      reason = editResult.reason;
    }

    const currentWeight = RISK_WEIGHTS[riskLevel];
    const thresholdWeight = RISK_WEIGHTS[riskThreshold];
    const isSafe = currentWeight <= thresholdWeight;

    return {
      isSafe,
      riskLevel,
      reason: isSafe ? undefined : (reason || `命令风险等级为 ${riskLevel}，高于允许的最高阈值 ${riskThreshold}`)
    };
  }

  /**
   * 分析 Bash 命令行中的潜在危险性。
   */
  private analyzeBashCommand(command: string): { riskLevel: RiskLevel; reason: string } {
    const cmd = command.trim();

    // 极端危险指令检测
    if (/rm\s+-rf\s+(\/|~|\/\*)/.test(cmd) || /:\(\)\{\s*:\|:&\s*\};:/.test(cmd) || /mkfs|format\s+[c-z]:/i.test(cmd)) {
      return { riskLevel: 'critical', reason: '检测到极端破坏性系统命令（如系统级强制递归删除或格式化）' };
    }

    // 远程管道注入执行检测
    if (/(curl|wget).+\|\s*(sh|bash)/.test(cmd)) {
      return { riskLevel: 'critical', reason: '检测到从网络下载并直接通过 Shell 执行隐蔽脚本的操作' };
    }

    // 高风险操作（破坏性 git 清理、提权或系统路径修改）
    if (/rm\s+-rf/.test(cmd) || /git\s+reset\s+--hard/.test(cmd) || /git\s+clean\s+-f/.test(cmd)) {
      return { riskLevel: 'high', reason: '检测到强制文件批量删除或不可逆的代码仓库强行重置操作' };
    }

    if (/chmod\s+777|chown\s+root|sudo\s+/.test(cmd)) {
      return { riskLevel: 'high', reason: '检测到提权或系统级权限变更操作' };
    }

    // 中风险操作（如普通文件删除、包安装等）
    if (/rm\s+/.test(cmd) || /npm\s+install|yarn\s+add|pnpm\s+add/.test(cmd)) {
      return { riskLevel: 'medium', reason: '包含依赖安装或单文件删除操作' };
    }

    // 常规测试/构建/日志查询为低风险
    return { riskLevel: 'low', reason: '常规安全的终端命令行' };
  }

  /**
   * 分析文件修改路径中的潜在危险性。
   */
  private analyzeFileEdit(filePath: string): { riskLevel: RiskLevel; reason: string } {
    const pathLower = filePath.toLowerCase();

    // 敏感环境/秘钥配置文件修改
    if (pathLower.includes('.env') || pathLower.includes('.ssh') || pathLower.includes('id_rsa')) {
      return { riskLevel: 'high', reason: '涉及修改环境变量或 SSH 秘钥等敏感配置文件' };
    }

    // 系统底层路径覆盖
    if (pathLower.startsWith('/etc/') || pathLower.startsWith('c:\\windows')) {
      return { riskLevel: 'high', reason: '涉及修改操作系统核心系统目录下的文件' };
    }

    return { riskLevel: 'low', reason: '普通项目工程源码文件操作' };
  }
}
