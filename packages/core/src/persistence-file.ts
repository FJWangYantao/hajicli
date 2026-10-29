import crypto from "node:crypto";
import fs from "node:fs";

/** 同目录原子替换；失败时保留旧文件，不回退到覆盖写。 */
export function writeFileAtomicallySync(filePath: string, content: string | Buffer): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** 写盘期间独占；遗留锁保守报错，避免自动删锁与新写入者之间的竞争。 */
export function acquireFileLock(filePath: string): () => void {
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(lockPath, token, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`会话写入冲突：存在写入锁 ${lockPath}；请确认其他进程已退出后备份并清理遗留锁`);
  }
  return () => {
    if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
  };
}
