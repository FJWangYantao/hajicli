import * as fs from "node:fs/promises";
import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";
import {
  contentHash,
  FileConflictError,
  fileVersions,
  writeUtf8Atomically,
} from "./file-content.js";
import { formatWorkspaceError, resolveWorkspacePath } from "./workspace-path.js";

function parseExpectedHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/i.test(value)) {
    throw new Error("expectedHash 必须是 read 返回的16位十六进制 hash。");
  }
  return value.toLowerCase();
}

/** 诊断片段的最大行数与单行最大长度，避免失败信息本身撑爆上下文。 */
const HINT_MAX_LINES = 12;
const HINT_MAX_LINE_LENGTH = 200;
/** 改后回显的最大行数。 */
const REGION_MAX_LINES = 12;

/** 同一文件连续同类 oldText 未命中的计数；期间 read 过就重置。 */
const missStreaks = new Map<string, { category: string; readSeq: number; count: number }>();

/**
 * 目标内容是否已经在文件里：忽略注释行与空白后，newText 的每一行按顺序出现。
 * 用于识别「上一笔编辑（自己或子代理）已经写入了同一目标」——此时再按旧 oldText
 * 定位必然失败，重试只会空转。
 */
function looksAlreadyApplied(content: string, newText: string): boolean {
  const significant = (text: string): string[] =>
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("//") &&
          !line.startsWith("/*") &&
          !line.startsWith("*") &&
          line !== "*/",
      );
  const needles = significant(newText);
  if (needles.length < 3) return false;
  let at = 0;
  for (const line of significant(content)) {
    if (line === needles[at]) at += 1;
    if (at === needles.length) return true;
  }
  return false;
}

/**
 * 给一个「文件里只出现一次」的短行作锚点：大段 oldText 只要被上一笔编辑改过一行
 * 就必然失配，而单行锚点几乎总是稳定，模型据此把 oldText 收缩到最小范围。
 */
function suggestUniqueAnchor(content: string, oldText: string): string | undefined {
  const lines = oldText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
  const seen = new Set<string>();
  for (const line of lines.sort((a, b) => b.length - a.length).slice(0, 20)) {
    if (seen.has(line)) continue;
    seen.add(line);
    if (content.split(line).length === 2) return line;
  }
  return undefined;
}

function missKey(agentId: string | undefined, filePath: string): string {
  return `${agentId ?? ""}\0${filePath}`;
}

function noteEditMiss(agentId: string | undefined, filePath: string, category: string): number {
  const key = missKey(agentId, filePath);
  const readSeq = fileVersions.readCount(agentId, filePath);
  const previous = missStreaks.get(key);
  const count =
    previous && previous.category === category && previous.readSeq === readSeq
      ? previous.count + 1
      : 1;
  missStreaks.set(key, { category, readSeq, count });
  return count;
}

function clearEditMiss(agentId: string | undefined, filePath: string): void {
  missStreaks.delete(missKey(agentId, filePath));
}

/**
 * 编辑成功后回显改后片段：模型下一次编辑可以直接引用这里的原文，
 * 不必凭记忆重写 oldText（这是「改完自己又拿旧文本去改」的常见来源）。
 */
function formatEditedRegion(text: string, startLine: number): string {
  if (!text) return "\n改后片段: （该段已被删除）";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const shown = lines.slice(0, REGION_MAX_LINES).map((line, index) => {
    const clipped =
      line.length > HINT_MAX_LINE_LENGTH ? `${line.slice(0, HINT_MAX_LINE_LENGTH)}…` : line;
    return `${String(startLine + index).padStart(4)} | ${clipped}`;
  });
  const more =
    lines.length > REGION_MAX_LINES
      ? `\n…（改后共 ${lines.length} 行，只显示前 ${REGION_MAX_LINES} 行）`
      : "";
  return `\n改后片段（第 ${startLine} 行起）:\n${shown.join("\n")}${more}`;
}
/** read 默认输出的「行号 | 」前缀。 */
const LINE_NUMBER_PREFIX_RE = /^\s*\d+ \| /;

/**
 * 在 content 中定位 oldText；精确匹配失败且文件是 CRLF 而 oldText 只含 LF 时，
 * 按 CRLF 再匹配一次（read 输出会去掉 \r，模型看不到行尾差异）。
 */
function locateOldText(
  content: string,
  oldText: string,
  newText: string,
): { index: number; oldText: string; newText: string; count: number } {
  const count = (needle: string): { index: number; count: number } => {
    const index = content.indexOf(needle);
    if (index === -1) return { index, count: 0 };
    return { index, count: content.indexOf(needle, index + needle.length) === -1 ? 1 : 2 };
  };
  const exact = count(oldText);
  if (exact.count > 0 || !content.includes("\r\n") || !oldText.includes("\n")) {
    return { ...exact, oldText, newText };
  }
  const toCrlf = (value: string) => value.replace(/\r?\n/g, "\r\n");
  const crlfOld = toCrlf(oldText);
  return { ...count(crlfOld), oldText: crlfOld, newText: toCrlf(newText) };
}

interface OldTextMissAnalysis {
  /** 稳定、可归类的错误类别：重复失败保护用它区分不同的修正方向。 */
  category: string;
  /** 给模型看的详细线索。 */
  detail: string;
}

/** 把文件中的若干行渲染成带行号的诊断片段，避免失败信息本身撑爆上下文。 */
function renderMissSnippet(
  fileLines: readonly string[],
  hitLineIndex: number,
  anchorOffset: number,
  oldLineCount: number,
): string {
  const start = Math.max(0, hitLineIndex - anchorOffset - 1);
  const end = Math.min(fileLines.length, start + Math.min(oldLineCount + 2, HINT_MAX_LINES));
  return fileLines
    .slice(start, end)
    .map((line, offset) => {
      const text =
        line.length > HINT_MAX_LINE_LENGTH ? `${line.slice(0, HINT_MAX_LINE_LENGTH - 1)}…` : line;
      return `${start + offset + 1} | ${text}`;
    })
    .join("\n");
}

interface AnchorFallback {
  lineIndex: number;
  category: string;
  hint: string;
}

/**
 * 整行锚点没命中时继续细分：行内空白不同、只写了半行、多带前缀各有各的修法。
 * 不细分的话三种情况都会含糊地报成「锚点行不存在」，模型只能盲猜着重试。
 */
function findAnchorFallback(
  fileLines: readonly string[],
  anchorText: string,
): AnchorFallback | undefined {
  const squash = (value: string) => value.replace(/\s+/g, "");
  const squashedAnchor = squash(anchorText);
  if (squashedAnchor) {
    const lineIndex = fileLines.findIndex((line) => squash(line) === squashedAnchor);
    if (lineIndex !== -1) {
      return {
        lineIndex,
        category: "行内空白不一致",
        hint: "字符相同，但行内空格或 Tab 与文件不一致。",
      };
    }
  }
  const fragmentIndex = fileLines.findIndex((line) => line.includes(anchorText));
  if (fragmentIndex !== -1) {
    return {
      lineIndex: fragmentIndex,
      category: "片段不是整行",
      hint: "oldText 的最长一行只是文件某行的一部分，整行比对必然落空。请补成上面对应的整行，或改用不带换行的唯一片段。",
    };
  }
  const prefixIndex = fileLines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.length >= 8 && anchorText.includes(trimmed);
  });
  if (prefixIndex !== -1) {
    return {
      lineIndex: prefixIndex,
      category: "多出前缀或多余字符",
      hint: "oldText 的最长一行比文件原文多了前缀或字符。请删掉行号、grep 的「路径:行:」或 diff 的 +/- 标记，只保留原文。",
    };
  }
  return undefined;
}

/**
 * oldText 未命中时给出可据以修正的线索：常见的复制错误，或文件中最接近位置的实际内容（带行号）。
 * 同时给出稳定的错误类别，避免「行号前缀错误」和「缩进不一致」被当成同一种失败反复累计。
 */
function analyzeOldTextMiss(content: string, oldText: string): OldTextMissAnalysis {
  const fileLines = content.split(/\r?\n/);
  const oldLines = oldText.split(/\r?\n/);
  if (oldLines.some((line) => LINE_NUMBER_PREFIX_RE.test(line))) {
    return {
      category: "行号前缀",
      detail: "oldText 带有 read 输出的「行号 | 」前缀，请去掉前缀后只保留文件原文。",
    };
  }
  if (oldText.includes("…") && !content.includes("…")) {
    return {
      category: "截断省略",
      detail: "oldText 含有 read 截断超长行时加的「…」，请改用该行中未被截断的部分作为上下文。",
    };
  }

  // 用 oldText 中最长的一行做锚点，忽略缩进与行尾空白，在文件里找它的实际位置。
  const anchor = oldLines.reduce((best, line) =>
    line.trim().length > best.trim().length ? line : best,
  );
  const anchorText = anchor.trim();
  const anchorOffset = oldLines.indexOf(anchor);
  const hits: number[] = [];
  if (anchorText) {
    fileLines.forEach((line, index) => {
      if (line.trim() === anchorText) hits.push(index);
    });
  }
  if (hits.length > 0) {
    const where = hits.length > 1 ? `（该行共出现 ${hits.length} 处，以下为第 1 处）` : "";
    return {
      category: "缩进或空白不一致",
      detail: `文件中最接近的位置${where}实际内容如下，请对照缩进、空白和字符逐字修正 oldText（不要带行号前缀）：\n${renderMissSnippet(fileLines, hits[0], anchorOffset, oldLines.length)}`,
    };
  }

  if (anchorText) {
    const fallback = findAnchorFallback(fileLines, anchorText);
    if (fallback) {
      return {
        category: fallback.category,
        detail: `${fallback.hint}最接近的位置实际内容如下，请按整行原文重写 oldText：\n${renderMissSnippet(fileLines, fallback.lineIndex, anchorOffset, oldLines.length)}`,
      };
    }
  }

  return {
    category: "锚点行不存在",
    detail: `oldText 中最具特征的一行在文件里不存在（${anchorText.slice(0, 80) || "空白"}）。文件可能已被改动，或 oldText 来自其他文件、凭记忆写成。请先用 read 重新读取相关区域，不要凭记忆重试。`,
  };
}

/** 详细线索（保留旧导出，供调用方与测试按需使用）。 */
export function describeOldTextMiss(content: string, oldText: string): string {
  return analyzeOldTextMiss(content, oldText).detail;
}

/** 稳定的错误类别（行号前缀 / 截断省略 / 锚点行不存在 / 缩进或空白不一致）。 */
export function classifyOldTextMiss(content: string, oldText: string): string {
  return analyzeOldTextMiss(content, oldText).category;
}

export class EditFileTool implements BaseTool {
  public readonly name = "edit";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "edit",
      description:
        "在文件中唯一匹配 oldText 并原子替换为 newText。可传入 read 返回的 expectedHash 防止覆盖外部修改。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文件路径。" },
          oldText: { type: "string", description: "必须在文件中唯一匹配的原文。" },
          newText: { type: "string", description: "替换后的文本。" },
          expectedHash: {
            type: "string",
            description:
              "可选，最近一次 read/edit/write 返回的16位内容 hash（连续编辑用上一次的 newHash）。文件已变化时拒绝编辑。",
          },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  };

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    if (typeof args.path !== "string" || !args.path) return "错误: 缺少 path 参数。";
    if (typeof args.oldText !== "string") return "错误: oldText 必须是字符串。";
    if (typeof args.newText !== "string") return "错误: newText 必须是字符串。";
    let expectedHash: string | undefined;
    try {
      expectedHash = parseExpectedHash(args.expectedHash);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (context?.abortSignal?.aborted) return "[文件编辑已中止]";

    const filePath = args.path;
    try {
      const resolvedPath = await resolveWorkspacePath(filePath);
      const maxAttempts = expectedHash === undefined ? 1 : 2;
      let retriedForStaleHash = false;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (context?.abortSignal?.aborted) return "[文件编辑已中止]";
        // 按原始字节计算 hash，与 read 工具返回的 hash 口径一致（UTF-8 解码有损的文件也能正确比对）。
        const buffer = await fs.readFile(resolvedPath, { signal: context?.abortSignal });
        if (context?.abortSignal?.aborted) return "[文件编辑已中止]";
        const content = buffer.toString("utf8");
        const currentHash = contentHash(buffer);
        const stale = expectedHash !== undefined && expectedHash !== currentHash;
        const match = locateOldText(content, args.oldText, args.newText);
        // 并发写的可能性只在 hash 过期时才有意义：用它说明「多久之前被写过」。
        const fileStat = stale ? await fs.stat(resolvedPath).catch(() => undefined) : undefined;
        const writeAge = fileStat
          ? Math.max(0, Math.round((Date.now() - fileStat.mtimeMs) / 1000))
          : undefined;
        const recentWriteNote =
          writeAge === undefined ? "" : `该文件在最近 ${writeAge} 秒内被写入。`;

        // expectedHash 过期：先重读一次再判定。真正的安全边界是 oldText 唯一命中，
        // expectedHash 只是防覆盖提示；外部格式化改了别处不应让本次编辑无谓失败。
        if (stale && attempt === 0) {
          retriedForStaleHash = true;
          continue;
        }

        // oldText 未命中但目标内容已在文件里：多半是上一笔编辑（自己或子代理）已经写入。
        // 此时无论怎么重写 oldText 都不可能命中，直接按「无需修改」收尾，避免原地空转。
        if (match.count === 0 && looksAlreadyApplied(content, args.newText)) {
          clearEditMiss(context?.agentId, resolvedPath);
          const staleNote = stale
            ? `\n另: expectedHash 已过期（期望 ${expectedHash}，当前 ${currentHash}），当前文件仍满足本次修改目标。`
            : "";
          return `[文件无需修改]\n路径: ${filePath}\ncurrentHash=${currentHash}\n说明: oldText 未命中，但 newText 的主体已经在文件里（可能由你或子代理的上一笔编辑写入）。本次没有写盘。${staleNote}`;
        }

        if (stale) {
          if (match.count > 1) {
            return `编辑失败: [hash冲突] [并发写入] 文件已被外部修改（期望 hash=${expectedHash}，当前 hash=${currentHash}），${recentWriteNote}且 oldText 在当前内容中匹配到多处。请停止继续编辑，向用户说明并确认是否有另一个代理在跑。`;
          }
          // oldText 未命中时先区分来源：当前版本仍是本代理自己写出的链尾，
          // 说明是「改完又拿旧文本去改」，比「外部修改」更值得说清楚。
          if (
            match.count === 0 &&
            !fileVersions.isOwnHead(context?.agentId, resolvedPath, currentHash)
          ) {
            const miss = analyzeOldTextMiss(content, args.oldText);
            return `编辑失败: [hash冲突] [并发写入] 文件已被外部修改（期望 hash=${expectedHash}，当前 hash=${currentHash}），${recentWriteNote}且 oldText 在当前内容中未命中（${miss.category}）。\n请停止继续编辑，向用户说明并确认是否有另一个代理在跑。\n${miss.detail}`;
          }
          // 唯一命中：继续基于最新内容编辑；写入时用 currentHash 再做一次 CAS，
          // 若重读之后文件又被改动，writeUtf8Atomically 仍会拒绝覆盖。
        }

        if (match.count === 0) {
          const miss = analyzeOldTextMiss(content, args.oldText);
          const ownEdit = fileVersions.isOwnHead(context?.agentId, resolvedPath, currentHash);
          const hint = ownEdit
            ? "\n注意: 该文件最近一次改动来自本会话（你自己或子代理），当前 hash 就是版本链尾，oldText 很可能取自改动前的旧文本。"
            : "";
          const hashNote = stale
            ? `\n另: expectedHash 已过期（期望 ${expectedHash}，当前 ${currentHash}），本次已按最新内容判定。`
            : "";
          const streak = noteEditMiss(context?.agentId, resolvedPath, miss.category);
          const anchor = suggestUniqueAnchor(content, args.oldText);
          const anchorNote = anchor
            ? `\n建议: 把 oldText 收缩成文件里唯一的短锚点（例如「${anchor}」），再带上紧邻的 1-2 行。大段原文被上一笔编辑改过一行就会失配——bash 的 grep/sed 只负责显示，改文件仍要 oldText 精确命中。`
            : "";
          if (streak >= 2) {
            return `编辑失败: 同一文件的 oldText 已连续 ${streak} 次同类未命中（${miss.category}），本次不再重复判定。${hint}${hashNote}\n下一步：先 read 该文件（拿当前内容与 hash），再按原文重写 oldText。${anchorNote}\n${miss.detail}`;
          }
          return `编辑失败: 在文件中找不到指定的 oldText 原文（${miss.category}）。${hint}${hashNote}${anchorNote}\n${miss.detail}`;
        }
        if (match.count > 1) {
          return "编辑失败: oldText 匹配到多处，为安全起见已拒绝修改。请增加上下文确保唯一。";
        }

        const newContent =
          content.slice(0, match.index) +
          match.newText +
          content.slice(match.index + match.oldText.length);
        const newHash = contentHash(newContent);
        await writeUtf8Atomically(resolvedPath, newContent, context?.abortSignal, currentHash);
        fileVersions.advance(context?.agentId, resolvedPath, currentHash, newHash);
        clearEditMiss(context?.agentId, resolvedPath);
        const retryNote = retriedForStaleHash
          ? "\n说明: expectedHash 已过期，已重新读取并按最新内容应用。"
          : "";
        const regionStartLine = content.slice(0, match.index).split("\n").length;
        return `[文件精准编辑成功]\n路径: ${filePath}\noldHash=${currentHash}\nnewHash=${newHash}\n替换次数=1${retryNote}${formatEditedRegion(match.newText, regionStartLine)}`;
      }
      return "编辑失败: [hash冲突] [并发写入] 重读后文件仍在被其他进程/会话改写，本回合不要再重试。请向用户说明并确认是否有另一个代理在跑。";
    } catch (error) {
      if (
        context?.abortSignal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return "[文件编辑已中止]";
      }
      if (error instanceof FileConflictError) {
        return `编辑失败: [hash冲突] [并发写入] ${error.message}。文件在本次 read 之后被其他进程/会话写入，请停止重试并向用户说明。`;
      }
      return `精准编辑文件失败: ${formatWorkspaceError(error, filePath)}`;
    }
  }
}
