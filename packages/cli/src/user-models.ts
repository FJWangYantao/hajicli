import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 用户模型表：~/.haji/models.json。
 *
 * 让内置 provider（deepseek / 火山方舟）上新模型时无需发版——用户自行登记
 * 模型名、归属 provider 与上下文窗口，即可出现在 /model 选择列表并正确路由。
 * 自定义 provider 的模型仍走 provider 配置（/provider add）声明。
 */
export interface UserModelEntry {
  model: string;
  provider: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  description?: string;
}

export function userModelsPath(): string {
  return path.join(os.homedir(), ".haji", "models.json");
}

let loadCache: { mtimeMs: number; entries: UserModelEntry[] } | undefined;

/** 读取用户模型表（文件缺失/损坏/结构非法一律回空表；按 mtime 缓存避免高频读盘）。 */
export function loadUserModels(): UserModelEntry[] {
  try {
    const filePath = userModelsPath();
    const stat = fs.statSync(filePath);
    if (loadCache && loadCache.mtimeMs === stat.mtimeMs) return loadCache.entries;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as {
      models?: unknown;
    };
    const entries: UserModelEntry[] = Array.isArray(raw?.models)
      ? raw.models.filter(
          (entry): entry is UserModelEntry =>
            Boolean(entry) &&
            typeof entry.model === "string" &&
            entry.model.trim().length > 0 &&
            typeof entry.provider === "string" &&
            entry.provider.trim().length > 0,
        )
      : [];
    loadCache = { mtimeMs: stat.mtimeMs, entries };
    return entries;
  } catch {
    return [];
  }
}
