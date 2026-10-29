import { stat } from "node:fs/promises";
import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";
import { probeMermaid } from "./mermaid-art.js";
import {
  fileSources,
  mermaidSources,
  parseVisualizeParams,
  validateVisualizeShape,
  visualizeMarkdown,
} from "./visualize-format.js";
import { resolveWorkspacePath } from "./workspace-path.js";

/**
 * `visualize`：让模型把「图」交给界面画，而不是自己拼 ASCII art 或 markdown 表格。
 *
 * 三态由 `type` 决定：`diagram` 画 mermaid 图，`comparison` 并排比较方案，
 * `file` 展示工作区文件（可带 `before` 做前后对比）。
 *
 * 工具只负责**校验 + 返回 markdown**：真正画图是展示层的事（cli 的工具块预览），
 * 因此这里的输出对无渲染器的宿主（`haji mcp-serve`、JSON 模式）同样可读。
 */
export class VisualizeTool implements BaseTool {
  public readonly name = "visualize";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "visualize",
      description:
        "在界面里画出可视化结果，代替 ASCII art 或纯 markdown 表格。按 `type` 三选一：" +
        "'diagram' 画 mermaid 图（`mermaid` 填任意图族的原始源码：flowchart、sequenceDiagram、" +
        "classDiagram、stateDiagram、erDiagram、pie 等，终端会渲染成字符画）；" +
        "'comparison' 并排比较几个方案（`options` 填备选方案，每项含 pros/cons、可选 recommended 与内联 mermaid）；" +
        "'file' 展示工作区里已存在的文件（`path`；再给 `before` 则显示前后对比）。" +
        "架构与流程、方案取舍、界面原型都优先用它，不要自己画 ASCII 图或拼表格。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["diagram", "comparison", "file"],
            description:
              "要画哪一种：'diagram' 需要 `mermaid`，'comparison' 需要 `options`，'file' 需要 `path`。",
          },
          title: { type: "string", description: "可选：画面上方的标题。" },
          mermaid: {
            type: "string",
            description:
              "type='diagram' 时必填。mermaid 原始源码（flowchart、sequenceDiagram、classDiagram、stateDiagram、erDiagram、pie、mindmap、timeline、gitGraph 等）。",
          },
          options: {
            type: "array",
            description: "type='comparison' 时必填。被比较的备选方案。",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "方案的短名字。" },
                description: { type: "string", description: "一两句话说明这个方案。" },
                pros: {
                  type: "array",
                  items: { type: "string" },
                  description: "这个方案的优点。",
                },
                cons: {
                  type: "array",
                  items: { type: "string" },
                  description: "这个方案的缺点。",
                },
                recommended: {
                  type: "boolean",
                  description: "只在你推荐的那一个方案上设为 true，它会被高亮。",
                },
                mermaid: {
                  type: "string",
                  description: "可选：用一张 mermaid 图说明这个方案。",
                },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
          path: {
            type: "string",
            description:
              "type='file' 时必填。工作区相对路径，指向已存在的文件（HTML、Markdown、SVG、CSV、JSON、图片、代码等）。",
          },
          before: {
            type: "string",
            description:
              "可选，配合 type='file'。上一版本文件的路径；给出后按前后对比展示（必须与 `path` 不同）。",
          },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
  };

  public getMutationScope(): "none" {
    return "none";
  }

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const params = parseVisualizeParams(args);
      validateVisualizeShape(params);

      for (const { location, source } of mermaidSources(params)) {
        if (source.trim() === "") {
          throw new Error(`\`${location}\` 的 mermaid 源码是空的。`);
        }
        try {
          probeMermaid(source);
        } catch (error) {
          throw new Error(
            `mermaid 语法有问题（\`${location}\`）：${error instanceof Error ? error.message : String(error)}\n修正语法后重新调用 visualize。`,
          );
        }
      }

      for (const { location, path } of fileSources(params)) {
        try {
          await this.checkFile(path);
        } catch (error) {
          throw new Error(
            `展示不了 \`${location}\`（${path}）：${error instanceof Error ? error.message : String(error)}\n先把文件写好，再调用 visualize。`,
          );
        }
      }

      if (context?.abortSignal?.aborted) return "错误: 已中止。";
      return visualizeMarkdown(params);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 文件得真的存在且是普通文件：让模型知道「先写文件、再展示」，而不是展示一个空路径。 */
  private async checkFile(path: string): Promise<void> {
    const absolute = await resolveWorkspacePath(path);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error("文件不存在");
    if (!info.isFile()) throw new Error("不是普通文件");
  }
}
