import { getCliVersion } from "./cli-runtime.js";
import { colors } from "./theme.js";

// 像素画风格的大写 HAJI 启动 Logo
export const LOGO = `
${colors.boldPurple("██╗  ██╗  ██████╗      █████╗ ████████╗")}
${colors.boldPurple("██║  ██║ ██╔═══██╗     ╚══██║ ╚══██╔══╝")}
${colors.boldPurple("███████║ ████████║        ██║    ██║   ")}
${colors.boldPurple("██╔══██║ ██╔═══██║   ██   ██║    ██║   ")}
${colors.boldPurple("██║  ██║ ██║   ██║   ╚█████╔╝ ████████╗")}
${colors.boldPurple("╚═╝  ╚═╝ ╚═╝   ╚═╝    ╚════╝  ╚═══════╝")}
`;

/**
 * 处理 `--version/-v` 与 `--help/-h` 启动参数。
 * 命中时打印信息后直接退出进程；未命中返回 false，继续正常启动流程。
 */
export function handleEarlyCliArgs(cliArgs: string[]): boolean {
  if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
    console.log(`haji v${getCliVersion()}`);
    process.exit(0);
  }
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    console.log(`
${colors.boldPurple("HAJI CLI")} - 轻量级终端 AI 辅助编程工具 (v${getCliVersion()})

${colors.bold("用法:")}
  haji [选项]

${colors.bold("选项:")}
  -v, --version       显示版本号
  -h, --help          显示帮助手册

${colors.bold("快捷命令 (对话内):")}
  /help               显示内部帮助
  /subagent           确定性启动前台或后台子代理
  /agents             查看、管理和中止子代理
  /skills             查看 Skill；支持 reload 与 validate
  /skill <name>       确定性加载 Skill，可在名称后追加任务参数
  /memory             查看、确认、添加或删除记忆（confirm/add/forget/promote）
  /instinct           查看、手动提炼或删除行为规则（distill/stats/promote）
  /permission         切换权限模式 (plan, default, accept-edit, auto, bypass-permissions)
  /effort             切换思考强度 (low, medium, high, xhigh, max)
  /model              选择大模型与思考强度
  /provider          查看 / 切换 / 添加 / 配置提供商（默认全局，可加 --project）
  /clear              清空聊天历史与上下文
  /perf               查看性能指标，/perf reset 可清空采样
  /viewer             打开 Trace 观测中心
  /exit               退出 haji

${colors.bold("环境变量配置:")}
  DEEPSEEK_API_KEY    DeepSeek 平台 API Key
  VOLC_API_KEY        火山引擎 API Key (或 ARK_API_KEY)
  HAJI_PROXY          HTTP/HTTPS 统一代理（也支持 HTTP_PROXY / HTTPS_PROXY）
  HAJI_HTTP_TIMEOUT_MS  网络连接超时，默认 60000ms
  HAJI_ALLOW_OUTSIDE_WORKSPACE  设为 1 时允许文件工具访问工作区外（谨慎）
  HAJI_CONTEXT_WINDOW_TOKENS  可选：覆盖当前模型的上下文 Token 上限
`);
    process.exit(0);
  }
  return false;
}
