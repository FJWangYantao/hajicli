/**
 * `visualize` 的参数形态、校验与模型侧兜底文本（移植自 ThinkRail
 * `pi-extensions/visualize` 的 `schema.ts` / `validate.ts` / `markdown.ts`）。
 *
 * 三条约束决定了这里的形状：
 * - 参数可能是**流式残缺**的（模型还在生成），所以解析一律防御式，不假设字段齐全；
 * - 校验错误要说清「哪一项不对、怎么改」，模型据此重调，用户不必参与；
 * - 返回给模型的是 markdown（mermaid 围栏 / 分节对比），无渲染器的宿主也读得懂。
 */

export type VisualizeType = "diagram" | "comparison" | "file";

export interface ComparisonOption {
  name: string;
  description?: string;
  pros: string[];
  cons: string[];
  recommended: boolean;
  mermaid?: string;
}

export interface VisualizeParams {
  type: VisualizeType;
  title?: string;
  mermaid?: string;
  options: ComparisonOption[];
  path?: string;
  before?: string;
}

export interface MermaidSource {
  location: string;
  source: string;
}

export interface FileSource {
  location: "path" | "before";
  path: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseOptions(value: unknown): ComparisonOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const option = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    return {
      name: text(option.name) ?? "",
      description: text(option.description),
      pros: textArray(option.pros),
      cons: textArray(option.cons),
      recommended: option.recommended === true,
      mermaid: text(option.mermaid),
    };
  });
}

/** 未知的 type 一律按 diagram 处理：校验层会把它挡下来，展示层不必再分支。 */
export function parseVisualizeParams(args: Record<string, unknown>): VisualizeParams {
  const type = text(args.type);
  return {
    type: type === "comparison" || type === "file" ? type : "diagram",
    title: text(args.title),
    mermaid: text(args.mermaid),
    options: parseOptions(args.options),
    path: text(args.path),
    before: text(args.before),
  };
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) =>
    path
      .trim()
      .replaceAll("\\", "/")
      .replace(/^(\.\/)+/, "");
  return normalize(left) === normalize(right);
}

/**
 * 按 type 检查必填项。报错文本直接回给模型，因此每条都带「怎么改」。
 */
export function validateVisualizeShape(params: VisualizeParams): void {
  if (params.type === "diagram") {
    if (!params.mermaid || params.mermaid.trim() === "") {
      throw new Error('type 为 "diagram" 时 `mermaid` 必填，且不能是空字符串。');
    }
    return;
  }

  if (params.type === "file") {
    if (!params.path || params.path.trim() === "") {
      throw new Error('type 为 "file" 时 `path` 必填，且不能是空字符串。');
    }
    if (params.before !== undefined && params.before.trim() === "") {
      throw new Error("`before` 给出时不能是空路径。");
    }
    if (params.before !== undefined && samePath(params.before, params.path)) {
      throw new Error(
        "`before` 与 `path` 指向同一个文件：只想展示一个文件就省略 `before`，做前后对比请指向上一版本的副本。",
      );
    }
    return;
  }

  if (params.options.length === 0) {
    throw new Error('type 为 "comparison" 时 `options` 必填，且不能是空数组。');
  }
  params.options.forEach((option, index) => {
    if (!option.name || option.name.trim() === "") {
      throw new Error(`options[${index}].name 必填，且不能为空。`);
    }
  });
}

/** 需要校验的 mermaid 源：diagram 的正文，或 comparison 里每个选项的内联图。 */
export function mermaidSources(params: VisualizeParams): MermaidSource[] {
  if (params.type === "file") return [];
  if (params.type === "diagram") {
    return [{ location: "mermaid", source: params.mermaid ?? "" }];
  }
  return params.options.flatMap((option, index) =>
    option.mermaid ? [{ location: `options[${index}].mermaid`, source: option.mermaid }] : [],
  );
}

/** 需要校验的文件：`path` 与可选的 `before`。 */
export function fileSources(params: VisualizeParams): FileSource[] {
  if (params.type !== "file") return [];
  const sources: FileSource[] = [{ location: "path", path: params.path ?? "" }];
  if (params.before !== undefined) sources.push({ location: "before", path: params.before });
  return sources;
}

export function mermaidFence(title: string | undefined, mermaid: string): string {
  const body = `\`\`\`mermaid\n${mermaid.trim()}\n\`\`\``;
  return title ? `### ${title}\n\n${body}` : body;
}

export function comparisonMarkdown(title: string | undefined, options: ComparisonOption[]): string {
  const blocks: string[] = [];
  if (title) blocks.push(`## ${title}`);

  for (const option of options) {
    const parts: string[] = [`### ${option.name}${option.recommended ? " — ✅ 推荐" : ""}`];
    if (option.description) parts.push(option.description);
    if (option.pros.length > 0) {
      parts.push(["**优点:**", ...option.pros.map((pro) => `- ${pro}`)].join("\n"));
    }
    if (option.cons.length > 0) {
      parts.push(["**缺点:**", ...option.cons.map((con) => `- ${con}`)].join("\n"));
    }
    if (option.mermaid && option.mermaid.trim() !== "") {
      parts.push(mermaidFence(undefined, option.mermaid));
    }
    blocks.push(parts.join("\n\n"));
  }

  return blocks.join("\n\n");
}

export function fileMarkdown(params: VisualizeParams): string {
  const subject = params.before
    ? `\`${params.path ?? ""}\`（与 \`${params.before}\` 的前后对比）`
    : `\`${params.path ?? ""}\``;
  const body = `已展示 ${subject}。`;
  return params.title ? `### ${params.title}\n\n${body}` : body;
}

/** 模型侧结果：markdown，任何宿主都读得懂。 */
export function visualizeMarkdown(params: VisualizeParams): string {
  if (params.type === "diagram") return mermaidFence(params.title, params.mermaid ?? "");
  if (params.type === "file") return fileMarkdown(params);
  return comparisonMarkdown(params.title, params.options);
}
