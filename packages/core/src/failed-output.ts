/**
 * 工具输出的失败判定。
 *
 * 从 packages/cli/src/tool-executor.ts 的内联逻辑抽取而来，
 * 供 PostToolUse hook、ExperienceStore 和 DistillEngine 共享同一套判定标准。
 *
 * 注意：这与 trace 的 `approved` 字段语义不完全一致——trace 的 approved 只覆盖
 * 「错误:」和「安全拒绝」两类，本函数额外覆盖「执行出错」「已中止」「子代理失败」，
 * 确保所有失败样本都能被经验系统捕获。
 */
export function isFailedToolOutput(output: string): boolean {
  return output.startsWith('错误:')
    || output.startsWith('执行出错:')
    || /^\[[^\]]*已中止\]/.test(output)
    || output.startsWith('[安全引擎拒绝拦截]')
    || (output.startsWith('[SUBAGENT_RESULT')
      && /"status":\s*"(?:failed|aborted|max_turns)"/.test(output));
}
