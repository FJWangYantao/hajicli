import fs from "node:fs";
import path from "node:path";

/** @ 引用附加文件的上限：超出截断并注明（防误引用超大文件撑爆上下文）。 */
const MAX_BYTES = 120_000;
const MAX_LINES = 1_500;

export interface FileMentionExpansion {
  /** 替换掉 @ 前缀并追加了文件内容块后的最终 prompt。 */
  prompt: string;
  /** 成功附加的文件相对路径（按出现顺序去重）。 */
  attached: string[];
  /** 无法附加的 token 及原因（不存在 / 超出工作区 / 二进制）。 */
  skipped: string[];
}

const MENTION_TOKEN_RE = /(^|\s)@([\w./\\:-]+)/g;

function isWithinCwd(resolvedPath: string, cwd: string): boolean {
  const relative = path.relative(cwd, resolvedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readAttachment(resolvedPath: string): { content: string; note?: string } {
  const raw = fs.readFileSync(resolvedPath, "utf8");
  const binary = raw.includes("\0");
  if (binary) return { content: "", note: "二进制文件" };
  let content = raw;
  let note: string | undefined;
  const lineCount = content.split("\n").length;
  if (raw.length > MAX_BYTES || lineCount > MAX_LINES) {
    content = content.split("\n").slice(0, MAX_LINES).join("\n");
    if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES);
    note = `文件过大已截断（原始 ${lineCount} 行 / ${raw.length} 字符）`;
  }
  return { content, note };
}

/**
 * 展开 prompt 中的 `@路径` 引用：命中的文件内容以附件块追加到 prompt 尾部，
 * 原位置的 @ 前缀去掉（对话回显仍是用户原话）。
 * 允许的文件范围 = cwd + 追加的工作区根；目录、不存在、二进制与越界路径记入 skipped。
 */
export function expandFileMentions(
  input: string,
  cwd: string,
  extraRoots: readonly string[] = [],
): FileMentionExpansion {
  const roots = [cwd, ...extraRoots];
  const tokens: string[] = [];
  for (const match of input.matchAll(MENTION_TOKEN_RE)) {
    const token = match[2];
    if (token && !tokens.includes(token)) tokens.push(token);
  }
  if (tokens.length === 0) return { prompt: input, attached: [], skipped: [] };

  const attached: string[] = [];
  const skipped: string[] = [];
  const blocks: string[] = [];
  for (const token of tokens) {
    const resolved = path.resolve(cwd, token);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      skipped.push(`${token}（不存在）`);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push(`${token}（不是普通文件）`);
      continue;
    }
    if (!roots.some((root) => isWithinCwd(resolved, root))) {
      skipped.push(`${token}（超出工作区）`);
      continue;
    }
    const { content, note } = readAttachment(resolved);
    if (!content) {
      skipped.push(`${token}（${note ?? "无法读取"}）`);
      continue;
    }
    attached.push(token);
    blocks.push(
      [
        `<attached_file path="${token}"${note ? ` note="${note}"` : ""}>`,
        content,
        "</attached_file>",
      ].join("\n"),
    );
  }

  // 去掉已成功附加 token 的 @ 前缀；skipped 的保留原样（用户可见原因）。
  let prompt = input;
  for (const token of attached) {
    prompt = prompt.replace(
      new RegExp(`(^|\\s)@(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g"),
      "$1$2",
    );
  }
  if (blocks.length > 0) {
    prompt = `${prompt}\n\n${blocks.join("\n\n")}`;
  }
  return { prompt, attached, skipped };
}

function isSubsequenceIn(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

/**
 * @ 文件补全的候选匹配：文件名前缀命中优先，其次路径前缀、文件名包含、
 * 路径子序列；同分时短路径优先。供输入框的 @ 弹出列表使用。
 */
export function matchFileMentionCandidates(
  files: readonly string[],
  query: string,
  limit = 8,
): string[] {
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/^[\\/]+/, "");
  if (!needle) {
    return files.filter((file) => !file.includes("node_modules")).slice(0, limit);
  }
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const separator = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
    const base = lower.slice(separator + 1);
    let score: number | undefined;
    if (base.startsWith(needle)) score = 0;
    else if (lower.startsWith(needle)) score = 1;
    else if (base.includes(needle)) score = 2;
    else if (isSubsequenceIn(needle, lower)) score = 3;
    if (score !== undefined) scored.push({ file, score });
  }
  return scored
    .sort((left, right) => left.score - right.score || left.file.length - right.file.length)
    .slice(0, limit)
    .map((item) => item.file);
}
