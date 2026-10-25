import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { replaceFileAtomically } from "@hajicli/core";

export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export class FileConflictError extends Error {
  public readonly code = "HAJI_FILE_CONFLICT";

  constructor(
    public readonly expectedHash: string,
    public readonly actualHash?: string,
  ) {
    super(
      actualHash
        ? `文件已变化：期望 hash=${expectedHash}，当前 hash=${actualHash}`
        : `文件已变化或不存在：期望 hash=${expectedHash}`,
    );
    this.name = "FileConflictError";
  }
}

/** 每条版本链最多保留的历史 hash 数，超出时淘汰最早的。 */
const MAX_TRACKED_HASHES = 32;

/**
 * 记录每个代理对每个文件「中间没有外部修改」的连续版本链。
 * 用于区分「hash 过期是因为模型本轮自己改过」与「文件被外部修改」：
 * 前者磁盘内容仍是该代理最后写出的版本，覆写不会丢掉别人的改动。
 * bash（如格式化）、编辑器、其他子代理造成的变化会让版本链从新版本重新开始，
 * 链上更早的 hash 随之失效，仍按外部修改处理。
 */
export class FileVersionRegistry {
  private readonly chains = new Map<string, { latest: string; seen: Set<string> }>();

  private key(agentId: string | undefined, filePath: string): string {
    return `${agentId ?? ""}\0${filePath}`;
  }

  private restart(key: string, hash: string): void {
    this.chains.set(key, { latest: hash, seen: new Set([hash]) });
  }

  /** read 等只读观察：磁盘版本不是链尾说明发生过外部修改，版本链从该版本重新开始。 */
  public observe(agentId: string | undefined, filePath: string, hash: string): void {
    const key = this.key(agentId, filePath);
    if (this.chains.get(key)?.latest !== hash) this.restart(key, hash);
  }

  /**
   * 该代理自己把文件从 fromHash 写成 toHash。fromHash 不是链尾（期间有外部修改）
   * 或未知（未带 expectedHash 的整体覆写）时，版本链从 toHash 重新开始。
   */
  public advance(
    agentId: string | undefined,
    filePath: string,
    fromHash: string | undefined,
    toHash: string,
  ): void {
    const key = this.key(agentId, filePath);
    const chain = this.chains.get(key);
    if (!chain || fromHash === undefined || chain.latest !== fromHash) {
      this.restart(key, toHash);
      return;
    }
    chain.latest = toHash;
    chain.seen.delete(toHash);
    chain.seen.add(toHash);
    if (chain.seen.size > MAX_TRACKED_HASHES) {
      const oldest = chain.seen.values().next().value;
      if (oldest !== undefined) chain.seen.delete(oldest);
    }
  }

  /** 磁盘当前版本正是该代理链尾，且 expectedHash 是同一条链上的旧版本。 */
  public isOwnChain(
    agentId: string | undefined,
    filePath: string,
    expectedHash: string,
    currentHash: string,
  ): boolean {
    const chain = this.chains.get(this.key(agentId, filePath));
    return chain !== undefined && chain.latest === currentHash && chain.seen.has(expectedHash);
  }

  public clear(): void {
    this.chains.clear();
  }
}

/** 进程内共享的版本链，read/edit/write 三个工具共用。 */
export const fileVersions = new FileVersionRegistry();

function abortError(): Error {
  const error = new Error("文件写入已中止");
  error.name = "AbortError";
  return error;
}

/** Writes beside the target and atomically replaces it while preserving its mode when possible. */
export async function writeUtf8Atomically(
  targetPath: string,
  content: string,
  abortSignal?: AbortSignal,
  expectedHash?: string,
): Promise<void> {
  if (abortSignal?.aborted) throw abortError();
  let mode: number | undefined;
  try {
    mode = (await fs.stat(targetPath)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.haji-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
      signal: abortSignal,
    });
    if (abortSignal?.aborted) throw abortError();
    if (expectedHash !== undefined) {
      let actualHash: string | undefined;
      try {
        actualHash = contentHash(await fs.readFile(targetPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (actualHash !== expectedHash) throw new FileConflictError(expectedHash, actualHash);
    }
    await replaceFileAtomically(tempPath, targetPath);
  } finally {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {}
  }
}
