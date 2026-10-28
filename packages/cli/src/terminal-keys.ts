/**
 * 真实 Ctrl 组合键判定：readline 会把部分转义序列也解析成 ctrl+字母，
 * 这里同时校验原始字节，避免把粘贴内容或其他序列当成快捷键。
 */
import type readline from "node:readline";

export function isRealCtrlC(value: string, key: readline.Key): boolean {
  return value === "\x03" && key.ctrl === true && key.name === "c";
}

export function isRealCtrlD(value: string, key: readline.Key): boolean {
  return value === "\x04" && key.ctrl === true && key.name === "d";
}

/** 斜杠命令可能切换到选择器，提交后应由主循环接管输入状态。 */
export function shouldRestartBackgroundInput(value: string): boolean {
  return !value.trim().startsWith("/");
}

export function isRealCtrlU(value: string, key: readline.Key): boolean {
  return value === "\x15" && key.ctrl === true && key.name === "u";
}

export function isRealCtrlO(value: string, key: readline.Key): boolean {
  return value === "\x0f" && key.ctrl === true && key.name === "o";
}

export function isRealCtrlT(value: string, key: readline.Key): boolean {
  return value === "\x14" && key.ctrl === true && key.name === "t";
}

/** Ctrl+E：折叠/展开侧栏费用明细（与鼠标点「▸ 明细」等价）。 */
export function isRealCtrlE(value: string, key: readline.Key): boolean {
  return value === "\x05" && key.ctrl === true && key.name === "e";
}
