/** 退出步骤独立限时：可选钩子失败不能阻止会话保存和进程清理。 */
export async function runShutdownSteps(
  steps: {
    name: string;
    run: (signal: AbortSignal) => unknown | Promise<unknown>;
    timeoutMs?: number;
    /** 辅助维护失败仅告警；关键保存与钩子默认影响退出状态。 */
    affectsExitCode?: boolean;
  }[],
  warn: (message: string) => void,
): Promise<boolean> {
  let ok = true;
  for (const step of steps) {
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run(controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("超时，已继续退出清理"));
          }, step.timeoutMs ?? 3000);
        }),
      ]);
    } catch (error) {
      if (step.affectsExitCode !== false) ok = false;
      warn(`${step.name}失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return ok;
}
