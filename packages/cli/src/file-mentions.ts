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

export interface FileMention {
  path: string;
  start: number;
  end: number;
}

export interface FileMentionPreview extends FileMention {
  status: "ready" | "truncated" | "skipped";
  note?: string;
}

/** 带空格路径使用单双引号；引号内保留 Windows 反斜杠。 */
export function parseFileMentions(input: string): FileMention[] {
  return [...input.matchAll(/(^|\s)@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'<>，。；！？]+))/gu)].map(
    (match) => ({
      path: match[2] ?? match[3] ?? match[4],
      start: match.index + match[1].length,
      end: match.index + match[0].length,
    }),
  );
}

export function formatFileMention(file: string): string {
  if (!/[\s"'<>，。；！？]/u.test(file)) return `@${file}`;
  return file.includes('"') ? `@'${file}'` : `@"${file}"`;
}

export function removeFileMention(input: string, file: string): string {
  let result = input;
  for (const mention of parseFileMentions(input).reverse()) {
    if (mention.path === file) result = result.slice(0, mention.start) + result.slice(mention.end);
  }
  return result;
}

/** 未闭合的引号也参与补全，跨度使用 UTF-16，光标转换由输入框负责。 */
export function fileMentionQuery(input: string): { start: number; query: string } | undefined {
  const match = /(?:^|\s)@(?:"([^"\r\n]*)|'([^'\r\n]*)|([^\s"'<>，。；！？]*))$/u.exec(input);
  if (!match) return undefined;
  return { start: match.index + match[0].indexOf("@"), query: match[1] ?? match[2] ?? match[3] };
}

function isWithinCwd(resolvedPath: string, cwd: string): boolean {
  const relative = path.relative(cwd, resolvedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readAttachment(
  file: string,
  roots: readonly string[],
): {
  content: string;
  status: FileMentionPreview["status"];
  note?: string;
} {
  let fd: number | undefined;
  try {
    const resolved = fs.realpathSync(file);
    if (
      !roots.some((root) => {
        try {
          return isWithinCwd(resolved, fs.realpathSync(root));
        } catch {
          return false;
        }
      })
    )
      return { content: "", status: "skipped", note: "超出工作区" };
    if (!fs.statSync(resolved).isFile())
      return { content: "", status: "skipped", note: "不是普通文件" };
    fd = fs.openSync(resolved, "r");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, size).includes(0))
      return { content: "", status: "skipped", note: "二进制文件" };
    const limited = buffer.subarray(0, Math.min(size, MAX_BYTES));
    // 流式解码避免字节上限切断一个中文字符。
    const raw = new TextDecoder().decode(limited, { stream: size > MAX_BYTES });
    const lines = raw.split("\n");
    const truncated = size > MAX_BYTES || lines.length > MAX_LINES;
    return {
      content: lines.slice(0, MAX_LINES).join("\n"),
      status: truncated ? "truncated" : "ready",
      ...(truncated ? { note: `文件过大已截断（最多 ${MAX_LINES} 行 / ${MAX_BYTES} 字节）` } : {}),
    };
  } catch {
    return { content: "", status: "skipped", note: "不存在或无法读取" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function inspectFileMentions(
  input: string,
  cwd: string,
  extraRoots: readonly string[] = [],
): FileMentionPreview[] {
  const seen = new Set<string>();
  return parseFileMentions(input)
    .filter((mention) => {
      if (seen.has(mention.path)) return false;
      seen.add(mention.path);
      return true;
    })
    .map((mention) => {
      const { status, note } = readAttachment(path.resolve(cwd, mention.path), [
        cwd,
        ...extraRoots,
      ]);
      return { ...mention, status, note };
    });
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
  const mentions = parseFileMentions(input);
  for (const mention of mentions) {
    if (!tokens.includes(mention.path)) tokens.push(mention.path);
  }
  if (tokens.length === 0) return { prompt: input, attached: [], skipped: [] };

  const attached: string[] = [];
  const skipped: string[] = [];
  const blocks: string[] = [];
  for (const token of tokens) {
    const resolved = path.resolve(cwd, token);
    const { content, note, status } = readAttachment(resolved, roots);
    if (status === "skipped") {
      skipped.push(`${token}（${note}）`);
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
  for (const mention of mentions.reverse()) {
    if (attached.includes(mention.path)) {
      prompt = prompt.slice(0, mention.start) + mention.path + prompt.slice(mention.end);
    }
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
